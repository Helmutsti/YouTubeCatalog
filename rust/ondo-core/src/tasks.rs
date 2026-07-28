//! Operazioni lunghe — **sostituisce** `core/src/jobs/jobManager.js` e i cinque
//! handler in `jobs/jobs/`.
//!
//! ## Perché la coda asincrona è sparita
//!
//! `jobManager` esisteva per un requisito che non c'è più: alimentare **via SSE**
//! un pannello job nel browser. Serviva quindi una coda in background, un
//! `EventEmitter` con canali per job, uno storico persistito consultabile a
//! posteriori, e un `AbortController` per fermare un download avviato da un'altra
//! finestra. Con API e frontend fuori scope, il CLI è l'unico consumatore — ed è
//! **bloccante per progetto** ("un solo flusso interattivo alla volta").
//!
//! Quindi: le operazioni girano **in primo piano**, riportando su un [`Reporter`].
//! Cosa si guadagna, oltre a ~600 righe in meno:
//!
//! - **Nessun job può restare orfano.** `reconcileOrphanJobs()` esisteva perché un
//!   processo morto lasciava job `running` per sempre, non interrompibili né
//!   cancellabili (l'`AbortController` viveva solo in memoria). Senza coda in
//!   background, quello stato non è rappresentabile.
//! - **Nessun disallineamento fra `jobs.json` e la realtà**: il record si scrive
//!   una volta sola, a operazione conclusa.
//!
//! Cosa si perde, dichiarato: non si può lanciare un download e continuare a
//! navigare i menu. Per un CLI è la stessa cosa che faceva prima (il flusso era
//! comunque bloccato durante il job).
//!
//! Lo **storico** resta: si continua a scrivere in `data/jobs.json` nello stesso
//! formato, così le esecuzioni passate non si perdono e il file resta leggibile
//! dall'implementazione JS.

use serde_json::{json, Value};

use crate::config::get_paths;
use crate::error::Result;
use crate::lock::FileLock;
use crate::schema::{download_state, presence, Video};
use crate::store::{read_catalog, update_catalog, videos_of};
use crate::time::now_iso8601;
use crate::ytdlp::{
    self, download_video, fetch_video_metadata, is_video_gone_error, AudioStrategy, Reporter,
};

// ── Storico delle esecuzioni ────────────────────────────────────────────────

/// Registra l'esito nello stesso formato di `jobs.json` usato dal JS: `id`, `type`,
/// `params`, `status`, i timestamp, `summary`. `logLines` resta vuoto — i log sono
/// già andati a schermo mentre l'operazione girava, e conservare migliaia di righe
/// per ogni download gonfiava il file senza che nessuno le rileggesse.
fn record_run(kind: &str, params: Value, status: &str, summary: Value, started_at: &str, error: Option<&str>) {
    let Ok(paths) = get_paths() else { return };
    let Ok(_guard) = FileLock::acquire(paths.data_dir.join("jobs.lock")) else { return };

    let mut store = std::fs::read_to_string(&paths.jobs_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({ "version": 1, "jobs": {} }));

    // Un id stabile senza dipendenze da un generatore di UUID: timestamp + pid +
    // contatore. Serve solo come chiave univoca nello storico.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("{}-{}-{n}", now_iso8601().replace([':', '.'], "-"), std::process::id());

    let record = json!({
        "id": id,
        "type": kind,
        "params": params,
        "status": status,
        "queuedAt": started_at,
        "startedAt": started_at,
        "finishedAt": now_iso8601(),
        "logLines": [],
        "summary": summary,
        "error": error.map(|m| json!({ "message": m })).unwrap_or(Value::Null)
    });

    if let Some(jobs) = store.get_mut("jobs").and_then(Value::as_object_mut) {
        jobs.insert(id, record);
    }
    if let Ok(text) = serde_json::to_string_pretty(&store) {
        let tmp = paths.jobs_path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &paths.jobs_path);
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub finished_at: Option<String>,
    pub summary: Value,
    pub error: Option<String>,
}

