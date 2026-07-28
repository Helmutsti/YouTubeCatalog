//! Lo stato in memoria e la sua persistenza in `sources.json` + `library.json`.
//!
//! ## Una sola transazione, un solo lock
//!
//! Ogni mutazione passa da [`transaction`]: prende il **lock unico** dello stato,
//! ripara un eventuale commit interrotto, carica, applica il mutatore e committa i
//! due file **atomicamente** (vedi [`super::commit`]). Un solo lock e non uno per
//! file: con file che si toccano a vicenda, lock separati sarebbero un invito al
//! deadlock.
//!
//! ## Niente cache per processo
//!
//! L'implementazione JS teneva il catalogo in una variabile di modulo e non lo
//! rileggeva mai. È la causa del funzionamento controintuitivo numero uno del
//! progetto («se un altro processo modifica il catalogo, riavvia») ed è ciò che ha
//! azzerato 83 video il 2026-07-25. Qui si rilegge a ogni operazione, sotto lock:
//! il parsing costa millisecondi, sbagliare costa molto di più.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

use super::commit::{commit, recover, StagedFile};
use super::schema::{
    author_key_from, download_state, Author, Source, Video, STATE_VERSION,
};
use crate::config::{get_paths, Paths};
use crate::error::{OndoError, Result};
use crate::lock::FileLock;
use crate::time::now_iso8601;

/// Quanto può restare ferma una rivendicazione `downloading` prima di essere
/// considerata abbandonata da un processo morto. Generosa: chi scarica la rinnova a
/// ogni avanzamento, quindi mezz'ora senza un solo rinnovo significa davvero che quel
/// processo non c'è più. Il prezzo di sbagliare per eccesso è un video che resta «in
/// corso» per un po'; sbagliare per difetto significa due istanze sullo stesso file.
pub const STALE_DOWNLOAD_MINUTES: i64 = 30;

pub const SOURCES_FILE: &str = "sources.json";
pub const LIBRARY_FILE: &str = "library.json";
/// Il vecchio file monolitico. Letto solo dalla migrazione.
pub const LEGACY_FILE: &str = "catalog.json";

/// Lo stato completo, in memoria.
///
/// `BTreeMap` e non `HashMap`: l'ordine di serializzazione diventa deterministico,
/// quindi due esecuzioni identiche producono file identici e i diff restano
/// leggibili. Il costo di ordinamento su qualche migliaio di chiavi è irrilevante.
#[derive(Debug, Clone, Default)]
pub struct State {
    pub authors: BTreeMap<String, Author>,
    pub videos: BTreeMap<String, Video>,
    pub sources: BTreeMap<String, Source>,
    /// Campi non modellati dei due file, riportati tali e quali in scrittura.
    library_extra: Map<String, Value>,
    sources_extra: Map<String, Value>,
}

impl State {
    pub fn video(&self, id: &str) -> Result<&Video> {
        self.videos
            .get(id)
            .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))
    }

    pub fn video_mut(&mut self, id: &str) -> Result<&mut Video> {
        self.videos
            .get_mut(id)
            .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))
    }

    pub fn source(&self, id: &str) -> Result<&Source> {
        self.sources.get(id).ok_or_else(|| {
            OndoError::not_found(format!(
                "Fonte non trovata: \"{id}\" — aggiungila prima da \"Sorgenti\""
            ))
        })
    }

    /// Quanti video portano l'etichetta di questa sorgente.
    pub fn videos_of_source(&self, source_id: &str) -> Vec<&Video> {
        self.videos
            .values()
            .filter(|v| v.source_ids().contains(&source_id))
            .collect()
    }

    /// Assicura che l'autore esista e ne aggiorna i campi "attuali" dallo snapshot
    /// del video. È il punto unico in cui la tabella `authors` si popola: così un
    /// autore compare appena arriva il suo primo video, senza un passo separato.
    pub fn upsert_author_from_video(&mut self, video: &Video) -> Option<String> {
        let key = video.author_key()?;
        let name = video.channel_name().map(str::to_string);
        let url = video
            .0
            .get("channel")
            .and_then(|c| c.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let subs = video
            .0
            .get("channel")
            .and_then(|c| c.get("subscriberCountAtDownload"))
            .and_then(Value::as_u64);

        let entry = self.authors.entry(key.clone()).or_insert_with(|| {
            Author::new(&key, video.channel_id(), name.as_deref(), url.as_deref())
        });
        entry.refresh(name.as_deref(), url.as_deref(), subs);
        Some(key)
    }

    /// Rimuove gli autori che non hanno più alcun video. Un autore senza video non è
    /// un errore (può esistere di proposito), ma dopo una cancellazione totale
    /// lasciarlo in giro sporca l'elenco.
    pub fn prune_orphan_authors(&mut self) -> usize {
        let referenced: std::collections::HashSet<String> =
            self.videos.values().filter_map(|v| v.author_key()).collect();
        let before = self.authors.len();
        self.authors.retain(|k, _| referenced.contains(k));
        before - self.authors.len()
    }

    fn to_library_json(&self) -> Result<String> {
        let mut root = self.library_extra.clone();
        root.insert("version".into(), json!(STATE_VERSION));
        root.insert(
            "authors".into(),
            Value::Object(
                self.authors
                    .iter()
                    .map(|(k, a)| (k.clone(), Value::Object(a.0.clone())))
                    .collect(),
            ),
        );
        root.insert(
            "videos".into(),
            Value::Object(
                self.videos
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::Object(v.0.clone())))
                    .collect(),
            ),
        );
        root.insert("meta".into(), json!({ "lastUpdated": now_iso8601() }));
        Ok(serde_json::to_string_pretty(&Value::Object(root))?)
    }

    fn to_sources_json(&self) -> Result<String> {
        let mut root = self.sources_extra.clone();
        root.insert("version".into(), json!(STATE_VERSION));
        root.insert(
            "sources".into(),
            Value::Object(
                self.sources
                    .iter()
                    .map(|(k, s)| (k.clone(), Value::Object(s.0.clone())))
                    .collect(),
            ),
        );
        root.insert("meta".into(), json!({ "lastUpdated": now_iso8601() }));
        Ok(serde_json::to_string_pretty(&Value::Object(root))?)
    }
}

