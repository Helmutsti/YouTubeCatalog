//! Sincronizzazione delle sorgenti.
//!
//! ## Qui il porting CORREGGE due bug noti invece di riportarli
//!
//! `PIANO.md` → "Bug noti" #1: *l'auto-guarigione `downloaded → none` distrugge lo
//! stato quando il disco dei video è offline, e non ha l'inverso*. La versione JS
//! declassa un video appena il file non è su disco, trattando **"disco non montato"
//! come "file cancellato"**: una sync partita con `videosRoot` (un NAS, un disco
//! esterno) irraggiungibile azzera un'intera sorgente. E l'operazione è a senso
//! unico: rimettere il disco non recupera nulla. È accaduto per davvero — 83 video,
//! `storico.md` del 2026-07-25, riparati a mano.
//!
//! Entrambe le difese proposte nel backlog sono implementate:
//!
//! **(a) Guardia sulla cartella.** Se la cartella dei video è assente o vuota, la
//! sync **salta** l'auto-guarigione. "Disco scollegato" non è distinguibile da
//! "l'utente ha cancellato tutto a mano", ma il primo caso è molto più probabile e il
//! secondo è recuperabile con una sync in più; l'errore opposto distrugge lo stato.
//!
//! **(b) Riconciliazione inversa.** Un video `none` con un `localPath` registrato il
//! cui file **ricompare** torna `downloaded` da sé.

use std::collections::HashSet;
use std::path::Path;

use serde_json::json;

use crate::config::{get_paths, Paths};
use crate::error::Result;
use crate::library::files::remove_from_download_archive;
use crate::library::schema::{download_state, new_video, presence, NewVideo};
use crate::library::state::{transaction, State};
use crate::downloader::{get_playlist_entries, PlaylistEntry};
use crate::ops::runs;
use crate::time::now_iso8601;

/// Assenze consecutive prima di marcare un video "rimosso": un paio di tentativi di
/// grazia, per non etichettare a causa di un glitch temporaneo di YouTube (una
/// playlist che "perde" un video per una sola sync).
const REMOVED_MISS_THRESHOLD: u64 = 2;

pub fn extract_playlist_id(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query
        .split('&')
        .filter_map(|p| p.split_once('='))
        .find(|(k, _)| *k == "list")
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    pub new_count: usize,
    pub healed_count: usize,
    pub removed_count: usize,
    pub restored_count: usize,
    pub reclaimed_count: usize,
    /// La guardia (a) è scattata: probabilmente il disco dei video è scollegato.
    /// Va **detto** all'utente, non nascosto.
    pub healing_skipped: bool,
    pub declared_count: Option<u64>,
    pub enumerated_count: usize,
    pub errors: Vec<String>,
}

impl SyncReport {
    /// Se il totale dichiarato da YouTube differisce dagli entry enumerati, qualche
    /// video non era visibile in questa estrazione (privato/rimosso/glitch). Non è
    /// infallibile — a volte i privati compaiono come segnaposto — quindi va
    /// presentato come indizio.
    pub fn missing_count(&self) -> u64 {
        self.declared_count
            .map(|d| d.saturating_sub(self.enumerated_count as u64))
            .unwrap_or(0)
    }

    fn merge(&mut self, other: SyncReport) {
        self.new_count += other.new_count;
        self.healed_count += other.healed_count;
        self.removed_count += other.removed_count;
        self.restored_count += other.restored_count;
        self.reclaimed_count += other.reclaimed_count;
        self.healing_skipped |= other.healing_skipped;
        self.enumerated_count += other.enumerated_count;
        self.errors.extend(other.errors);
    }
}

/// La cartella dei video è raggiungibile e non vuota? Se no, ogni controllo di
/// esistenza su un file al suo interno fallirebbe **per il motivo sbagliato**.
fn videos_dir_looks_mounted(videos_dir: &Path) -> bool {
    std::fs::read_dir(videos_dir)
        .map(|mut e| e.next().is_some())
        .unwrap_or(false)
}

