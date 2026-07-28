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
    /// Foto di creator salvate a fine lotto (la catena si chiude qui).
    pub avatars_saved: usize,
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

/// Applica al catalogo l'esito di **un** video. È l'unico punto in cui lo stato viene
/// scritto durante un lotto: nella versione parallela lo chiama solo il thread
/// principale, mai i worker.
fn apply_outcome(
    id: &str,
    outcome: Result<crate::downloader::Extracted>,
    report: &mut DownloadReport,
    reporter: &dyn Reporter,
) -> Result<()> {
    match outcome {
        Ok(extracted) => {
            metadata::set(id, &extracted.raw_info)?;
            apply_downloaded(id, &extracted.fields)?;
            report.downloaded += 1;
            reporter.log(&format!("✔ {id} scaricato."));
        }
        Err(err) => {
            if is_video_gone_error(&err.message) {
                // Errore definitivo: il video non tornerà. Meglio «rimosso» che
                // `failed` ri-tentato per sempre a ogni sync.
                mark_removed(id)?;
                mark(id, download_state::NONE, None)?;
                report.removed += 1;
                reporter.log(&format!("⊘ {id} non è più disponibile — segnato «rimosso»."));
            } else {
                mark(id, download_state::FAILED, Some(&err.message))?;
                report.failed += 1;
                reporter.log(&format!("✘ {id}: {}", err.message));
            }
        }
    }
    Ok(())
}

