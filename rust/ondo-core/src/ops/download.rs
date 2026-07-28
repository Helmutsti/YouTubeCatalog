//! Download e arricchimento: dove il downloader e la library si incontrano.
//!
//! Lo schema è sempre lo stesso, e sta qui e non altrove:
//! 1. `library` → cosa scaricare;
//! 2. `downloader` → scarica e **restituisce** i dati;
//! 3. `library` → persiste (entry curata + metadati grezzi).

use serde_json::{json, Value};

use crate::config::get_paths;
use crate::downloader::{
    download_video, fetch_video_metadata, is_video_gone_error, AudioStrategy, Reporter,
};
use crate::error::Result;
use crate::library::files::remove_from_download_archive;
use crate::library::schema::{download_state, presence, Video};
use crate::library::{metadata, state};
use crate::ops::runs;
use crate::time::now_iso8601;

#[derive(Debug, Clone, Default)]
pub struct DownloadReport {
    pub downloaded: usize,
    pub failed: usize,
    pub removed: usize,
    /// Presi da un'altra istanza mentre questa li aveva ancora in lista.
    pub skipped: usize,
    pub total: usize,
}

/// Fonde i campi curati nella entry e la marca scaricata.
fn apply_downloaded(id: &str, fields: &Value) -> Result<()> {
    state::transaction(|st| {
        let Ok(video) = st.video_mut(id) else { return Ok(()) };
        if let Some(obj) = fields.as_object() {
            for (k, v) in obj {
                video.set(k, v.clone());
            }
        }
        video.set("download", json!(download_state::DOWNLOADED));
        video.set("downloadingSince", Value::Null);
        video.set("error", Value::Null);
        video.touch();
        // Il download porta i metadati completi del canale: è il momento in cui la
        // tabella authors impara l'id e l'url veri, che l'enumerazione flat non dava.
        let snapshot = video.clone();
        st.upsert_author_from_video(&snapshot);
        Ok(())
    })
}

/// Rivendica un video per il download, in modo **atomico**.
///
/// ## Perché serve, e perché il lock da solo non bastava
///
/// Il lock di scrittura garantisce che due processi non si sovrascrivano lo stato,
/// ma non impedisce che due istanze **scelgano lo stesso video**: ognuna fotografa la
/// lista dei candidati all'inizio, e fra la fotografia e il download passa tempo. Due
/// istanze lanciate insieme scaricherebbero lo stesso video sullo stesso file.
///
/// La soluzione è fare "controlla e prendi" dentro **una sola** transazione: chi
/// arriva secondo trova già `downloading` e si sposta al prossimo. Senza questo, il
/// download parallelo non è sicuro.
///
/// Ritorna `false` se il video non esiste più o se qualcun altro l'ha già preso.
fn try_claim(id: &str) -> Result<bool> {
    state::transaction(|st| {
        let Ok(video) = st.video(id) else { return Ok(false) };
        if video.download() == download_state::DOWNLOADING
            || video.download() == download_state::DOWNLOADED
        {
            return Ok(false);
        }
        let video = st.video_mut(id)?;
        video.set("download", json!(download_state::DOWNLOADING));
        // La rivendicazione ha una **scadenza**: se questo processo muore, dopo
        // `STALE_DOWNLOAD_MINUTES` il video torna disponibile da sé. Finché è vivo la
        // rinnova (vedi `LeaseKeeper`).
        video.set("downloadingSince", json!(now_iso8601()));
        video.set("error", Value::Null);
        video.touch();
        Ok(true)
    })
}

/// Rinnova la scadenza della rivendicazione, così un download lungo non viene
/// scambiato per abbandonato da un'altra istanza.
fn renew_claim(id: &str) {
    let _ = state::transaction(|st| {
        if let Ok(v) = st.video_mut(id) {
            if v.download() == download_state::DOWNLOADING {
                v.set("downloadingSince", json!(now_iso8601()));
            }
        }
        Ok(())
    });
}

/// Avvolge il reporter dell'interfaccia per rinnovare la rivendicazione mentre il
/// download procede, **al massimo una volta al minuto**: senza la limitazione ogni
/// tacca di avanzamento di yt-dlp provocherebbe una scrittura dello stato.
struct LeaseKeeper<'a> {
    inner: &'a dyn Reporter,
    id: String,
    last: std::sync::Mutex<std::time::Instant>,
}