/// Applica gli entry di una playlist allo stato. Usata sia dalla sync sia dal primo
/// ingest di una nuova sorgente, per non duplicare la logica.
pub fn ingest(
    state: &mut State,
    source_id: &str,
    source_name: Option<&str>,
    entries: &[PlaylistEntry],
    paths: &Paths,
) -> SyncReport {
    let mut report = SyncReport { enumerated_count: entries.len(), ..Default::default() };
    let mounted = videos_dir_looks_mounted(&paths.videos_dir);
    report.healing_skipped = !mounted;

    let found: HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    let now = now_iso8601();

    for entry in entries {
        if !state.videos.contains_key(&entry.id) {
            let video = new_video(NewVideo {
                id: &entry.id,
                title: entry.title.as_deref(),
                channel_name: entry.channel_name.as_deref(),
                channel_id: None, // l'enumerazione flat non lo espone; arriva con l'arricchimento
                duration_seconds: entry.duration_seconds,
                playlist_index: Some(entry.playlist_index),
                playlist_id: Some(source_id),
                playlist_title: source_name,
                source_id: Some(source_id),
                webpage_url: None,
                original_url: None,
                extractor: None,
            });
            state.upsert_author_from_video(&video);
            state.videos.insert(entry.id.clone(), video);
            report.new_count += 1;
            continue;
        }

        let Some(video) = state.videos.get_mut(&entry.id) else { continue };

        // Ritrovato: azzera le assenze e, se era marcato "rimosso", ripristina la
        // presenza — la detection è reversibile per scelta.
        video.set("missCount", json!(0));
        if video.presence() == presence::REMOVED {
            video.set("presence", json!(presence::PRESENT));
            video.set("removedAt", serde_json::Value::Null);
            video.set("updatedAt", json!(now.clone()));
            report.restored_count += 1;
        }

        // Riuso in questa sorgente: un video già a catalogo (da un'altra sorgente o
        // da un download singolo) trovato anche qui **porta anche questa etichetta**,
        // invece di essere ignorato dal dedup senza lasciare traccia del collegamento.
        if !video.source_ids().contains(&source_id) {
            let label = json!({ "sourceId": source_id, "name": source_name });
            match video.0.get_mut("sources").and_then(serde_json::Value::as_array_mut) {
                Some(arr) => arr.push(label),
                None => video.set("sources", json!([label])),
            }
            video.set("updatedAt", json!(now.clone()));
        }

        // Auto-guarigione — solo se il disco è davvero raggiungibile (difesa (a)).
        if mounted && video.download() == download_state::DOWNLOADED {
            let exists = video
                .local_path()
                .map(|rel| paths.videos_dir.join(rel).is_file())
                .unwrap_or(false);
            if !exists {
                video.set("download", json!(download_state::NONE));
                video.set("updatedAt", json!(now.clone()));
                report.healed_count += 1;
                let _ = remove_from_download_archive(paths, &entry.id);
            }
        }
    }

    // Sweep dei possibili rimossi + riconciliazione inversa (difesa (b)).
    for (id, video) in state.videos.iter_mut() {
        if mounted && video.download() == download_state::NONE {
            if let Some(rel) = video.local_path().map(str::to_string) {
                if paths.videos_dir.join(&rel).is_file() {
                    video.set("download", json!(download_state::DOWNLOADED));
                    video.set("updatedAt", json!(now.clone()));
                    report.reclaimed_count += 1;
                }
            }
        }

        let belongs = video.source_ids().contains(&source_id);
        if belongs && !found.contains(id.as_str()) && video.presence() == presence::PRESENT {
            let miss = video.0.get("missCount").and_then(serde_json::Value::as_u64).unwrap_or(0) + 1;
            video.set("missCount", json!(miss));
            video.set("updatedAt", json!(now.clone()));
            if miss >= REMOVED_MISS_THRESHOLD {
                video.set("presence", json!(presence::REMOVED));
                video.set("removedAt", json!(now.clone()));
                report.removed_count += 1;
            }
        }
    }

    report
}