// ── Caricamento ─────────────────────────────────────────────────────────────

fn read_json(path: &Path) -> Result<Option<Map<String, Value>>> {
    if !path.is_file() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(&fs::read_to_string(path)?)? {
        Value::Object(m) => Ok(Some(m)),
        _ => Err(OndoError::new(
            crate::error::ErrorKind::Parse,
            format!("{} non contiene un oggetto JSON.", path.display()),
        )),
    }
}

fn take_map<T>(root: &mut Map<String, Value>, key: &str, wrap: impl Fn(Value) -> Option<T>) -> BTreeMap<String, T> {
    match root.remove(key) {
        Some(Value::Object(m)) => m
            .into_iter()
            .filter_map(|(k, v)| wrap(v).map(|t| (k, t)))
            .collect(),
        _ => BTreeMap::new(),
    }
}

fn load_from_disk(paths: &Paths) -> Result<State> {
    let mut state = State::default();

    if let Some(mut lib) = read_json(&paths.data_dir.join(LIBRARY_FILE))? {
        lib.remove("meta");
        lib.remove("version");
        state.authors = take_map(&mut lib, "authors", Author::from_value);
        state.videos = take_map(&mut lib, "videos", Video::from_value);
        state.library_extra = lib;
    }
    if let Some(mut src) = read_json(&paths.data_dir.join(SOURCES_FILE))? {
        src.remove("meta");
        src.remove("version");
        state.sources = take_map(&mut src, "sources", Source::from_value);
        state.sources_extra = src;
    }
    Ok(state)
}

