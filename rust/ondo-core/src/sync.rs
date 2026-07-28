//! Sincronizzazione delle fonti — porting di `core/src/services/syncService.js`.
//!
//! ## ⚠️ Qui il porting CORREGGE un bug noto invece di riportarlo
//!
//! `PIANO.md` → "Bug noti da correggere" #1: *«L'auto-guarigione `downloaded →
//! none` distrugge lo stato quando il disco dei video è offline — e non ha
//! l'inverso»*. La versione JS declassa un video appena il file non è su disco,
//! trattando **"disco non montato" come "file cancellato"**: una sync partita con
//! `videosRoot` (un NAS o un disco esterno) irraggiungibile azzera un'intera
//! fonte. Peggio, l'operazione è a senso unico: rimettere il disco non recupera
//! nulla. È accaduto per davvero — 83 video, `storico.md` del 2026-07-25.
//!
//! Le due difese proposte nel backlog sono implementate entrambe:
//!
//! **(a) Guardia sull'intera cartella.** Se `videosDir` è assente o vuota, la
//! sync **salta** l'auto-guarigione invece di declassare. Un disco scollegato non
//! è distinguibile da "l'utente ha cancellato tutti i file a mano", ma il primo
//! caso è di gran lunga più probabile e il secondo è recuperabile (basta una sync
//! in più), mentre l'errore opposto distrugge lo stato.
//!
//! **(b) Riconciliazione inversa.** Un video `none` con un `localPath` registrato
//! il cui file **ricompare** su disco torna `downloaded`. Rende automatico il
//! recupero che nel 2026-07-25 ha richiesto una riparazione manuale.

use std::path::Path;

use serde_json::{json, Value};

use crate::config::{get_paths, Paths};
use crate::error::{OndoError, Result};
use crate::library::remove_from_download_archive;
use crate::schema::{create_new_video_stub, download_state, presence, NewVideoStub, Video};
use crate::store::{read_catalog, update_catalog};
use crate::time::now_iso8601;
use crate::ytdlp::{get_playlist_entries, PlaylistEntry};

/// Sync consecutive in cui un video deve risultare assente **prima** di essere
/// marcato "rimosso": un paio di tentativi di grazia, per non etichettare a causa
/// di un glitch temporaneo di YouTube (una playlist che "perde" un video per una
/// sola sync).
const REMOVED_MISS_THRESHOLD: u64 = 2;

pub fn extract_playlist_id(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == "list")
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Default)]
pub struct IngestReport {
    pub new_count: usize,
    pub healed_count: usize,
    pub removed_count: usize,
    pub restored_count: usize,
    /// Numero di video che sarebbero stati declassati ma sono stati risparmiati
    /// dalla guardia (a). Se > 0, il disco dei video è probabilmente scollegato:
    /// va detto all'utente, non nascosto.
    pub healing_skipped: bool,
    pub reclaimed_count: usize,
    pub declared_count: Option<u64>,
    pub enumerated_count: usize,
}

impl IngestReport {
    /// Copertura dell'enumerazione: se il totale dichiarato da YouTube differisce
    /// dagli entry realmente enumerati, qualche video non era visibile in questa
    /// estrazione (privato/rimosso/glitch). Non è infallibile — a volte i privati
    /// compaiono come segnaposto — quindi si presenta come indizio.
    pub fn missing_count(&self) -> u64 {
        match self.declared_count {
            Some(d) => d.saturating_sub(self.enumerated_count as u64),
            None => 0,
        }
    }
}

/// La cartella dei video è raggiungibile e non vuota? Se no, ogni `existsSync` su
/// un file al suo interno fallirebbe **per il motivo sbagliato**.
fn videos_dir_looks_mounted(videos_dir: &Path) -> bool {
    match std::fs::read_dir(videos_dir) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => false,
    }
}