/// Sincronizza una sorgente. L'enumerazione (rete, lenta) avviene **fuori** dal lock
/// di scrittura: tenerlo per tutta la durata di una chiamata di rete bloccherebbe
/// ogni altra operazione.
pub fn sync_source(source_id: &str) -> Result<SyncReport> {
    let state = crate::library::state::read()?;
    let source = state.source(source_id)?.clone();
    let url = source
        .url()
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://www.youtube.com/playlist?list={source_id}"));

    let listing = get_playlist_entries(&url)?;
    let paths = get_paths()?;

    let mut report = transaction(|state| {
        let name = state.sources.get(source_id).and_then(|s| s.name()).map(str::to_string);
        let report = ingest(state, source_id, name.as_deref(), &listing.entries, &paths);
        if let Some(s) = state.sources.get_mut(source_id) {
            s.0.insert("lastCheckedAt".into(), json!(now_iso8601()));
        }
        Ok(report)
    })?;
    report.declared_count = listing.declared_count;
    Ok(report)
}

/// Sincronizza tutte le sorgenti. Un errore su una non ferma le altre: viene
/// raccolto e riportato a fine giro.
pub fn sync_all() -> Result<SyncReport> {
    let started = now_iso8601();
    let state = crate::library::state::read()?;
    let ids: Vec<String> = state.sources.keys().cloned().collect();

    let mut total = SyncReport::default();
    for id in &ids {
        match sync_source(id) {
            Ok(r) => total.merge(r),
            Err(e) => total.errors.push(format!("{id}: {e}")),
        }
    }

    runs::record(
        "sync",
        json!({ "sources": ids }),
        total.errors.is_empty(),
        json!({
            "new": total.new_count, "removed": total.removed_count,
            "restored": total.restored_count, "healed": total.healed_count,
            "reclaimed": total.reclaimed_count
        }),
        &started,
        None,
    );
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::schema::Video;

    fn paths_in(dir: &Path) -> Paths {
        Paths {
            project_root: dir.into(), core_dir: dir.into(), data_dir: dir.into(),
            videos_dir: dir.into(), covers_dir: dir.into(), authors_dir: dir.into(),
            metadata_dir: dir.into(), sources_path: dir.join("s.json"),
            library_path: dir.join("l.json"), legacy_catalog_path: dir.join("c.json"),
            runs_path: dir.join("r.json"), tools_dir: dir.into(),
            ytdlp_binary_path: dir.join("yt-dlp"),
            download_archive_path: dir.join(".a.txt"),
            cookies_path: None, ffmpeg_location: None, vlc_path: String::new(),
        }
    }

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ondo-ops-sync-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(id: &str) -> PlaylistEntry {
        PlaylistEntry {
            id: id.into(), title: Some(format!("T {id}")),
            channel_name: Some("Creator".into()), duration_seconds: Some(100.0),
            playlist_index: 1,
        }
    }

    fn state_with(video: serde_json::Value) -> State {
        let mut s = State::default();
        let v = Video::from_value(video).unwrap();
        s.videos.insert(v.id().to_string(), v);
        s
    }

    #[test]
    fn playlist_id_extraction() {
        assert_eq!(extract_playlist_id("https://y/playlist?list=PLa").as_deref(), Some("PLa"));
        assert_eq!(extract_playlist_id("https://y/watch?v=x&list=PLb&i=2").as_deref(), Some("PLb"));
        assert!(extract_playlist_id("https://y/watch?v=x").is_none());
        assert!(extract_playlist_id("niente").is_none());
    }

    #[test]
    fn new_entries_become_videos_and_create_their_author() {
        let d = tmpdir("new");
        std::fs::write(d.join("x"), "1").unwrap();
        let mut s = State::default();
        let r = ingest(&mut s, "PL1", Some("Mia"), &[entry("a")], &paths_in(&d));
        assert_eq!(r.new_count, 1);
        assert!(s.authors.contains_key("Creator"), "l'autore nasce col primo video");
    }

    #[test]
    fn removal_needs_two_consecutive_misses_and_is_reversible() {
        let d = tmpdir("miss");
        std::fs::write(d.join("x"), "1").unwrap();
        let p = paths_in(&d);
        let mut s = state_with(serde_json::json!({
            "id":"a","presence":"present","download":"none","missCount":0,
            "sources":[{"sourceId":"PL1"}]
        }));

        assert_eq!(ingest(&mut s, "PL1", None, &[], &p).removed_count, 0);
        assert_eq!(s.videos["a"].presence(), "present");
        assert_eq!(ingest(&mut s, "PL1", None, &[], &p).removed_count, 1);
        assert_eq!(s.videos["a"].presence(), "removed");

        // Ricompare → ripristinato.
        let r = ingest(&mut s, "PL1", None, &[entry("a")], &p);
        assert_eq!(r.restored_count, 1);
        assert_eq!(s.videos["a"].presence(), "present");
    }

    #[test]
    fn bug_a_healing_is_skipped_when_the_videos_disk_is_unreachable() {
        // Cartella VUOTA = disco scollegato. Il JS azzererebbe il video.
        let d = tmpdir("offline");
        let mut s = state_with(serde_json::json!({
            "id":"a","presence":"present","download":"downloaded","missCount":0,
            "video":{"localPath":"C/T [a].mp4"},"sources":[{"sourceId":"PL1"}]
        }));
        let r = ingest(&mut s, "PL1", None, &[entry("a")], &paths_in(&d));
        assert_eq!(r.healed_count, 0);
        assert!(r.healing_skipped, "va segnalato");
        assert_eq!(s.videos["a"].download(), "downloaded");
    }

    #[test]
    fn healing_still_works_when_the_disk_is_mounted_and_the_file_is_really_gone() {
        let d = tmpdir("mounted");
        std::fs::write(d.join("altro.mp4"), "1").unwrap();
        let mut s = state_with(serde_json::json!({
            "id":"a","presence":"present","download":"downloaded","missCount":0,
            "video":{"localPath":"C/T [a].mp4"},"sources":[{"sourceId":"PL1"}]
        }));
        let r = ingest(&mut s, "PL1", None, &[entry("a")], &paths_in(&d));
        assert_eq!(r.healed_count, 1);
        assert!(!r.healing_skipped);
    }

    #[test]
    fn bug_b_inverse_reconciliation_reclaims_a_reappeared_file() {
        // Il recupero che il 2026-07-25 richiese una riparazione manuale su 83 video.
        let d = tmpdir("reclaim");
        std::fs::create_dir_all(d.join("C")).unwrap();
        std::fs::write(d.join("C/T [a].mp4"), "dati").unwrap();
        let mut s = state_with(serde_json::json!({
            "id":"a","presence":"present","download":"none","missCount":0,
            "video":{"localPath":"C/T [a].mp4"},"sources":[{"sourceId":"PL1"}]
        }));
        let r = ingest(&mut s, "PL1", None, &[entry("a")], &paths_in(&d));
        assert_eq!(r.reclaimed_count, 1);
        assert_eq!(s.videos["a"].download(), "downloaded");
    }

    #[test]
    fn a_video_found_in_a_second_source_carries_both_labels() {
        let d = tmpdir("labels");
        std::fs::write(d.join("x"), "1").unwrap();
        let mut s = state_with(serde_json::json!({
            "id":"a","presence":"present","download":"none","missCount":0,
            "sources":[{"sourceId":"PL1","name":"Prima"}]
        }));
        ingest(&mut s, "PL2", Some("Seconda"), &[entry("a")], &paths_in(&d));
        assert_eq!(s.videos["a"].source_ids(), vec!["PL1", "PL2"]);
    }

    #[test]
    fn coverage_is_an_indication_not_an_invention() {
        let r = SyncReport { declared_count: Some(100), enumerated_count: 97, ..Default::default() };
        assert_eq!(r.missing_count(), 3);
        let r = SyncReport { declared_count: None, enumerated_count: 97, ..Default::default() };
        assert_eq!(r.missing_count(), 0);
    }
}
