//! Modello di stato a flag ORTOGONALI — porting di `core/src/catalog/catalogSchema.js`.
//!
//! L'unico `status` lineare di prima (new/pending/downloading/downloaded/failed/
//! excluded) non sapeva esprimere stati che coesistono: un video può essere
//! insieme "presente su YouTube" e "scaricato"; "nascosto" è indipendente
//! dall'essere scaricato. Ogni dimensione vive quindi su un asse separato, e i
//! flag utente-visibili sono tutti DERIVATI (vedi `video_category`).
//!
//! ## Perché `Video` avvolge una mappa JSON invece di essere una struct tipizzata
//!
//! Scelta deliberata, non pigrizia. La Regola 2 della migrazione
//! (`docs/rust-core.md` §7) impone che **il formato su disco non cambi** finché
//! JS e Rust coesistono. Una struct tipizzata:
//!   - scarterebbe silenziosamente i campi che non ha modellato (il catalogo
//!     reale ha decine di campi, e `metadata.json` conserva il grezzo di yt-dlp);
//!   - riordinerebbe le chiavi in fase di scrittura (prima i campi dichiarati,
//!     poi il resto), rendendo illeggibile qualunque diff con l'output JS.
//!
//! Avvolgendo una `serde_json::Map` (compilata con `preserve_order`) la fedeltà
//! è garantita: si legge, si tocca solo ciò che serve, si riscrive uguale.
//! Quando Rust sarà l'unico proprietario del formato (M73) si potrà valutare il
//! passaggio a struct tipizzate — ma è una decisione da prendere allora, non ora.

use serde_json::{Map, Value};

use crate::time::now_iso8601;

// ── Assi ortogonali ─────────────────────────────────────────────────────────

pub mod presence {
    pub const PRESENT: &str = "present";
    pub const REMOVED: &str = "removed";
}

pub mod download_state {
    pub const NONE: &str = "none";
    pub const DOWNLOADING: &str = "downloading";
    pub const DOWNLOADED: &str = "downloaded";
    pub const FAILED: &str = "failed";
}

/// Categoria derivata a UNA dimensione, per viste/badge/ordinamenti che mostrano
/// un solo indicatore. È l'unico punto in cui gli assi ortogonali vengono
/// collassati in una singola etichetta — così CLI e web non reimplementano la
/// regola. Priorità: "rimosso" e gli stati di download attivi/falliti sono più
/// salienti; "nascosto" prima di "scaricato", così un video archiviato resta
/// archiviato anche se ha un file su disco.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCategory {
    Removed,
    Downloading,
    Failed,
    Hidden,
    Downloaded,
    Available,
}

impl VideoCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoCategory::Removed => "removed",
            VideoCategory::Downloading => "downloading",
            VideoCategory::Failed => "failed",
            VideoCategory::Hidden => "hidden",
            VideoCategory::Downloaded => "downloaded",
            VideoCategory::Available => "available",
        }
    }

    /// Etichetta breve per il CLI, con icona. Equivalente alle icone di stato
    /// usate nei menu JS.
    pub fn label(self) -> &'static str {
        match self {
            VideoCategory::Removed => "✖ rimosso",
            VideoCategory::Downloading => "⬇ in corso",
            VideoCategory::Failed => "⚠ fallito",
            VideoCategory::Hidden => "◌ nascosto",
            VideoCategory::Downloaded => "✔ scaricato",
            VideoCategory::Available => "· disponibile",
        }
    }
}

// ── Il video ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Video(pub Map<String, Value>);