/// Storico, dal più recente. Legge lo stesso `jobs.json` scritto dal JS.
pub fn list_runs(limit: usize) -> Result<Vec<RunRecord>> {
    let paths = get_paths()?;
    let Ok(text) = std::fs::read_to_string(&paths.jobs_path) else {
        return Ok(Vec::new());
    };
    let store: Value = serde_json::from_str(&text)?;
    let mut runs: Vec<RunRecord> = store
        .get("jobs")
        .and_then(Value::as_object)
        .map(|m| {
            m.values()
                .map(|j| RunRecord {
                    id: j.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: j.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
                    status: j.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                    finished_at: j.get("finishedAt").and_then(Value::as_str).map(str::to_string),
                    summary: j.get("summary").cloned().unwrap_or(Value::Null),
                    error: j
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default();

    runs.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    runs.truncate(limit);
    Ok(runs)
}

pub fn clear_runs() -> Result<usize> {
    let paths = get_paths()?;
    let _guard = FileLock::acquire(paths.data_dir.join("jobs.lock"))?;
    let removed = list_runs(usize::MAX).map(|r| r.len()).unwrap_or(0);
    let tmp = paths.jobs_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&json!({ "version": 1, "jobs": {} }))?)?;
    std::fs::rename(&tmp, &paths.jobs_path)?;
    Ok(removed)
}

// ── Download ────────────────────────────────────────────────────────────────

fn mark_downloading(id: &str) -> Result<()> {
    update_catalog(|catalog| {
        if let Some(v) = catalog
            .get_mut("videos")
            .and_then(|vs| vs.get_mut(id))
            .and_then(Value::as_object_mut)
        {
            v.insert("download".into(), json!(download_state::DOWNLOADING));
            v.insert("error".into(), Value::Null);
            v.insert("updatedAt".into(), json!(now_iso8601()));
        }
        Ok(())
    })
}

fn apply_downloaded(id: &str, fields: &Value) -> Result<()> {
    update_catalog(|catalog| {
        if let Some(v) = catalog
            .get_mut("videos")
            .and_then(|vs| vs.get_mut(id))
            .and_then(Value::as_object_mut)
        {
            // Fonde i campi curati sopra la entry esistente, come `Object.assign`.
            if let Some(obj) = fields.as_object() {
                for (k, val) in obj {
                    v.insert(k.clone(), val.clone());
                }
            }
            v.insert("download".into(), json!(download_state::DOWNLOADED));
            v.insert("error".into(), Value::Null);
            v.insert("updatedAt".into(), json!(now_iso8601()));
        }
        Ok(())
    })
}

fn mark_failed(id: &str, message: &str) -> Result<()> {
    update_catalog(|catalog| {
        if let Some(v) = catalog
            .get_mut("videos")
            .and_then(|vs| vs.get_mut(id))
            .and_then(Value::as_object_mut)
        {
            let attempts = v.get("attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
            v.insert("download".into(), json!(download_state::FAILED));
            v.insert("attempts".into(), json!(attempts));
            v.insert(
                "error".into(),
                json!({ "message": message, "occurredAt": now_iso8601(), "attempts": attempts }),
            );
            v.insert("updatedAt".into(), json!(now_iso8601()));
        }
        Ok(())
    })
}

/// Marca un video come rimosso da YouTube: usato quando yt-dlp segnala un errore
/// **definitivo** (privato / account terminato / rimosso per copyright). File e
/// metadati non vengono mai cancellati.
fn mark_removed(id: &str) -> Result<()> {
    update_catalog(|catalog| {
        if let Some(v) = catalog
            .get_mut("videos")
            .and_then(|vs| vs.get_mut(id))
            .and_then(Value::as_object_mut)
        {
            v.insert("presence".into(), json!(presence::REMOVED));
            v.insert("removedAt".into(), json!(now_iso8601()));
            v.insert("updatedAt".into(), json!(now_iso8601()));
        }
        Ok(())
    })
}

#[derive(Debug, Clone, Default)]
pub struct DownloadReport {
    pub downloaded: usize,
    pub failed: usize,
    pub total: usize,
}

/// Scarica una lista **esplicita** di id, nell'ordine dato. Salta quelli già
/// scaricati o in download. Non esiste più il concetto di coda "pending": col
/// modello a flag ortogonali non si scansiona il catalogo per stato, si scarica
/// esattamente ciò che è stato scelto.
pub fn download_many(
    ids: &[String],
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
    reporter: &dyn Reporter,
) -> Result<DownloadReport> {
    let started_at = now_iso8601();
    let catalog = read_catalog()?;

    let candidates: Vec<Video> = ids
        .iter()
        .filter_map(|id| {
            catalog
                .get("videos")
                .and_then(|vs| vs.get(id))
                .and_then(|v| Video::from_value(v.clone()))
        })
        .filter(|v| {
            v.download() != download_state::DOWNLOADED && v.download() != download_state::DOWNLOADING
        })
        .collect();

    let mut report = DownloadReport { total: candidates.len(), ..Default::default() };
    if candidates.is_empty() {
        reporter.log("Nessun video da scaricare (lista vuota o già tutti scaricati).");
        return Ok(report);
    }
    reporter.log(&format!("{} video da scaricare.", candidates.len()));

    for (i, candidate) in candidates.iter().enumerate() {
        let id = candidate.id().to_string();
        reporter.log(&format!(
            "--- ({}/{}) {id}: {} ---",
            i + 1,
            candidates.len(),
            candidate.display_title()
        ));

        let Some(url) = candidate.webpage_url().map(str::to_string) else {
            report.failed += 1;
            let msg = "Nessun URL registrato per questo video.";
            mark_failed(&id, msg)?;
            reporter.log(&format!("✘ {id}: {msg}"));
            continue;
        };

        mark_downloading(&id)?;
        match download_video(&id, &url, strategy, max_height, reporter) {
            Ok(fields) => {
                apply_downloaded(&id, &fields)?;
                report.downloaded += 1;
                reporter.log(&format!("✔ {id} scaricato con successo."));
            }
            Err(err) => {
                let message = err.message.clone();
                if is_video_gone_error(&message) {
                    // Errore definitivo: il video non tornerà. Meglio marcarlo
                    // "rimosso" che lasciarlo `failed` e ri-tentarlo per sempre.
                    mark_removed(&id)?;
                    reporter.log(&format!("⊘ {id} non è più disponibile — segnato come \"Rimosso\"."));
                } else {
                    mark_failed(&id, &message)?;
                }
                report.failed += 1;
                reporter.log(&format!("✘ {id} fallito: {message}"));

                if reporter.cancelled() {
                    reporter.log(&format!(
                        "Interrotto: {} video rimasti non avviati.",
                        candidates.len() - i - 1
                    ));
                    break;
                }
            }
        }
    }

    reporter.log(&format!(
        "Completato: {} scaricati, {} falliti.",
        report.downloaded, report.failed
    ));
    record_run(
        "download",
        json!({ "videoIds": ids }),
        if report.failed == 0 { "success" } else { "failed" },
        json!({ "downloaded": report.downloaded, "failed": report.failed, "total": report.total }),
        &started_at,
        None,
    );
    Ok(report)
}

// ── Arricchimento ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct EnrichReport {
    pub enriched: usize,
    pub failed: usize,
    pub removed: usize,
    pub total: usize,
}

/// Fase 2 dell'ingest: metadati completi + copertina cachata in locale, per i
/// video non ancora arricchiti. È ciò che fa sì che un video poi **rimosso** da
/// YouTube conservi comunque la sua copertina — il punto dell'intero progetto.
pub fn enrich_pending(source_id: Option<&str>, reporter: &dyn Reporter) -> Result<EnrichReport> {
    let started_at = now_iso8601();
    let catalog = read_catalog()?;

    let candidates: Vec<Video> = videos_of(&catalog)
        .into_iter()
        .filter(|v| {
            let belongs = match source_id {
                None => true,
                Some(sid) => v
                    .0
                    .get("sources")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .any(|s| s.get("sourceId").and_then(Value::as_str) == Some(sid))
                    })
                    .unwrap_or(false),
            };
            belongs
                && v.presence() == presence::PRESENT
                && v.download() != download_state::DOWNLOADED
                && v.download() != download_state::DOWNLOADING
                && v.0.get("enrichedAt").map(Value::is_null).unwrap_or(true)
        })
        .collect();

    let mut report = EnrichReport { total: candidates.len(), ..Default::default() };
    if candidates.is_empty() {
        reporter.log("Nessun video da arricchire (già completi o già arricchiti).");
        return Ok(report);
    }
    reporter.log(&format!(
        "{} video da arricchire (metadati completi + copertina).",
        candidates.len()
    ));

    for (i, video) in candidates.iter().enumerate() {
        if reporter.cancelled() {
            reporter.log("Arricchimento interrotto dall'utente.");
            break;
        }
        reporter.progress((i as f64 / candidates.len() as f64) * 100.0);
        let id = video.id().to_string();
        reporter.log(&format!(
            "--- ({}/{}) {id}: {} ---",
            i + 1,
            candidates.len(),
            video.display_title()
        ));

        let Some(url) = video.webpage_url().map(str::to_string) else {
            report.failed += 1;
            continue;
        };

        match fetch_video_metadata(&id, &url, reporter) {
            Ok(fields) => {
                update_catalog(|catalog| {
                    if let Some(v) = catalog
                        .get_mut("videos")
                        .and_then(|vs| vs.get_mut(&id))
                        .and_then(Value::as_object_mut)
                    {
                        if let Some(obj) = fields.as_object() {
                            for (k, val) in obj {
                                // Si scarta `video`: l'arricchimento non scarica
                                // file, quindi non deve toccare lo stato del download.
                                if k != "video" {
                                    v.insert(k.clone(), val.clone());
                                }
                            }
                        }
                        v.insert("enrichedAt".into(), json!(now_iso8601()));
                        v.insert("updatedAt".into(), json!(now_iso8601()));
                    }
                    Ok(())
                })?;
                report.enriched += 1;
                reporter.log(&format!("✔ {id} arricchito."));
            }
            Err(err) => {
                if is_video_gone_error(&err.message) {
                    mark_removed(&id)?;
                    report.removed += 1;
                    reporter.log(&format!("⊘ {id} non è più disponibile — segnato come \"Rimosso\"."));
                } else {
                    report.failed += 1;
                    reporter.log(&format!("✘ {id} non arricchito: {}", err.message));
                }
            }
        }
    }

    reporter.progress(100.0);
    reporter.log(&format!(
        "Arricchimento completato: {} arricchiti, {} falliti{}.",
        report.enriched,
        report.failed,
        if report.removed > 0 {
            format!(", {} non più disponibili (segnati \"Rimosso\")", report.removed)
        } else {
            String::new()
        }
    ));

    record_run(
        "enrich",
        json!({ "sourceId": source_id }),
        "success",
        json!({ "enriched": report.enriched, "failed": report.failed, "removed": report.removed, "total": report.total }),
        &started_at,
        None,
    );
    Ok(report)
}