/// Riconciliazione all'avvio, sullo stato appena caricato. Ritorna `true` se ha
/// cambiato qualcosa (e quindi va riscritto).
fn reconcile(state: &mut State) -> bool {
    let mut changed = false;
    let now = now_iso8601();

    // Soglia oltre la quale una rivendicazione `downloading` è considerata abbandonata.
    // Vedi la nota su `needs_reset` qui sotto.
    let cutoff = crate::time::minutes_ago_iso8601(STALE_DOWNLOAD_MINUTES);

    let ids: Vec<String> = state.videos.keys().cloned().collect();
    for id in ids {
        // Un download interrotto a metà va riportato a "none" e rifatto da zero.
        //
        // ⚠️ Ma `downloading` non significa più "processo morto": con più istanze in
        // parallelo può significare "un'altra istanza ci sta lavorando adesso".
        // Azzerarlo a ogni caricamento — come faceva la prima versione, ereditando
        // l'assunzione "un solo processo" del JavaScript — cancella la rivendicazione
        // di chi sta scaricando, e due istanze finiscono sullo stesso file di output.
        // (Trovato da una prova reale con due processi, non dai test unitari.)
        //
        // Si azzera quindi solo una rivendicazione **scaduta**: chi scarica rinnova la
        // sua (vedi `ops::download`), quindi una che non si rinnova da mezz'ora è di un
        // processo che non c'è più.
        let needs_reset = state
            .videos
            .get(&id)
            .map(|v| {
                v.download() == download_state::DOWNLOADING
                    && v.0
                        .get("downloadingSince")
                        .and_then(Value::as_str)
                        // Assente = scritta da una versione precedente: si azzera,
                        // com'era il comportamento di prima.
                        .is_none_or(|since| since < cutoff.as_str())
            })
            .unwrap_or(false);
        if needs_reset {
            if let Some(v) = state.videos.get_mut(&id) {
                v.set("download", json!(download_state::NONE));
                v.set("downloadingSince", Value::Null);
                v.set("updatedAt", json!(now.clone()));
            }
            changed = true;
        }

        // `authorKey` mancante (entry scritte prima della tabella authors).
        let missing_key = state
            .videos
            .get(&id)
            .map(|v| v.0.get("authorKey").map(Value::is_null).unwrap_or(true))
            .unwrap_or(false);
        if missing_key {
            let derived = state.videos.get(&id).and_then(|v| {
                author_key_from(v.channel_id(), v.channel_name())
            });
            if let Some(key) = derived {
                if let Some(v) = state.videos.get_mut(&id) {
                    v.set("authorKey", json!(key));
                }
                changed = true;
            }
        }

        // L'autore esiste nella tabella?
        let video = state.videos.get(&id).cloned();
        if let Some(video) = video {
            if let Some(key) = video.author_key() {
                if !state.authors.contains_key(&key) {
                    state.upsert_author_from_video(&video);
                    changed = true;
                }
            }
        }
    }

    // Etichette che puntano a sorgenti inesistenti: comparirebbero come etichette
    // senza nome. Il JS le lasciava in giro.
    let known: std::collections::HashSet<String> = state.sources.keys().cloned().collect();
    for video in state.videos.values_mut() {
        let Some(arr) = video.0.get_mut("sources").and_then(Value::as_array_mut) else { continue };
        let before = arr.len();
        arr.retain(|s| {
            s.get("sourceId")
                .and_then(Value::as_str)
                .map(|id| known.contains(id))
                .unwrap_or(false)
        });
        if arr.len() != before {
            changed = true;
        }
    }

    changed
}

fn state_lock(paths: &Paths) -> Result<FileLock> {
    // UN solo lock per tutto lo stato: sources, library e metadata.
    FileLock::acquire(paths.data_dir.join("state.lock"))
}

/// Legge lo stato, riparando un eventuale commit interrotto e applicando la
/// riconciliazione (riscritta solo se serve).
pub fn read() -> Result<State> {
    let paths = get_paths()?;
    let _guard = state_lock(&paths)?;
    recover(&paths.data_dir)?;
    let mut state = load_from_disk(&paths)?;
    if reconcile(&mut state) {
        write_state(&paths, &state)?;
    }
    Ok(state)
}

fn write_state(paths: &Paths, state: &State) -> Result<()> {
    commit(
        &paths.data_dir,
        &[
            StagedFile { name: LIBRARY_FILE.into(), content: state.to_library_json()? },
            StagedFile { name: SOURCES_FILE.into(), content: state.to_sources_json()? },
        ],
    )
}

/// Muta lo stato e lo persiste **atomicamente**. Se il mutatore restituisce `Err`,
/// niente viene scritto: lo stato su disco resta intatto.
pub fn transaction<T, F>(mutator: F) -> Result<T>
where
    F: FnOnce(&mut State) -> Result<T>,
{
    let paths = get_paths()?;
    let _guard = state_lock(&paths)?;
    recover(&paths.data_dir)?;
    let mut state = load_from_disk(&paths)?;
    reconcile(&mut state);
    let result = mutator(&mut state)?;
    write_state(&paths, &state)?;
    Ok(result)
}

// ── Migrazione dal vecchio catalog.json ─────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct MigrationReport {
    pub videos: usize,
    pub authors: usize,
    pub sources: usize,
    pub avatars: usize,
    pub backup: Option<std::path::PathBuf>,
}

/// C'è un `catalog.json` v1 da migrare (e nessun `library.json` già presente)?
pub fn migration_pending() -> Result<bool> {
    let paths = get_paths()?;
    Ok(paths.data_dir.join(LEGACY_FILE).is_file() && !paths.data_dir.join(LIBRARY_FILE).is_file())
}