impl Video {
    pub fn from_value(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Video(map)),
            _ => None,
        }
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    // -- accessori di sola lettura --

    fn str_at(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn id(&self) -> &str {
        self.str_at("id").unwrap_or("")
    }

    pub fn title(&self) -> Option<&str> {
        self.str_at("title")
    }

    pub fn presence(&self) -> &str {
        self.str_at("presence").unwrap_or(presence::PRESENT)
    }

    pub fn download(&self) -> &str {
        self.str_at("download").unwrap_or(download_state::NONE)
    }

    pub fn hidden(&self) -> bool {
        self.0.get("hidden").and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn favorite(&self) -> bool {
        self.0.get("favorite").and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn added_at(&self) -> &str {
        self.str_at("addedAt").unwrap_or("")
    }

    pub fn duration_seconds(&self) -> Option<f64> {
        self.0.get("durationSeconds").and_then(Value::as_f64)
    }

    pub fn webpage_url(&self) -> Option<&str> {
        self.str_at("webpageUrl")
    }

    pub fn channel_name(&self) -> Option<&str> {
        self.0.get("channel")?.get("name")?.as_str()
    }

    pub fn channel_id(&self) -> Option<&str> {
        self.0.get("channel")?.get("id")?.as_str()
    }

    /// Chiave del canale: id se presente, altrimenti il nome. Porting di
    /// `channelKey()` — l'id manca sui video non ancora arricchiti (M26).
    pub fn channel_key(&self) -> Option<&str> {
        self.channel_id().or_else(|| self.channel_name())
    }

    pub fn local_path(&self) -> Option<&str> {
        self.0.get("video")?.get("localPath")?.as_str()
    }

    pub fn tags(&self) -> Vec<&str> {
        self.0
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }

    pub fn description(&self) -> Option<&str> {
        self.str_at("description")
    }

    pub fn is_downloaded(&self) -> bool {
        self.download() == download_state::DOWNLOADED
    }

    pub fn category(&self) -> VideoCategory {
        video_category(self)
    }

    /// Titolo da mostrare: quello vero se c'è, altrimenti derivato dal nome file
    /// già scelto da yt-dlp (`<Titolo> [<id>].<ext>`), altrimenti l'id nudo.
    /// Stessa regola di `displayTitle()` nel CLI JS.
    pub fn display_title(&self) -> String {
        if let Some(t) = self.title() {
            if !t.is_empty() {
                return t.to_string();
            }
        }
        if let Some(local) = self.local_path() {
            let base = local.rsplit(['/', '\\']).next().unwrap_or(local);
            let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
            let suffix = format!(" [{}]", self.id());
            let derived = stem.strip_suffix(&suffix).unwrap_or(stem).trim();
            if !derived.is_empty() {
                return derived.to_string();
            }
        }
        self.id().to_string()
    }

    // -- mutazioni --
    // Scrivono sulla chiave esistente quando c'è (la posizione nella mappa resta
    // quella originale, quindi l'ordine del JSON non cambia) e in coda altrimenti.

    pub fn set_hidden(&mut self, value: bool) {
        self.0.insert("hidden".into(), Value::Bool(value));
        self.touch();
    }

    pub fn set_favorite(&mut self, value: bool) {
        self.0.insert("favorite".into(), Value::Bool(value));
        self.touch();
    }

    pub fn set_download(&mut self, value: &str) {
        self.0.insert("download".into(), Value::String(value.into()));
        self.touch();
    }

    pub fn touch(&mut self) {
        self.0.insert("updatedAt".into(), Value::String(now_iso8601()));
    }
}

pub fn video_category(video: &Video) -> VideoCategory {
    if video.presence() == presence::REMOVED {
        return VideoCategory::Removed;
    }
    if video.download() == download_state::DOWNLOADING {
        return VideoCategory::Downloading;
    }
    if video.download() == download_state::FAILED {
        return VideoCategory::Failed;
    }
    if video.hidden() {
        return VideoCategory::Hidden;
    }
    if video.download() == download_state::DOWNLOADED {
        return VideoCategory::Downloaded;
    }
    VideoCategory::Available
}

// ── Costruttori ─────────────────────────────────────────────────────────────

pub fn create_empty_catalog() -> Value {
    serde_json::json!({
        "version": 1,
        "videos": {},
        "sources": {},
        "channelAvatars": {},
        "meta": { "lastUpdated": now_iso8601() }
    })
}

pub struct NewVideoStub<'a> {
    pub id: &'a str,
    pub title: Option<&'a str>,
    pub channel_name: Option<&'a str>,
    pub duration_seconds: Option<f64>,
    pub playlist_index: Option<u64>,
    pub playlist_id: Option<&'a str>,
    pub playlist_title: Option<&'a str>,
    pub source_id: Option<&'a str>,
    /// Le fonti/playlist sono YouTube-only (v1), da cui i default. Il download
    /// singolo one-off (qualunque sito supportato da yt-dlp, es. Rumble) passa
    /// questi tre esplicitamente, risolti da yt-dlp stesso.
    pub webpage_url: Option<&'a str>,
    pub original_url: Option<&'a str>,
    pub extractor: Option<&'a str>,
}

/// Porting di `createNewVideoStub()`. L'ordine delle chiavi replica quello
/// dell'implementazione JS: un video creato da Rust è indistinguibile da uno
/// creato da Node anche a livello di file.
pub fn create_new_video_stub(args: NewVideoStub<'_>) -> Video {
    let now = now_iso8601();
    let value = serde_json::json!({
        "id": args.id,
        "title": args.title,
        "description": Value::Null,
        "webpageUrl": args.webpage_url
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", args.id)),
        "originalUrl": args.original_url,
        "extractor": args.extractor.unwrap_or("youtube"),
        "channel": {
            "id": Value::Null,
            "name": args.channel_name,
            "url": Value::Null,
            "uploaderId": Value::Null,
            "uploaderUrl": Value::Null,
            "subscriberCountAtDownload": Value::Null
        },
        "uploadDate": Value::Null,
        "releaseTimestamp": Value::Null,
        "durationSeconds": args.duration_seconds,
        "categories": [],
        "tags": [],
        "language": Value::Null,
        "ageLimit": Value::Null,
        "availability": Value::Null,
        "license": Value::Null,
        "isLive": false,
        "wasLive": false,
        "statsAtDownload": {
            "viewCount": Value::Null, "likeCount": Value::Null,
            "commentCount": Value::Null, "averageRating": Value::Null
        },
        "resolution": {
            "width": Value::Null, "height": Value::Null,
            "fps": Value::Null, "dynamicRange": Value::Null
        },
        "thumbnails": [],
        "thumbnail": { "sourceUrl": Value::Null, "localPath": Value::Null },
        "chapters": [],
        "subtitleLanguagesAvailable": [],
        "playlistContext": {
            "playlistId": args.playlist_id,
            "playlistTitle": args.playlist_title,
            "playlistIndex": args.playlist_index
        },
        "video": {
            "localPath": Value::Null, "formatId": Value::Null, "container": Value::Null,
            "videoCodec": Value::Null, "audioCodec": Value::Null, "bitrateKbps": Value::Null,
            "sizeBytes": Value::Null, "sha256": Value::Null, "downloadedAt": Value::Null,
            "ytdlpVersion": Value::Null
        },
        "presence": presence::PRESENT,
        "removedAt": Value::Null,
        // Sync consecutive in cui il video non è stato trovato (M31): si marca
        // 'removed' solo dopo alcune assenze di fila, per evitare falsi positivi
        // da glitch temporanei di YouTube. Azzerato appena ricompare.
        "missCount": 0,
        "download": download_state::NONE,
        "hidden": false,
        // Preferito (M43): asse ortogonale indipendente, come `hidden`. Resta
        // fuori da video_category(), che mostra un solo indicatore.
        "favorite": false,
        // Metadati completi + copertina già arricchiti (M26)? null finché il job
        // enrichSource non li estrae.
        "enrichedAt": Value::Null,
        // Le fonti sono ETICHETTE portate dal video, non un vincolo di
        // appartenenza: un video esiste a sé e può portare zero, una o più fonti.
        // Array vuoto = stato normale e completo, non un "orfano".
        "sources": match args.source_id {
            Some(sid) => serde_json::json!([{ "sourceId": sid, "name": args.playlist_title }]),
            None => serde_json::json!([]),
        },
        "addedAt": now,
        "updatedAt": now,
        "attempts": 0,
        "error": Value::Null
    });
    Video::from_value(value).expect("json! costruisce sempre un oggetto")
}

// ── Migrazioni una tantum ───────────────────────────────────────────────────

/// Migrazione (M25) dal vecchio modello a `status` singolo verso i flag
/// ortogonali. Idempotente. Ritorna `true` se ha modificato il video.
pub fn migrate_video_to_flags(video: &mut Video) -> bool {
    if !video.0.contains_key("status") && video.0.contains_key("download") {
        return false; // già migrato
    }

    let legacy = video.0.get("status").and_then(Value::as_str).unwrap_or("");
    // downloading interrotto → riportato a "none": un download a metà va rifatto
    // da zero (equivalente alla vecchia reconciliation downloading→pending).
    let (mapped_presence, mapped_download, mapped_hidden) = match legacy {
        "downloaded" => (presence::PRESENT, download_state::DOWNLOADED, false),
        "new" => (presence::PRESENT, download_state::NONE, false),
        "pending" => (presence::PRESENT, download_state::NONE, false),
        "excluded" => (presence::PRESENT, download_state::NONE, true),
        "failed" => (presence::PRESENT, download_state::FAILED, false),
        "downloading" => (presence::PRESENT, download_state::NONE, false),
        _ => (presence::PRESENT, download_state::NONE, false),
    };

    // `??=` del JS: si scrive solo se la chiave manca o è null.
    fill_if_absent(&mut video.0, "presence", Value::String(mapped_presence.into()));
    fill_if_absent(&mut video.0, "removedAt", Value::Null);
    fill_if_absent(&mut video.0, "download", Value::String(mapped_download.into()));
    fill_if_absent(&mut video.0, "hidden", Value::Bool(mapped_hidden));

    video.0.remove("status");
    video.0.remove("decidedAt"); // legato al vecchio ciclo new/pending/excluded
    true
}

/// Migrazione (M41) dal vecchio `source` singolo alle `sources` come array di
/// etichette. `catalog_sources` serve a risolvere il `name` dal vecchio
/// `sourceId`. Idempotente.
pub fn migrate_video_to_sources(video: &mut Video, catalog_sources: Option<&Value>) -> bool {
    if video.0.contains_key("sources") {
        return false; // già migrato
    }

    let legacy_id = video
        .0
        .get("source")
        .and_then(|s| s.get("sourceId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let sources = match legacy_id {
        Some(sid) => {
            let name = catalog_sources
                .and_then(|s| s.get(&sid))
                .and_then(|s| s.get("name"))
                .cloned()
                .unwrap_or(Value::Null);
            serde_json::json!([{ "sourceId": sid, "name": name }])
        }
        None => serde_json::json!([]),
    };

    video.0.insert("sources".into(), sources);
    video.0.remove("source");
    true
}

fn fill_if_absent(map: &mut Map<String, Value>, key: &str, value: Value) {
    match map.get(key) {
        Some(Value::Null) | None => {
            map.insert(key.into(), value);
        }
        Some(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(json: Value) -> Video {
        Video::from_value(json).unwrap()
    }

    #[test]
    fn category_priority_matches_js() {
        // Un rimosso resta "rimosso" anche se scaricato.
        let v = video(serde_json::json!({"presence":"removed","download":"downloaded","hidden":false}));
        assert_eq!(v.category(), VideoCategory::Removed);

        // "nascosto" ha priorità su "scaricato": un archiviato resta archiviato
        // anche se ha un file su disco.
        let v = video(serde_json::json!({"presence":"present","download":"downloaded","hidden":true}));
        assert_eq!(v.category(), VideoCategory::Hidden);

        let v = video(serde_json::json!({"presence":"present","download":"downloading","hidden":true}));
        assert_eq!(v.category(), VideoCategory::Downloading);

        let v = video(serde_json::json!({"presence":"present","download":"failed","hidden":false}));
        assert_eq!(v.category(), VideoCategory::Failed);

        let v = video(serde_json::json!({"presence":"present","download":"downloaded","hidden":false}));
        assert_eq!(v.category(), VideoCategory::Downloaded);

        let v = video(serde_json::json!({"presence":"present","download":"none","hidden":false}));
        assert_eq!(v.category(), VideoCategory::Available);
    }

    #[test]
    fn migration_from_legacy_status() {
        let mut v = video(serde_json::json!({"id":"a","status":"excluded","decidedAt":"2026-01-01"}));
        assert!(migrate_video_to_flags(&mut v));
        assert_eq!(v.presence(), presence::PRESENT);
        assert_eq!(v.download(), download_state::NONE);
        assert!(v.hidden());
        assert!(!v.0.contains_key("status"));
        assert!(!v.0.contains_key("decidedAt"));

        // Idempotente: una seconda passata non cambia nulla.
        assert!(!migrate_video_to_flags(&mut v));
    }

    #[test]
    fn migration_downloading_is_reset_to_none() {
        let mut v = video(serde_json::json!({"id":"a","status":"downloading"}));
        migrate_video_to_flags(&mut v);
        assert_eq!(v.download(), download_state::NONE);
    }

    #[test]
    fn migration_to_sources_array() {
        let sources = serde_json::json!({ "PL1": { "name": "La mia playlist" } });
        let mut v = video(serde_json::json!({"id":"a","source":{"sourceId":"PL1","type":"playlist"}}));
        assert!(migrate_video_to_sources(&mut v, Some(&sources)));
        assert_eq!(
            v.0.get("sources").unwrap(),
            &serde_json::json!([{ "sourceId": "PL1", "name": "La mia playlist" }])
        );
        assert!(!v.0.contains_key("source"));

        // Nessuna fonte → array vuoto, che è lo stato normale, non un orfano.
        let mut v = video(serde_json::json!({"id":"b"}));
        migrate_video_to_sources(&mut v, Some(&sources));
        assert_eq!(v.0.get("sources").unwrap(), &serde_json::json!([]));
    }

    #[test]
    fn display_title_falls_back_to_filename_then_id() {
        let v = video(serde_json::json!({"id":"abc","title":"Vero titolo"}));
        assert_eq!(v.display_title(), "Vero titolo");

        let v = video(serde_json::json!({
            "id":"abc", "title": Value::Null,
            "video": { "localPath": "Creator/Un titolo dedotto [abc].mp4" }
        }));
        assert_eq!(v.display_title(), "Un titolo dedotto");

        let v = video(serde_json::json!({"id":"abc"}));
        assert_eq!(v.display_title(), "abc");
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        // La garanzia che giustifica la scelta della mappa al posto della struct.
        let original = serde_json::json!({
            "id": "abc", "presence": "present", "download": "none",
            "campoSconosciutoDelFuturo": { "annidato": [1, 2, 3] }
        });
        let mut v = video(original.clone());
        v.set_favorite(true);
        let out = v.into_value();
        assert_eq!(out.get("campoSconosciutoDelFuturo"), original.get("campoSconosciutoDelFuturo"));
        // E l'ordine delle chiavi originali è preservato.
        let keys: Vec<_> = out.as_object().unwrap().keys().take(3).collect();
        assert_eq!(keys, vec!["id", "presence", "download"]);
    }
}