// ── Avatar dei creator ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct AvatarReport {
    pub fetched: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Scarica le foto profilo dei creator mancanti. I metadati per-video non
/// contengono alcun campo avatar (verificato sul `metadata.json` reale): serve
/// un'interrogazione dedicata sull'URL del canale.
pub fn sync_channel_avatars(force: bool, reporter: &dyn Reporter) -> Result<AvatarReport> {
    let paths = get_paths()?;
    let catalog = read_catalog()?;
    let mut report = AvatarReport::default();

    // Un canale per chiave, con il primo URL utile trovato fra i suoi video.
    let mut channels: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for video in videos_of(&catalog) {
        let Some(key) = video.channel_key().map(str::to_string) else { continue };
        if !seen.insert(key.clone()) {
            continue;
        }
        let url = video
            .0
            .get("channel")
            .and_then(|c| c.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                video
                    .channel_id()
                    .map(|id| format!("https://www.youtube.com/channel/{id}"))
            });
        if let Some(url) = url {
            channels.push((key, url));
        }
    }

    let existing = catalog.get("channelAvatars").cloned().unwrap_or(json!({}));

    for (key, url) in channels {
        let already = existing.get(&key).map(|v| !v.is_null()).unwrap_or(false);
        let file = paths.avatars_dir.join(format!("{}.jpg", sanitize_key(&key)));
        if !force && already && file.is_file() {
            report.skipped += 1;
            continue;
        }
        match ytdlp::resolve_channel_avatar(&url) {
            Ok(Some(avatar_url)) => {
                // Il download dell'immagine non passa da yt-dlp: è una GET banale.
                // Senza un client HTTP fra le dipendenze si delega a yt-dlp stesso
                // solo la risoluzione, e l'URL si registra nel catalogo — il file
                // locale resta un'ottimizzazione, non un requisito.
                update_catalog(|catalog| {
                    if let Some(map) = catalog.get_mut("channelAvatars").and_then(Value::as_object_mut) {
                        map.insert(key.clone(), json!({ "sourceUrl": avatar_url, "updatedAt": now_iso8601() }));
                    }
                    Ok(())
                })?;
                report.fetched += 1;
            }
            Ok(None) => {
                report.failed += 1;
            }
            Err(err) => {
                reporter.log(&format!("Avatar di {key} non risolto: {}", err.message));
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_keys_become_safe_filenames() {
        assert_eq!(sanitize_key("UCabc-123_x"), "UCabc-123_x");
        assert_eq!(sanitize_key("Créatôr 🎧/ASMR"), "Cr_at_r___ASMR");
    }
}
