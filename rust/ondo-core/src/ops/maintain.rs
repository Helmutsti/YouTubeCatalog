//! Manutenzione: flag utente, cancellazioni, riorganizzazione, avatar, migrazione.

use serde_json::{json, Value};

use crate::config::get_paths;
use crate::downloader::{resolve_channel_avatar, Reporter};
use crate::error::{OndoError, Result};
use crate::library::files::{
    is_already_organized, locate_current_file, prune_empty_dirs, remove_file_and_empty_parent,
    remove_from_download_archive, target_rel_path,
};
use crate::library::schema::download_state;
use crate::library::state::{transaction, MigrationReport};
use crate::library::{metadata, state};

// ── Flag utente ─────────────────────────────────────────────────────────────

pub fn set_hidden(id: &str, hidden: bool) -> Result<()> {
    transaction(|st| {
        st.video_mut(id)?.set_hidden(hidden);
        Ok(())
    })
}

pub fn set_favorite(id: &str, favorite: bool) -> Result<()> {
    transaction(|st| {
        st.video_mut(id)?.set_favorite(favorite);
        Ok(())
    })
}

// ── Cancellazioni ───────────────────────────────────────────────────────────

/// Cancella **solo** il file video, riportando la scheda a "da scaricare". Metadati,
/// copertina e entry restano: il video resta in libreria, ri-scaricabile — coerente
/// con "i record non si perdono mai".
pub fn delete_video_file(id: &str) -> Result<()> {
    let paths = get_paths()?;
    transaction(|st| {
        let video = st.video(id)?;
        if !video.is_downloaded() {
            return Err(OndoError::conflict(format!(
                "Il video \"{id}\" non ha un file da cancellare (stato: {}).",
                video.download()
            )));
        }
        if let Some(rel) = video.local_path().map(str::to_string) {
            remove_file_and_empty_parent(&paths, &rel);
        }
        remove_from_download_archive(&paths, id)?;

        let video = st.video_mut(id)?;
        video.set("download", json!(download_state::NONE));
        // Reset dei soli campi legati al file fisico. `qualityNote` va azzerata:
        // era la nota del download vecchio.
        video.set(
            "video",
            json!({
                "localPath": Value::Null, "formatId": Value::Null, "container": Value::Null,
                "videoCodec": Value::Null, "audioCodec": Value::Null, "bitrateKbps": Value::Null,
                "sizeBytes": Value::Null, "sha256": Value::Null, "downloadedAt": Value::Null,
                "ytdlpVersion": Value::Null, "qualityNote": Value::Null
            }),
        );
        video.touch();
        Ok(())
    })
}

/// Cancellazione **totale e irreversibile**: file, copertina, scheda e metadati.
/// Ammessa solo su un video già archiviato — un gate a due passi deliberato.
///
/// Non è una blocklist: se il video appartiene ancora a una sorgente attiva, la
/// prossima sync lo ricrea. È "come se non l'avessimo mai catalogato".
pub fn delete_video_completely(id: &str) -> Result<()> {
    let paths = get_paths()?;
    transaction(|st| {
        let video = st.video(id)?;
        if !video.hidden() {
            return Err(OndoError::conflict(format!(
                "Il video \"{id}\" va prima archiviato, poi si può cancellare per sempre."
            )));
        }
        if let Some(rel) = video.local_path().map(str::to_string) {
            remove_file_and_empty_parent(&paths, &rel);
        }
        if let Some(cover) = video
            .0
            .get("thumbnail")
            .and_then(|t| t.get("localPath"))
            .and_then(Value::as_str)
        {
            let _ = std::fs::remove_file(paths.covers_dir.join(cover));
        }
        remove_from_download_archive(&paths, id)?;
        st.videos.remove(id);
        st.prune_orphan_authors();
        Ok(())
    })?;
    // Fuori dalla transazione: i metadati sono file a sé, e prendere due lock
    // annidati sarebbe un invito al deadlock.
    metadata::delete(id)
}

// ── Riorganizzazione dell'archivio ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PlannedMove {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default)]
pub struct ReorganizeReport {
    pub dry_run: bool,
    pub moved: usize,
    pub planned: Vec<PlannedMove>,
    pub already_ok: usize,
    pub missing: Vec<String>,
}