impl<'a> LeaseKeeper<'a> {
    fn new(inner: &'a dyn Reporter, id: &str) -> Self {
        Self { inner, id: id.to_string(), last: std::sync::Mutex::new(std::time::Instant::now()) }
    }
    fn touch_if_due(&self) {
        let mut last = self.last.lock().unwrap();
        if last.elapsed() >= std::time::Duration::from_secs(60) {
            *last = std::time::Instant::now();
            drop(last);
            renew_claim(&self.id);
        }
    }
}

impl Reporter for LeaseKeeper<'_> {
    fn log(&self, line: &str) {
        self.touch_if_due();
        self.inner.log(line);
    }
    fn progress(&self, percent: f64) {
        self.touch_if_due();
        self.inner.progress(percent);
    }
    fn cancelled(&self) -> bool {
        self.inner.cancelled()
    }
}

fn mark(id: &str, download: &str, error: Option<&str>) -> Result<()> {
    state::transaction(|st| {
        let Ok(video) = st.video_mut(id) else { return Ok(()) };
        video.set("download", json!(download));
        // Rilascio della rivendicazione: il download non è più in corso, qualunque sia
        // stato l'esito. Senza, il video resterebbe "preso" fino alla scadenza.
        video.set("downloadingSince", Value::Null);
        if let Some(msg) = error {
            let attempts = video.0.get("attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
            video.set("attempts", json!(attempts));
            video.set(
                "error",
                json!({ "message": msg, "occurredAt": now_iso8601(), "attempts": attempts }),
            );
        }
        video.touch();
        Ok(())
    })
}

/// Marca un video come non più disponibile su YouTube. File e metadati **non**
/// vengono mai cancellati: conservarli quando l'originale sparisce è il punto del
/// progetto.
fn mark_removed(id: &str) -> Result<()> {
    state::transaction(|st| {
        let Ok(video) = st.video_mut(id) else { return Ok(()) };
        video.set("presence", json!(presence::REMOVED));
        video.set("removedAt", json!(now_iso8601()));
        video.touch();
        Ok(())
    })
}

/// Scarica una lista **esplicita** di id, nell'ordine dato. Salta quelli già
/// scaricati. Col modello a flag ortogonali non esiste più una coda "pending" da
/// scansionare: si scarica esattamente ciò che è stato scelto.
pub fn download_many(
    ids: &[String],
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
    reporter: &dyn Reporter,
) -> Result<DownloadReport> {
    let started = now_iso8601();
    let paths = get_paths()?;
    let st = state::read()?;

    let candidates: Vec<Video> = ids
        .iter()
        .filter_map(|id| st.videos.get(id).cloned())
        .filter(|v| v.download() != download_state::DOWNLOADED && v.download() != download_state::DOWNLOADING)
        .collect();

    let mut report = DownloadReport { total: candidates.len(), ..Default::default() };
    if candidates.is_empty() {
        reporter.log("Nessun video da scaricare (lista vuota o già tutti scaricati).");
        return Ok(report);
    }
    reporter.log(&format!("{} video da scaricare.", candidates.len()));

    for (i, candidate) in candidates.iter().enumerate() {
        let id = candidate.id().to_string();
        reporter.log(&format!("--- ({}/{}) {} ---", i + 1, candidates.len(), candidate.display_title()));

        let Some(url) = candidate.webpage_url().map(str::to_string) else {
            report.failed += 1;
            mark(&id, download_state::FAILED, Some("Nessun URL registrato per questo video."))?;
            continue;
        };

        // Rivendicazione atomica: se un'altra istanza ha già preso questo video, si
        // passa oltre invece di scaricarlo due volte sullo stesso file.
        if !try_claim(&id)? {
            report.skipped += 1;
            reporter.log(&format!("↷ {id}: già in corso o già scaricato altrove, salto."));
            continue;
        }

        // La pulizia dell'archivio sta QUI e non nel downloader: tocca lo stato su
        // disco. Ogni download è una richiesta esplicita di scaricare quel video,
        // quindi la riga residua va tolta o yt-dlp salterebbe il lavoro in silenzio.
        remove_from_download_archive(&paths, &id)?;

        // Il reporter passato al downloader rinnova la scadenza della rivendicazione
        // mentre il download procede.
        let keeper = LeaseKeeper::new(reporter, &id);
        match download_video(&id, &url, strategy, max_height, &keeper) {
            Ok(extracted) => {
                metadata::set(&id, &extracted.raw_info)?;
                apply_downloaded(&id, &extracted.fields)?;
                report.downloaded += 1;
                reporter.log(&format!("✔ {id} scaricato."));
            }
            Err(err) => {
                if is_video_gone_error(&err.message) {
                    // Errore definitivo: il video non tornerà. Meglio "rimosso" che
                    // `failed` ri-tentato per sempre a ogni sync.
                    mark_removed(&id)?;
                    mark(&id, download_state::NONE, None)?;
                    report.removed += 1;
                    reporter.log(&format!("⊘ {id} non è più disponibile — segnato «rimosso»."));
                } else {
                    mark(&id, download_state::FAILED, Some(&err.message))?;
                    report.failed += 1;
                    reporter.log(&format!("✘ {id}: {}", err.message));
                }
                if reporter.cancelled() {
                    reporter.log(&format!("Interrotto: {} video non avviati.", candidates.len() - i - 1));
                    break;
                }
            }
        }
    }

    reporter.log(&format!("Completato: {} scaricati, {} falliti.", report.downloaded, report.failed));
    runs::record(
        "download",
        json!({ "videoIds": ids }),
        report.failed == 0,
        json!({ "downloaded": report.downloaded, "failed": report.failed, "removed": report.removed, "total": report.total }),
        &started,
        None,
    );
    Ok(report)
}

#[derive(Debug, Clone, Default)]
pub struct EnrichReport {
    pub enriched: usize,
    pub failed: usize,
    pub removed: usize,
    pub total: usize,
}

/// Recupera metadati completi e copertina per i video che non li hanno ancora, senza
/// scaricare i video. È ciò che fa sì che un video poi **rimosso** conservi comunque
/// la sua copertina anche quando l'URL YouTube muore.
pub fn enrich(source_id: Option<&str>, reporter: &dyn Reporter) -> Result<EnrichReport> {
    let started = now_iso8601();
    let st = state::read()?;

    let candidates: Vec<Video> = st
        .videos
        .values()
        .filter(|v| {
            let belongs = source_id.map(|s| v.source_ids().contains(&s)).unwrap_or(true);
            belongs
                && v.presence() == presence::PRESENT
                && v.download() != download_state::DOWNLOADED
                && v.download() != download_state::DOWNLOADING
                && v.0.get("enrichedAt").map(Value::is_null).unwrap_or(true)
        })
        .cloned()
        .collect();

    let mut report = EnrichReport { total: candidates.len(), ..Default::default() };
    if candidates.is_empty() {
        reporter.log("Nessun video da completare (già tutti a posto).");
        return Ok(report);
    }
    reporter.log(&format!("{} video da completare (metadati + copertina).", candidates.len()));

    for (i, video) in candidates.iter().enumerate() {
        if reporter.cancelled() {
            reporter.log("Interrotto dall'utente.");
            break;
        }
        reporter.progress((i as f64 / candidates.len() as f64) * 100.0);
        let id = video.id().to_string();
        reporter.log(&format!("--- ({}/{}) {} ---", i + 1, candidates.len(), video.display_title()));

        let Some(url) = video.webpage_url().map(str::to_string) else {
            report.failed += 1;
            continue;
        };

        match fetch_video_metadata(&id, &url, reporter) {
            Ok(extracted) => {
                metadata::set(&id, &extracted.raw_info)?;
                state::transaction(|st| {
                    let Ok(v) = st.video_mut(&id) else { return Ok(()) };
                    if let Some(obj) = extracted.fields.as_object() {
                        for (k, val) in obj {
                            // Si scarta `video`: l'arricchimento non scarica file,
                            // quindi non deve toccare lo stato del download.
                            if k != "video" {
                                v.set(k, val.clone());
                            }
                        }
                    }
                    v.set("enrichedAt", json!(now_iso8601()));
                    v.touch();
                    let snapshot = v.clone();
                    st.upsert_author_from_video(&snapshot);
                    Ok(())
                })?;
                report.enriched += 1;
            }
            Err(err) => {
                if is_video_gone_error(&err.message) {
                    mark_removed(&id)?;
                    report.removed += 1;
                    reporter.log(&format!("⊘ {id} non è più disponibile — segnato «rimosso»."));
                } else {
                    report.failed += 1;
                    reporter.log(&format!("✘ {id}: {}", err.message));
                }
            }
        }
    }

    reporter.progress(100.0);
    reporter.log(&format!(
        "Completato: {} arricchiti, {} falliti, {} non più disponibili.",
        report.enriched, report.failed, report.removed
    ));
    runs::record(
        "enrich",
        json!({ "sourceId": source_id }),
        true,
        json!({ "enriched": report.enriched, "failed": report.failed, "removed": report.removed, "total": report.total }),
        &started,
        None,
    );
    Ok(report)
}