/// Scarica **in parallelo**, su thread separati dello stesso processo.
///
/// ## Chi fa cosa
///
/// ```text
/// thread principale        worker (×N)
/// ─────────────────        ───────────
/// rivendica il video   →   scarica (yt-dlp + ffmpeg)
///                      ←   restituisce i dati estratti
/// scrive lo stato
/// ```
///
/// I worker **non toccano mai lo stato**: chiamano `downloader::download_video`, che
/// è puro per costruzione, e rimandano indietro un `Extracted`. Tutte le scritture —
/// rivendicazione, metadati, entry di catalogo — restano sul thread principale, in
/// sequenza. È la proprietà che rende il parallelismo poco rischioso: non ci sono due
/// scrittori, c'è un solo scrittore e N lettori di rete.
///
/// La rivendicazione avviene **prima** di consegnare il lavoro a un worker, così due
/// istanze diverse del programma non possono prendere lo stesso video (e due thread
/// della stessa istanza nemmeno, perché a rivendicare è un solo thread).
fn download_parallel(
    ids: &[String],
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
    workers: usize,
    reporter: &dyn Reporter,
    report: &mut DownloadReport,
) -> Result<()> {
    use std::sync::mpsc;

    let paths = get_paths()?;
    let total = ids.len();
    let (job_tx, job_rx) = mpsc::channel::<(usize, String, String)>();
    let job_rx = std::sync::Mutex::new(job_rx);
    let (res_tx, res_rx) = mpsc::channel::<(usize, String, Result<crate::downloader::Extracted>)>();

    // `scope` garantisce che i thread finiscano prima di uscire dalla funzione: nessun
    // worker può sopravvivere al lotto e continuare a scrivere file di nascosto.
    std::thread::scope(|scope| -> Result<()> {
        for _ in 0..workers {
            let job_rx = &job_rx;
            let res_tx = res_tx.clone();
            scope.spawn(move || {
                loop {
                    // Il lock si tiene solo per prendere il lavoro, non per svolgerlo.
                    let job = { job_rx.lock().unwrap().recv() };
                    let Ok((index, id, url)) = job else { break };
                    let keeper = LeaseKeeper::new(&SilentWorker, &id);
                    let outcome = download_video(&id, &url, strategy, max_height, &keeper);
                    if res_tx.send((index, id, outcome)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(res_tx); // l'ultimo worker che esce chiude il canale dei risultati

        let mut inviati = 0;
        let mut ricevuti = 0;
        let mut prossimo = 0;

        // Si tiene in volo al massimo `workers` lavori: consegnarli tutti subito
        // significherebbe rivendicarli tutti in anticipo, e un'interruzione li
        // lascerebbe tutti marcati «in corso».
        loop {
            while inviati - ricevuti < workers && prossimo < total {
                let id = ids[prossimo].clone();
                prossimo += 1;

                let st = state::read()?;
                let Some(video) = st.videos.get(&id).cloned() else { continue };
                let Some(url) = video.webpage_url().map(str::to_string) else {
                    report.failed += 1;
                    mark(&id, download_state::FAILED, Some("Nessun URL registrato."))?;
                    continue;
                };
                if !try_claim(&id)? {
                    report.skipped += 1;
                    reporter.log(&format!("↷ {id}: già in corso altrove, salto."));
                    continue;
                }
                remove_from_download_archive(&paths, &id)?;
                reporter.log(&format!("▶ {} — {}", video.display_title(), id));
                let _ = job_tx.send((prossimo, id, url));
                inviati += 1;
            }

            if inviati == ricevuti {
                break; // niente in volo e niente da inviare
            }

            match res_rx.recv() {
                Ok((_, id, outcome)) => {
                    ricevuti += 1;
                    apply_outcome(&id, outcome, report, reporter)?;
                    let fatti = report.downloaded + report.failed + report.removed;
                    reporter.progress((fatti as f64 / total.max(1) as f64) * 100.0);
                }
                Err(_) => break,
            }

            if reporter.cancelled() {
                reporter.log("Interrotto: i download già avviati vengono lasciati finire.");
                break;
            }
        }

        drop(job_tx); // fa uscire i worker dal loop
        Ok(())
    })
}

/// Reporter usato **dentro** un worker: silenzioso. Con N download insieme, mescolare
/// le righe di avanzamento di yt-dlp di tutti renderebbe l'output illeggibile; le
/// righe che contano (inizio e fine di ogni video) le stampa il thread principale.
struct SilentWorker;
impl Reporter for SilentWorker {
    fn log(&self, _line: &str) {}
    fn progress(&self, _percent: f64) {}
}

/// Scarica una lista **esplicita** di id, nell'ordine dato. Salta quelli già
/// scaricati. Col modello a flag ortogonali non esiste più una coda "pending" da
/// scansionare: si scarica esattamente ciò che è stato scelto.
///
/// Il numero di download simultanei viene da `download.parallel` in config; con `1`
/// si resta sul percorso sequenziale, che ha la barra di avanzamento per-video.
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
    let workers = crate::config::parallel_downloads()
        .unwrap_or(1)
        .min(candidates.len().max(1));

    if workers > 1 {
        reporter.log(&format!(
            "{} video da scaricare, {workers} alla volta.",
            candidates.len()
        ));
        let ids: Vec<String> = candidates.iter().map(|v| v.id().to_string()).collect();
        download_parallel(&ids, strategy, max_height, workers, reporter, &mut report)?;
        return finish_batch(report, ids.len(), ids, &started, reporter);
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

    finish_batch(report, ids.len(), ids.to_vec(), &started, reporter)
}

/// Chiusura comune al percorso sequenziale e a quello parallelo: riepilogo, foto dei
/// creator e registrazione nello storico.
fn finish_batch(
    mut report: DownloadReport,
    _total: usize,
    ids: Vec<String>,
    started: &str,
    reporter: &dyn Reporter,
) -> Result<DownloadReport> {
    reporter.log(&format!(
        "Completato: {} scaricati, {} falliti.",
        report.downloaded, report.failed
    ));

    // Chiude la catena: un video scaricato porta i metadati completi del canale, che
    // sono ciò che serve per andare a prendere la foto del creator. Farlo qui evita
    // che l'utente debba ricordarsi di un passaggio separato — e ripristina un
    // comportamento che il JavaScript aveva (`downloadSingleJob` chiudeva chiamando
    // `syncChannelAvatars`). Con `force:false` non costa nulla se non c'è nulla di nuovo.
    if report.downloaded > 0 {
        if let Ok(av) = crate::ops::maintain::sync_author_avatars(false, reporter) {
            if av.saved > 0 {
                reporter.log(&format!("✔ {} foto creator salvate.", av.saved));
            }
            report.avatars_saved = av.saved;
        }
    }

    runs::record(
        "download",
        json!({ "videoIds": ids }),
        report.failed == 0,
        json!({
            "downloaded": report.downloaded, "failed": report.failed,
            "removed": report.removed, "skipped": report.skipped, "total": report.total
        }),
        started,
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
    /// Foto dei creator prese a fine giro (vedi la nota in fondo a [`enrich`]).
    pub avatars: crate::ops::maintain::AvatarReport,
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

    // Foto dei creator, a fine giro. È l'arricchimento a portare l'URL del canale, e
    // senza quello l'autore non è interrogabile: farlo qui è l'unico momento in cui
    // l'informazione c'è già. Così un creator appena comparso ha la sua foto senza
    // che l'utente debba ricordarsi di un'azione separata.
    //
    // Ripristina un comportamento che l'implementazione JavaScript aveva
    // (`enrichSourceJob` chiudeva chiamando `syncChannelAvatars({force:false})`) e che
    // nel porting era andato perso. Con `force:false` il costo è quasi nullo quando
    // non c'è nulla di nuovo: gli autori che hanno già la foto vengono saltati senza
    // toccare la rete.
    if report.enriched > 0 {
        reporter.log("Foto dei creator…");
        report.avatars = crate::ops::maintain::sync_author_avatars(false, reporter).unwrap_or_default();
    }
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