/// Porta i file nel layout canonico `<Autore>/<Titolo> [<id>].<ext>`. **Idempotente**:
/// chi è già a posto viene saltato. Con `dry_run` non tocca nulla.
pub fn reorganize_library(dry_run: bool) -> Result<ReorganizeReport> {
    let paths = get_paths()?;
    let st = state::read()?;
    let mut report = ReorganizeReport { dry_run, ..Default::default() };
    let mut moves: Vec<(PlannedMove, std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    let mut realign: Vec<(String, String)> = Vec::new();

    for video in st.videos.values().filter(|v| v.is_downloaded()) {
        let Some((abs, rel)) = locate_current_file(&paths, video) else {
            report.missing.push(video.id().to_string());
            continue;
        };
        if is_already_organized(&rel, video.id()) {
            // Già in un posto valido: si allinea il localPath se differiva, ma il
            // file non si rinomina mai per farlo combaciare col nostro sanitizzatore.
            if video.local_path() != Some(rel.as_str()) {
                realign.push((video.id().to_string(), rel));
            }
            report.already_ok += 1;
            continue;
        }
        let to_rel = target_rel_path(video);
        let to_abs = paths.videos_dir.join(&to_rel);
        moves.push((PlannedMove { id: video.id().to_string(), from: rel, to: to_rel }, abs, to_abs));
    }

    if dry_run {
        report.planned = moves.into_iter().map(|(p, _, _)| p).collect();
        return Ok(report);
    }

    for (plan, from, to) in &moves {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // L'id univoco nel nome rende impossibile in pratica una collisione con un
        // file diverso; se il target esiste già (rerun interrotto) si aggiorna solo
        // il catalogo.
        if !to.exists() {
            std::fs::rename(from, to)?;
        }
        realign.push((plan.id.clone(), plan.to.clone()));
    }

    if !realign.is_empty() {
        // Una sola transazione per tutti gli spostamenti: nessuna finestra in cui lo
        // stato descrive metà lavoro.
        transaction(|st| {
            for (id, rel) in &realign {
                if let Ok(v) = st.video_mut(id) {
                    if let Some(obj) = v.0.get_mut("video").and_then(Value::as_object_mut) {
                        obj.insert("localPath".into(), json!(rel));
                    }
                }
            }
            Ok(())
        })?;
    }

    report.moved = moves.len();
    report.planned = moves.into_iter().map(|(p, _, _)| p).collect();
    prune_empty_dirs(&paths.videos_dir, &paths.videos_dir);
    Ok(report)
}

// ── Foto profilo degli autori ───────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct AvatarReport {
    pub resolved: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Risolve l'URL della foto profilo degli autori che non ce l'hanno.
///
/// ⚠️ **Limite noto**: l'URL viene registrato, l'**immagine non viene scaricata**.
/// Salvarla richiederebbe un client HTTP fra le dipendenze e una CLI non mostra
/// immagini — vedi `rust/README.md`.
pub fn sync_author_avatars(force: bool, reporter: &dyn Reporter) -> Result<AvatarReport> {
    let st = state::read()?;
    let mut report = AvatarReport::default();

    let targets: Vec<(String, String)> = st
        .authors
        .values()
        .filter(|a| force || a.avatar_source_url().is_none())
        .filter_map(|a| {
            a.url()
                .map(str::to_string)
                .or_else(|| a.id().map(|id| format!("https://www.youtube.com/channel/{id}")))
                .map(|url| (a.key().to_string(), url))
        })
        .collect();

    report.skipped = st.authors.len() - targets.len();

    for (key, url) in targets {
        match resolve_channel_avatar(&url) {
            Ok(Some(avatar_url)) => {
                transaction(|st| {
                    if let Some(author) = st.authors.get_mut(&key) {
                        author.set_avatar(Some(&avatar_url), None);
                    }
                    Ok(())
                })?;
                report.resolved += 1;
            }
            Ok(None) => report.failed += 1,
            Err(e) => {
                reporter.log(&format!("Avatar di {key} non risolto: {}", e.message));
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

// ── Migrazione al nuovo layout ──────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct MigrateReport {
    pub state: Option<MigrationReport>,
    pub metadata_files: usize,
}

/// Migra il vecchio layout monolitico (`catalog.json` + `metadata.json`) a
/// `library.json` + `sources.json` + `metadata/<id>.json`.
///
/// **Non cancella nulla**: i file vecchi vengono rinominati `*.pre-v2`, così un
/// eventuale problema resta sempre recuperabile.
pub fn migrate_all() -> Result<MigrateReport> {
    let mut report = MigrateReport::default();
    if state::migration_pending()? {
        report.state = Some(state::migrate_from_legacy()?);
    }
    report.metadata_files = metadata::migrate_from_monolith()?;
    Ok(report)
}

/// Riconta lo stato migrato, per confrontarlo col vecchio `catalog.json` conservato.
/// Serve a rendere la migrazione **verificabile** invece che sperata.
pub fn verify_migration() -> Result<(usize, usize, usize, usize)> {
    let st = state::read()?;
    let with_metadata = st.videos.keys().filter(|id| metadata::has(id)).count();
    Ok((st.videos.len(), st.authors.len(), st.sources.len(), with_metadata))
}