/// Trasforma gli entry grezzi di una playlist in mutazioni sul catalogo. Usata sia
/// da `sync_source` sia da `add_source` (primo ingest), per non duplicare la logica.
pub fn ingest_playlist_entries(
    catalog: &mut Value,
    source_id: &str,
    source_name: Option<&str>,
    entries: &[PlaylistEntry],
    paths: &Paths,
) -> IngestReport {
    let mut report = IngestReport {
        enumerated_count: entries.len(),
        ..Default::default()
    };

    let mounted = videos_dir_looks_mounted(&paths.videos_dir);
    report.healing_skipped = !mounted;

    let found_ids: std::collections::HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    let now = now_iso8601();

    let Some(videos) = catalog.get_mut("videos").and_then(Value::as_object_mut) else {
        return report;
    };

    // -- entry presenti nell'enumerazione --
    for entry in entries {
        match videos.get_mut(&entry.id) {
            None => {
                let stub = create_new_video_stub(NewVideoStub {
                    id: &entry.id,
                    title: entry.title.as_deref(),
                    channel_name: entry.channel_name.as_deref(),
                    duration_seconds: entry.duration_seconds,
                    playlist_index: Some(entry.playlist_index),
                    playlist_id: Some(source_id),
                    playlist_title: source_name,
                    source_id: Some(source_id),
                    webpage_url: None,
                    original_url: None,
                    extractor: None,
                });
                videos.insert(entry.id.clone(), stub.into_value());
                report.new_count += 1;
            }
            Some(existing_val) => {
                let Some(map) = existing_val.as_object_mut() else { continue };
                let mut video = Video(std::mem::take(map));

                // Ritrovato: azzera il contatore di assenze e, se era stato marcato
                // "rimosso", ripristina la presenza (la detection è reversibile).
                video.0.insert("missCount".into(), json!(0));
                if video.presence() == presence::REMOVED {
                    video.0.insert("presence".into(), json!(presence::PRESENT));
                    video.0.insert("removedAt".into(), Value::Null);
                    video.0.insert("updatedAt".into(), json!(now.clone()));
                    report.restored_count += 1;
                }

                // Riuso in questa fonte: un video già a catalogo (arrivato da
                // un'altra fonte, o come singolo) trovato anche fra gli entry di
                // QUESTA fonte porta la sua etichetta, invece di essere ignorato
                // dal dedup senza lasciare traccia del collegamento.
                let already_labelled = video
                    .0
                    .get("sources")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .any(|s| s.get("sourceId").and_then(Value::as_str) == Some(source_id))
                    })
                    .unwrap_or(false);
                if !already_labelled {
                    let label = json!({ "sourceId": source_id, "name": source_name });
                    match video.0.get_mut("sources").and_then(Value::as_array_mut) {
                        Some(arr) => arr.push(label),
                        None => {
                            video.0.insert("sources".into(), json!([label]));
                        }
                    }
                    video.0.insert("updatedAt".into(), json!(now.clone()));
                }

                // Auto-guarigione: file sparito → torna scaricabile. SALTATA se la
                // cartella dei video non è raggiungibile (difesa (a)).
                if mounted && video.download() == download_state::DOWNLOADED {
                    let exists = video
                        .local_path()
                        .map(|rel| paths.videos_dir.join(rel).is_file())
                        .unwrap_or(false);
                    if !exists {
                        video.0.insert("download".into(), json!(download_state::NONE));
                        video.0.insert("updatedAt".into(), json!(now.clone()));
                        report.healed_count += 1;
                        // Va tolto anche dall'archivio yt-dlp, altrimenti il
                        // prossimo download viene saltato "già fatto".
                        let _ = remove_from_download_archive(paths, &entry.id);
                    }
                }

                *map = video.0;
            }
        }
    }

    // -- sweep dei possibili rimossi + riconciliazione inversa --
    for (_, raw) in videos.iter_mut() {
        let Some(map) = raw.as_object_mut() else { continue };
        let mut video = Video(std::mem::take(map));
        let id = video.id().to_string();

        let belongs = video
            .0
            .get("sources")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .any(|s| s.get("sourceId").and_then(Value::as_str) == Some(source_id))
            })
            .unwrap_or(false);

        // Difesa (b): riconciliazione INVERSA, assente nell'implementazione JS.
        // Un video declassato per errore il cui file è di nuovo (o ancora) su
        // disco torna `downloaded` da sé.
        if mounted && video.download() == download_state::NONE {
            if let Some(rel) = video.local_path().map(str::to_string) {
                if paths.videos_dir.join(&rel).is_file() {
                    video.0.insert("download".into(), json!(download_state::DOWNLOADED));
                    video.0.insert("updatedAt".into(), json!(now.clone()));
                    report.reclaimed_count += 1;
                }
            }
        }

        if belongs && !found_ids.contains(id.as_str()) && video.presence() == presence::PRESENT {
            let miss = video.0.get("missCount").and_then(Value::as_u64).unwrap_or(0) + 1;
            video.0.insert("missCount".into(), json!(miss));
            video.0.insert("updatedAt".into(), json!(now.clone()));
            if miss >= REMOVED_MISS_THRESHOLD {
                video.0.insert("presence".into(), json!(presence::REMOVED));
                video.0.insert("removedAt".into(), json!(now.clone()));
                report.removed_count += 1;
            }
        }

        *map = video.0;
    }

    report
}