/// Migra `catalog.json` → `library.json` + `sources.json`, popolando la tabella
/// `authors` dagli snapshot dei video e dalla vecchia mappa `channelAvatars`.
///
/// Non cancella il file vecchio: lo **rinomina** in `catalog.json.pre-v2`, così un
/// eventuale problema è sempre recuperabile. Applica anche le due migrazioni
/// storiche (`status` singolo → flag ortogonali, `source` singola → `sources[]`),
/// perché un catalogo molto vecchio può non averle ancora subite.
pub fn migrate_from_legacy() -> Result<MigrationReport> {
    let paths = get_paths()?;
    let _guard = state_lock(&paths)?;
    recover(&paths.data_dir)?;

    let legacy_path = paths.data_dir.join(LEGACY_FILE);
    let Some(mut legacy) = read_json(&legacy_path)? else {
        return Err(OndoError::not_found(format!(
            "Nessun {LEGACY_FILE} da migrare in {}",
            paths.data_dir.display()
        )));
    };

    let mut report = MigrationReport::default();
    let mut state = State::default();

    // Sorgenti.
    state.sources = take_map(&mut legacy, "sources", Source::from_value);
    report.sources = state.sources.len();

    // Video, con le migrazioni storiche applicate una per una.
    let raw_videos = take_map(&mut legacy, "videos", Video::from_value);
    let sources_snapshot: Value = Value::Object(
        state
            .sources
            .iter()
            .map(|(k, s)| (k.clone(), Value::Object(s.0.clone())))
            .collect(),
    );

    for (id, mut video) in raw_videos {
        migrate_legacy_status(&mut video);
        migrate_legacy_source(&mut video, &sources_snapshot);
        if let Some(key) = author_key_from(video.channel_id(), video.channel_name()) {
            video.set("authorKey", json!(key));
        }
        state.videos.insert(id, video);
    }
    report.videos = state.videos.len();

    // Autori dagli snapshot.
    let videos: Vec<Video> = state.videos.values().cloned().collect();
    for video in &videos {
        state.upsert_author_from_video(video);
    }
    report.authors = state.authors.len();

    // Vecchia mappa channelAvatars → avatar dell'autore.
    if let Some(Value::Object(avatars)) = legacy.remove("channelAvatars") {
        for (key, entry) in avatars {
            let source_url = entry.get("sourceUrl").and_then(Value::as_str);
            let local_path = entry
                .get("localPath")
                .and_then(Value::as_str)
                .or_else(|| entry.get("path").and_then(Value::as_str));
            if let Some(author) = state.authors.get_mut(&key) {
                author.set_avatar(source_url, local_path);
                report.avatars += 1;
            }
        }
    }

    write_state(&paths, &state)?;

    // Il vecchio file si conserva, non si cancella.
    let backup = paths.data_dir.join(format!("{LEGACY_FILE}.pre-v2"));
    fs::rename(&legacy_path, &backup)?;
    report.backup = Some(backup);

    Ok(report)
}

/// Vecchio modello a `status` singolo → flag ortogonali. Idempotente.
fn migrate_legacy_status(video: &mut Video) {
    if !video.0.contains_key("status") && video.0.contains_key("download") {
        return;
    }
    let legacy = video.0.get("status").and_then(Value::as_str).unwrap_or("");
    // `downloading` interrotto → `none`: un download a metà va rifatto da zero.
    let (p, d, h) = match legacy {
        "downloaded" => ("present", download_state::DOWNLOADED, false),
        "excluded" => ("present", download_state::NONE, true),
        "failed" => ("present", download_state::FAILED, false),
        _ => ("present", download_state::NONE, false),
    };
    for (k, v) in [("presence", json!(p)), ("download", json!(d)), ("hidden", json!(h))] {
        if matches!(video.0.get(k), None | Some(Value::Null)) {
            video.0.insert(k.into(), v);
        }
    }
    if matches!(video.0.get("removedAt"), None) {
        video.0.insert("removedAt".into(), Value::Null);
    }
    video.0.remove("status");
    video.0.remove("decidedAt"); // legato al vecchio ciclo new/pending/excluded
}

/// Vecchia `source` singola → `sources` come array di etichette. Idempotente.
fn migrate_legacy_source(video: &mut Video, sources: &Value) {
    if video.0.contains_key("sources") {
        return;
    }
    let legacy_id = video
        .0
        .get("source")
        .and_then(|s| s.get("sourceId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let value = match legacy_id {
        Some(sid) => {
            let name = sources
                .get(&sid)
                .and_then(|s| s.get("name"))
                .cloned()
                .unwrap_or(Value::Null);
            json!([{ "sourceId": sid, "name": name }])
        }
        None => json!([]),
    };
    video.0.insert("sources".into(), value);
    video.0.remove("source");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::schema::{new_video, NewVideo};

    fn video_with(id: &str, channel_id: Option<&str>, channel_name: Option<&str>) -> Video {
        new_video(NewVideo {
            id, title: Some("T"), channel_name, channel_id,
            duration_seconds: None, playlist_index: None, playlist_id: None,
            playlist_title: None, source_id: None, webpage_url: None,
            original_url: None, extractor: None,
        })
    }

    #[test]
    fn authors_are_created_from_the_video_snapshot() {
        let mut state = State::default();
        let v = video_with("a", Some("UC1"), Some("Creator"));
        let key = state.upsert_author_from_video(&v).unwrap();
        assert_eq!(key, "UC1");
        assert_eq!(state.authors["UC1"].name(), Some("Creator"));

        // Un secondo video dello stesso autore non ne crea un altro.
        let v2 = video_with("b", Some("UC1"), Some("Creator"));
        state.upsert_author_from_video(&v2);
        assert_eq!(state.authors.len(), 1);
    }

    #[test]
    fn a_renamed_channel_updates_the_author_but_not_the_old_snapshot() {
        let mut state = State::default();
        let old = video_with("a", Some("UC1"), Some("Nome Vecchio"));
        state.upsert_author_from_video(&old);
        state.videos.insert("a".into(), old);

        let new = video_with("b", Some("UC1"), Some("Nome Nuovo"));
        state.upsert_author_from_video(&new);

        assert_eq!(state.authors["UC1"].name(), Some("Nome Nuovo"), "la tabella dice com'è adesso");
        assert_eq!(
            state.videos["a"].channel_name(),
            Some("Nome Vecchio"),
            "lo snapshot dice com'era: è ciò che il progetto preserva"
        );
    }

    #[test]
    fn orphan_authors_are_pruned() {
        let mut state = State::default();
        let v = video_with("a", Some("UC1"), Some("Creator"));
        state.upsert_author_from_video(&v);
        state.videos.insert("a".into(), v);
        assert_eq!(state.prune_orphan_authors(), 0);

        state.videos.clear();
        assert_eq!(state.prune_orphan_authors(), 1);
        assert!(state.authors.is_empty());
    }

    #[test]
    fn legacy_status_becomes_orthogonal_flags() {
        let mut v = Video::from_value(json!({
            "id": "a", "status": "excluded", "decidedAt": "2026-01-01"
        }))
        .unwrap();
        migrate_legacy_status(&mut v);
        assert_eq!(v.presence(), "present");
        assert_eq!(v.download(), download_state::NONE);
        assert!(v.hidden());
        assert!(!v.0.contains_key("status"));
        assert!(!v.0.contains_key("decidedAt"));

        let mut v = Video::from_value(json!({ "id": "b", "status": "downloading" })).unwrap();
        migrate_legacy_status(&mut v);
        assert_eq!(v.download(), download_state::NONE, "un download a metà va rifatto");
    }

    #[test]
    fn legacy_single_source_becomes_an_array_of_labels() {
        let sources = json!({ "PL1": { "name": "La mia playlist" } });
        let mut v = Video::from_value(json!({
            "id": "a", "source": { "sourceId": "PL1", "type": "playlist" }
        }))
        .unwrap();
        migrate_legacy_source(&mut v, &sources);
        assert_eq!(
            v.0["sources"],
            json!([{ "sourceId": "PL1", "name": "La mia playlist" }])
        );
        assert!(!v.0.contains_key("source"));

        let mut v = Video::from_value(json!({ "id": "b" })).unwrap();
        migrate_legacy_source(&mut v, &sources);
        assert_eq!(v.0["sources"], json!([]), "nessuna fonte = array vuoto, stato normale");
    }

    #[test]
    fn reconcile_resets_interrupted_downloads_and_fills_missing_author_keys() {
        let mut state = State::default();
        let mut v = video_with("a", Some("UC1"), Some("Creator"));
        v.set("download", json!(download_state::DOWNLOADING));
        v.0.remove("authorKey");
        state.videos.insert("a".into(), v);

        assert!(reconcile(&mut state));
        assert_eq!(state.videos["a"].download(), download_state::NONE);
        assert_eq!(state.videos["a"].0["authorKey"], "UC1");
        assert!(state.authors.contains_key("UC1"), "l'autore mancante viene creato");

        assert!(!reconcile(&mut state), "idempotente");
    }

    #[test]
    fn reconcile_drops_labels_pointing_at_removed_sources() {
        let mut state = State::default();
        let mut v = video_with("a", Some("UC1"), Some("C"));
        v.set("sources", json!([{ "sourceId": "PL_scomparsa", "name": "X" }]));
        state.videos.insert("a".into(), v);
        assert!(reconcile(&mut state));
        assert_eq!(state.videos["a"].0["sources"], json!([]));
    }
}