/// Enumera la playlist di una fonte già registrata e applica l'ingest.
pub fn sync_source(source_id: &str) -> Result<IngestReport> {
    let catalog = read_catalog()?;
    let source = catalog
        .get("sources")
        .and_then(|s| s.get(source_id))
        .cloned()
        .ok_or_else(|| {
            OndoError::not_found(format!(
                "Fonte non trovata: \"{source_id}\" — aggiungila prima da \"Gestisci fonti\""
            ))
        })?;

    let url = source
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://www.youtube.com/playlist?list={source_id}"));

    // L'enumerazione (rete, lenta) avviene FUORI dal lock di scrittura: tenere il
    // lock durante una chiamata di rete bloccherebbe ogni altra operazione per
    // tutta la sua durata.
    let listing = get_playlist_entries(&url)?;
    let paths = get_paths()?;

    let mut report = update_catalog(|catalog| {
        let name = catalog
            .get("sources")
            .and_then(|s| s.get(source_id))
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if name.is_none()
            && catalog
                .get("sources")
                .and_then(|s| s.get(source_id))
                .is_none()
        {
            return Err(OndoError::not_found(format!(
                "Fonte rimossa durante la sincronizzazione: \"{source_id}\""
            )));
        }

        let report = ingest_playlist_entries(
            catalog,
            source_id,
            name.as_deref(),
            &listing.entries,
            &paths,
        );

        if let Some(meta) = catalog
            .get_mut("sources")
            .and_then(|s| s.get_mut(source_id))
            .and_then(Value::as_object_mut)
        {
            meta.insert("lastCheckedAt".into(), json!(now_iso8601()));
        }
        Ok(report)
    })?;

    report.declared_count = listing.declared_count;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths_with_videos_dir(dir: &Path) -> Paths {
        let mut p = Paths {
            project_root: dir.to_path_buf(),
            core_dir: dir.to_path_buf(),
            media_root: dir.to_path_buf(),
            videos_dir: dir.to_path_buf(),
            thumbnails_dir: dir.to_path_buf(),
            avatars_dir: dir.to_path_buf(),
            data_dir: dir.to_path_buf(),
            catalog_path: dir.join("catalog.json"),
            metadata_path: dir.join("metadata.json"),
            jobs_path: dir.join("jobs.json"),
            tools_dir: dir.to_path_buf(),
            ytdlp_binary_path: dir.join("yt-dlp"),
            download_archive_path: dir.join(".ytdlp-archive.txt"),
            cookies_path: None,
            ffmpeg_location: None,
            vlc_path: String::new(),
        };
        p.videos_dir = dir.to_path_buf();
        p
    }

    fn entry(id: &str) -> PlaylistEntry {
        PlaylistEntry {
            id: id.to_string(),
            title: Some(format!("Titolo {id}")),
            channel_name: Some("Creator".into()),
            duration_seconds: Some(100.0),
            playlist_index: 1,
        }
    }

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ondo-sync-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn playlist_id_is_extracted_from_the_list_parameter() {
        assert_eq!(
            extract_playlist_id("https://www.youtube.com/playlist?list=PLabc").as_deref(),
            Some("PLabc")
        );
        assert_eq!(
            extract_playlist_id("https://www.youtube.com/watch?v=x&list=PLxyz&index=2").as_deref(),
            Some("PLxyz")
        );
        assert!(extract_playlist_id("https://www.youtube.com/watch?v=x").is_none());
        assert!(extract_playlist_id("non-un-url").is_none());
    }

    #[test]
    fn new_entries_become_stubs() {
        let dir = tmpdir("new");
        std::fs::write(dir.join("segnaposto"), "x").unwrap();
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": {}, "sources": {} });
        let report = ingest_playlist_entries(&mut catalog, "PL1", Some("Mia"), &[entry("a")], &paths);
        assert_eq!(report.new_count, 1);
        assert_eq!(catalog["videos"]["a"]["presence"], "present");
        assert_eq!(catalog["videos"]["a"]["sources"][0]["sourceId"], "PL1");
    }

    #[test]
    fn removal_needs_two_consecutive_misses() {
        let dir = tmpdir("miss");
        std::fs::write(dir.join("segnaposto"), "x").unwrap();
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": { "a": {
            "id": "a", "presence": "present", "download": "none", "missCount": 0,
            "sources": [{ "sourceId": "PL1", "name": "Mia" }]
        }}, "sources": {} });

        // Prima assenza: solo il contatore sale, il video resta presente.
        let r = ingest_playlist_entries(&mut catalog, "PL1", Some("Mia"), &[], &paths);
        assert_eq!(r.removed_count, 0);
        assert_eq!(catalog["videos"]["a"]["missCount"], 1);
        assert_eq!(catalog["videos"]["a"]["presence"], "present");

        // Seconda assenza consecutiva: ora sì.
        let r = ingest_playlist_entries(&mut catalog, "PL1", Some("Mia"), &[], &paths);
        assert_eq!(r.removed_count, 1);
        assert_eq!(catalog["videos"]["a"]["presence"], "removed");
        assert!(!catalog["videos"]["a"]["removedAt"].is_null());
    }

    #[test]
    fn reappearing_video_is_restored() {
        let dir = tmpdir("restore");
        std::fs::write(dir.join("segnaposto"), "x").unwrap();
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": { "a": {
            "id": "a", "presence": "removed", "removedAt": "2026-01-01T00:00:00.000Z",
            "download": "none", "missCount": 5, "sources": [{ "sourceId": "PL1" }]
        }}, "sources": {} });
        let r = ingest_playlist_entries(&mut catalog, "PL1", None, &[entry("a")], &paths);
        assert_eq!(r.restored_count, 1);
        assert_eq!(catalog["videos"]["a"]["presence"], "present");
        assert!(catalog["videos"]["a"]["removedAt"].is_null());
        assert_eq!(catalog["videos"]["a"]["missCount"], 0);
    }

    #[test]
    fn bug_fix_a_healing_is_skipped_when_the_videos_disk_is_unreachable() {
        // La cartella dei video è VUOTA: simula il NAS scollegato. Il JS azzererebbe
        // il video; qui deve essere risparmiato.
        let dir = tmpdir("offline");
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": { "a": {
            "id": "a", "presence": "present", "download": "downloaded", "missCount": 0,
            "video": { "localPath": "Creator/T [a].mp4" },
            "sources": [{ "sourceId": "PL1" }]
        }}, "sources": {} });

        let r = ingest_playlist_entries(&mut catalog, "PL1", None, &[entry("a")], &paths);
        assert_eq!(r.healed_count, 0, "nessun declassamento a disco scollegato");
        assert!(r.healing_skipped, "va segnalato all'utente, non nascosto");
        assert_eq!(catalog["videos"]["a"]["download"], "downloaded");
    }

    #[test]
    fn healing_still_works_when_the_disk_is_mounted_but_the_file_is_gone() {
        let dir = tmpdir("mounted");
        // Cartella NON vuota (disco montato) ma senza il file del video.
        std::fs::write(dir.join("altro.mp4"), "x").unwrap();
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": { "a": {
            "id": "a", "presence": "present", "download": "downloaded", "missCount": 0,
            "video": { "localPath": "Creator/T [a].mp4" },
            "sources": [{ "sourceId": "PL1" }]
        }}, "sources": {} });

        let r = ingest_playlist_entries(&mut catalog, "PL1", None, &[entry("a")], &paths);
        assert_eq!(r.healed_count, 1, "file davvero mancante: il declassamento è corretto");
        assert!(!r.healing_skipped);
        assert_eq!(catalog["videos"]["a"]["download"], "none");
    }

    #[test]
    fn bug_fix_b_inverse_reconciliation_reclaims_a_reappeared_file() {
        // Il recupero che il 2026-07-25 richiese una riparazione manuale su 83 video.
        let dir = tmpdir("reclaim");
        std::fs::create_dir_all(dir.join("Creator")).unwrap();
        std::fs::write(dir.join("Creator/T [a].mp4"), "contenuto").unwrap();
        let paths = paths_with_videos_dir(&dir);
        let mut catalog = json!({ "videos": { "a": {
            "id": "a", "presence": "present", "download": "none", "missCount": 0,
            "video": { "localPath": "Creator/T [a].mp4" },
            "sources": [{ "sourceId": "PL1" }]
        }}, "sources": {} });

        let r = ingest_playlist_entries(&mut catalog, "PL1", None, &[entry("a")], &paths);
        assert_eq!(r.reclaimed_count, 1);
        assert_eq!(catalog["videos"]["a"]["download"], "downloaded");
    }

    #[test]
    fn coverage_reports_videos_invisible_in_this_extraction() {
        let r = IngestReport { declared_count: Some(100), enumerated_count: 97, ..Default::default() };
        assert_eq!(r.missing_count(), 3);
        let r = IngestReport { declared_count: None, enumerated_count: 97, ..Default::default() };
        assert_eq!(r.missing_count(), 0, "senza il dichiarato non si inventa nulla");
    }
}
