//! Coda di download **persistente**, che continua a lavorare mentre l'interfaccia
//! resta libera di ricevere nuovi link.
//!
//! Differenza rispetto a [`crate::ops::download::download_many`]: quella scarica un
//! lotto e ritorna quando ha finito, quindi blocca chi la chiama. Questa parte una
//! volta, resta viva, e si accodano lavori quando capita.
//!
//! ## Chi scrive lo stato
//!
//! ```text
//!  interfaccia          worker (×N)              applicatore (×1)
//!  ───────────          ───────────              ────────────────
//!  enqueue(ids)   →     rivendica
//!                       scarica (yt-dlp+ffmpeg)
//!                       manda il risultato   →    scrive metadati e catalogo
//!  snapshot()     ←     stato condiviso
//! ```
//!
//! Le scritture sullo stato restano su **un solo thread**, l'applicatore. I worker
//! non toccano il catalogo: chiamano il downloader, che è puro per costruzione, e
//! rimandano indietro i dati. Un solo scrittore, N lettori di rete — la stessa
//! proprietà del download in lotto, mantenuta anche qui.
//!
//! La rivendicazione fa eccezione ed è deliberata: sta sul worker, subito prima di
//! iniziare, perché è un'operazione atomica ed è ciò che impedisce a due worker (o a
//! due istanze del programma) di prendere lo stesso video. Rimandarla all'applicatore
//! significherebbe rivendicare dopo aver scaricato, cioè troppo tardi.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};

use crate::config::get_paths;
use crate::downloader::{download_video, AudioStrategy, Reporter};
use crate::library::files::remove_from_download_archive;
use crate::library::state;
use crate::ops::sources::{quick_download_target, QuickTarget};

/// A che punto è un video nella coda.
#[derive(Debug, Clone, PartialEq)]
pub enum JobState {
    Queued,
    /// Il worker ha rivendicato il video e ha lanciato yt-dlp, ma non è ancora
    /// arrivato il primo evento di avanzamento reale sui byte — yt-dlp in questa
    /// finestra sta ancora estraendo/negoziando i formati, non trasferendo dati.
    FetchingMetadata,
    Running { percent: f64 },
    Done,
    Failed { message: String },
    /// Preso da un'altra istanza, o già scaricato nel frattempo.
    Skipped,
}

#[derive(Debug, Clone)]
pub struct JobStatus {
    pub id: String,
    pub title: String,
    pub state: JobState,
    /// Titolo della playlist di provenienza, se il video è stato accodato come parte
    /// di una playlist invece che da un link diretto — permette all'interfaccia di
    /// mostrare voce (playlist) e sottovoce (video) invece di un elenco piatto.
    pub group: Option<String>,
}

struct Job {
    id: String,
    url: String,
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
}

/// Un link grezzo ancora da risolvere (chiamata a yt-dlp) prima di poter diventare
/// un [`Job`]. Tenerlo separato da `pending` è ciò che permette all'interfaccia di
/// accodare nuovi link **mentre** uno precedente sta ancora interrogando la rete.
#[derive(Clone)]
struct PendingLink {
    link: String,
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
}

/// A che punto è un link nella coda di risoluzione — stesso spirito di [`JobState`],
/// ma per la fase "non ancora un video" (prima che yt-dlp gli dia un id).
#[derive(Debug, Clone, PartialEq)]
pub enum LinkState {
    Queued,
    Resolving,
}

#[derive(Debug, Clone)]
pub struct LinkStatus {
    pub link: String,
    pub state: LinkState,
}

#[derive(Default)]
struct Shared {
    pending: VecDeque<Job>,
    statuses: Vec<JobStatus>,
    /// Quanti lavori sono stati presi da un worker e non ancora conclusi.
    in_flight: usize,
    /// Coda FIFO da cui i thread di risoluzione rivendicano il prossimo link.
    link_queue: VecDeque<PendingLink>,
    /// Stato di ogni link accodato, per l'interfaccia — stessa idea di `statuses`
    /// sopra: un elenco uniforme (tutti i link hanno la stessa forma), non un
    /// singolo "in corso" speciale più un conteggio degli altri.
    link_statuses: Vec<LinkStatus>,
    accodati: usize,
    gia_in_archivio: usize,
    non_risolti: usize,
    ultimo_errore: Option<String>,
}

/// Fotografia dello stato di risoluzione dei link, per l'interfaccia.
#[derive(Debug, Clone, Default)]
pub struct ResolveStatus {
    /// Link risolti **in parallelo** in questo momento (uno per thread di
    /// risoluzione libero — vedi `DownloadQueue::start`).
    pub risolvendo: Vec<String>,
    /// I link ancora in attesa di un thread libero, nell'ordine di arrivo.
    pub in_coda: Vec<String>,
    pub accodati: usize,
    pub gia_in_archivio: usize,
    pub non_risolti: usize,
    pub ultimo_errore: Option<String>,
}

pub struct DownloadQueue {
    shared: Mutex<Shared>,
    /// Sveglia i worker quando arriva lavoro o quando si chiude.
    wake: Condvar,
    stopping: AtomicBool,
    workers: usize,
}

/// Riporta l'avanzamento nello stato condiviso invece che a schermo: a stampare ci
/// pensa l'interfaccia, leggendo lo snapshot quando vuole.
struct QueueReporter {
    queue: Arc<DownloadQueue>,
    id: String,
}

impl Reporter for QueueReporter {
    fn log(&self, _line: &str) {}
    fn progress(&self, percent: f64) {
        self.queue.set_state(&self.id, JobState::Running { percent });
    }
    fn cancelled(&self) -> bool {
        self.queue.stopping.load(Ordering::Relaxed)
    }
}

impl DownloadQueue {
    /// Avvia i worker e l'applicatore. La coda resta viva finché c'è un `Arc` in giro
    /// e non le si chiede di fermarsi.
    pub fn start(workers: usize) -> Arc<Self> {
        let queue = Arc::new(DownloadQueue {
            shared: Mutex::new(Shared::default()),
            wake: Condvar::new(),
            stopping: AtomicBool::new(false),
            workers: workers.max(1),
        });

        let (tx, rx) = mpsc::channel::<(String, crate::error::Result<crate::downloader::Extracted>)>();

        for _ in 0..queue.workers {
            let q = Arc::clone(&queue);
            let tx = tx.clone();
            std::thread::spawn(move || q.work(tx));
        }
        drop(tx);

        // L'applicatore: unico thread che scrive sul catalogo.
        let q = Arc::clone(&queue);
        std::thread::spawn(move || {
            for (id, outcome) in rx {
                let stato = match crate::ops::download::apply_queue_outcome(&id, outcome) {
                    Ok(true) => JobState::Done,
                    Ok(false) => JobState::Failed { message: "non più disponibile".into() },
                    Err(e) => JobState::Failed { message: e.message },
                };
                q.set_state(&id, stato);
                q.finish_one();
            }
        });

        // I risolutori: tanti thread quanti i download paralleli configurati (stesso
        // numero, stesso senso: se scarichi 3 alla volta, ha senso risolvere 3 link
        // alla volta invece di farli fare la fila dietro a uno solo). Lavorano su una
        // coda diversa (`link_queue`, non `pending`) e non toccano mai il file system.
        for _ in 0..queue.workers {
            let q = Arc::clone(&queue);
            std::thread::spawn(move || q.resolve_worker());
        }

        queue
    }

    fn resolve_worker(self: Arc<Self>) {
        loop {
            let item = {
                let mut shared = self.shared.lock().unwrap();
                loop {
                    if self.stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Some(item) = shared.link_queue.pop_front() {
                        if let Some(s) =
                            shared.link_statuses.iter_mut().find(|s| s.link == item.link && s.state == LinkState::Queued)
                        {
                            s.state = LinkState::Resolving;
                        }
                        break item;
                    }
                    shared = self.wake.wait(shared).unwrap();
                }
            };

            let esito = quick_download_target(&item.link);
            {
                let mut shared = self.shared.lock().unwrap();
                if let Some(pos) = shared
                    .link_statuses
                    .iter()
                    .position(|s| s.link == item.link && s.state == LinkState::Resolving)
                {
                    shared.link_statuses.remove(pos);
                }
            }

            match esito {
                Ok(QuickTarget::Video { id, .. }) => {
                    let n = self.enqueue(&[id], item.strategy, item.max_height, None);
                    self.shared.lock().unwrap().accodati += n;
                }
                Ok(QuickTarget::Playlist { title, ids, .. }) => {
                    let n = self.enqueue(&ids, item.strategy, item.max_height, Some(title));
                    self.shared.lock().unwrap().accodati += n;
                }
                Ok(QuickTarget::AlreadyDownloaded { .. }) => {
                    self.shared.lock().unwrap().gia_in_archivio += 1;
                }
                Err(e) => {
                    let mut shared = self.shared.lock().unwrap();
                    shared.non_risolti += 1;
                    shared.ultimo_errore = Some(e.message);
                }
            }
        }
    }

    /// Accoda link grezzi da risolvere **in background**: ritorna subito, non blocca
    /// chi chiama. I thread di risoluzione li prendono in carico in parallelo (uno
    /// ciascuno) e li accodano mano a mano — è quello che permette di incollare altri
    /// link mentre altri stanno ancora aspettando risposta dalla rete.
    pub fn enqueue_links(&self, links: &[String], strategy: AudioStrategy, max_height: Option<Option<u64>>) {
        let mut shared = self.shared.lock().unwrap();
        for link in links {
            shared.link_queue.push_back(PendingLink { link: link.clone(), strategy, max_height });
            shared.link_statuses.push(LinkStatus { link: link.clone(), state: LinkState::Queued });
        }
        drop(shared);
        self.wake.notify_all();
    }

    /// Fotografia dello stato di risoluzione, per disegnare lo spinner e il riepilogo.
    pub fn resolve_status(&self) -> ResolveStatus {
        let shared = self.shared.lock().unwrap();
        let (risolvendo, in_coda) = shared
            .link_statuses
            .iter()
            .partition::<Vec<_>, _>(|s| s.state == LinkState::Resolving);
        ResolveStatus {
            risolvendo: risolvendo.into_iter().map(|s| s.link.clone()).collect(),
            in_coda: in_coda.into_iter().map(|s| s.link.clone()).collect(),
            accodati: shared.accodati,
            gia_in_archivio: shared.gia_in_archivio,
            non_risolti: shared.non_risolti,
            ultimo_errore: shared.ultimo_errore.clone(),
        }
    }

    fn work(self: Arc<Self>, tx: mpsc::Sender<(String, crate::error::Result<crate::downloader::Extracted>)>) {
        loop {
            let job = {
                let mut shared = self.shared.lock().unwrap();
                loop {
                    if self.stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Some(job) = shared.pending.pop_front() {
                        shared.in_flight += 1;
                        break job;
                    }
                    shared = self.wake.wait(shared).unwrap();
                }
            };

            // Rivendicazione: sta qui e non nell'applicatore perché deve avvenire
            // PRIMA del download, non dopo.
            match crate::ops::download::claim_for_queue(&job.id) {
                Ok(true) => {}
                _ => {
                    self.set_state(&job.id, JobState::Skipped);
                    self.finish_one();
                    continue;
                }
            }
            if let Ok(paths) = get_paths() {
                let _ = remove_from_download_archive(&paths, &job.id);
            }

            // "Scarico metadati": finché non arriva il primo avanzamento reale sui
            // byte (vedi `QueueReporter::progress`), yt-dlp sta ancora estraendo
            // formati/metadati, non trasferendo il video.
            self.set_state(&job.id, JobState::FetchingMetadata);
            let reporter = QueueReporter { queue: Arc::clone(&self), id: job.id.clone() };
            let outcome = download_video(&job.id, &job.url, job.strategy, job.max_height, &reporter);

            if tx.send((job.id.clone(), outcome)).is_err() {
                return;
            }
        }
    }

    fn set_state(&self, id: &str, state: JobState) {
        let mut shared = self.shared.lock().unwrap();
        if let Some(s) = shared.statuses.iter_mut().find(|s| s.id == id) {
            s.state = state;
        }
    }

    fn finish_one(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.in_flight = shared.in_flight.saturating_sub(1);
    }

    /// Accoda dei video. Quelli già presenti nella coda (in attesa o in corso) non
    /// vengono aggiunti due volte. `group` è il titolo della playlist di provenienza
    /// quando `ids` arrivano da una playlist risolta in un colpo solo — `None` per un
    /// link a un singolo video.
    pub fn enqueue(
        &self,
        ids: &[String],
        strategy: AudioStrategy,
        max_height: Option<Option<u64>>,
        group: Option<String>,
    ) -> usize {
        let Ok(st) = state::read() else { return 0 };
        let mut aggiunti = 0;
        let mut shared = self.shared.lock().unwrap();

        for id in ids {
            let gia = shared.statuses.iter().any(|s| {
                s.id == *id && !matches!(s.state, JobState::Failed { .. } | JobState::Skipped)
            });
            if gia {
                continue;
            }
            let Some(video) = st.videos.get(id) else { continue };
            let Some(url) = video.webpage_url().map(str::to_string) else { continue };

            shared.statuses.retain(|s| s.id != *id);
            shared.statuses.push(JobStatus {
                id: id.clone(),
                title: video.display_title(),
                state: JobState::Queued,
                group: group.clone(),
            });
            shared.pending.push_back(Job {
                id: id.clone(),
                url,
                strategy,
                max_height,
            });
            aggiunti += 1;
        }

        drop(shared);
        self.wake.notify_all();
        aggiunti
    }

    /// Fotografia dello stato, dal più recente. L'interfaccia la ridisegna quando vuole.
    pub fn snapshot(&self) -> Vec<JobStatus> {
        let shared = self.shared.lock().unwrap();
        shared.statuses.iter().rev().cloned().collect()
    }

    /// Quanti lavori sono in attesa o in corso.
    pub fn outstanding(&self) -> usize {
        let shared = self.shared.lock().unwrap();
        shared.pending.len() + shared.in_flight
    }

    /// Toglie dall'elenco i lavori conclusi, per non farlo crescere all'infinito.
    pub fn clear_finished(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared
            .statuses
            .retain(|s| matches!(s.state, JobState::Queued | JobState::FetchingMetadata | JobState::Running { .. }));
    }

    /// Chiede ai worker di fermarsi. Quelli già dentro un download **finiscono**: un
    /// video troncato a metà sarebbe peggio di attendere qualche secondo.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_queue_has_nothing_outstanding() {
        let q = DownloadQueue::start(2);
        assert_eq!(q.outstanding(), 0);
        assert!(q.snapshot().is_empty());
        q.stop();
    }

    #[test]
    fn enqueueing_unknown_ids_adds_nothing() {
        // Non esistono nel catalogo: non devono comparire come lavori fantasma.
        let q = DownloadQueue::start(1);
        assert_eq!(q.enqueue(&["non-esiste".into()], AudioStrategy::Auto, None, None), 0);
        assert!(q.snapshot().is_empty());
        q.stop();
    }

    #[test]
    fn finished_jobs_can_be_cleared_but_running_ones_stay() {
        let q = DownloadQueue::start(1);
        {
            let mut s = q.shared.lock().unwrap();
            s.statuses.push(JobStatus { id: "a".into(), title: "A".into(), state: JobState::Done, group: None });
            s.statuses.push(JobStatus { id: "b".into(), title: "B".into(), state: JobState::Running { percent: 50.0 }, group: None });
            s.statuses.push(JobStatus { id: "c".into(), title: "C".into(), state: JobState::Failed { message: "x".into() }, group: None });
            s.statuses.push(JobStatus { id: "d".into(), title: "D".into(), state: JobState::Queued, group: None });
        }
        q.clear_finished();
        let rimasti: Vec<String> = q.snapshot().iter().map(|s| s.id.clone()).collect();
        assert_eq!(rimasti.len(), 2, "restano solo in coda e in corso: {rimasti:?}");
        assert!(rimasti.contains(&"b".to_string()) && rimasti.contains(&"d".to_string()));
        q.stop();
    }

    #[test]
    fn the_snapshot_is_newest_first() {
        let q = DownloadQueue::start(1);
        {
            let mut s = q.shared.lock().unwrap();
            for id in ["primo", "secondo", "terzo"] {
                s.statuses.push(JobStatus { id: id.into(), title: id.into(), state: JobState::Queued, group: None });
            }
        }
        let ids: Vec<String> = q.snapshot().iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids, vec!["terzo", "secondo", "primo"]);
        q.stop();
    }

    #[test]
    fn a_group_label_is_attached_to_every_member_pushed_together() {
        let q = DownloadQueue::start(1);
        {
            let mut s = q.shared.lock().unwrap();
            for id in ["a", "b"] {
                s.statuses.push(JobStatus {
                    id: id.into(),
                    title: id.into(),
                    state: JobState::Queued,
                    group: Some("Playlist X".into()),
                });
            }
            s.statuses.push(JobStatus { id: "c".into(), title: "c".into(), state: JobState::Queued, group: None });
        }
        let snap = q.snapshot();
        assert_eq!(snap.iter().filter(|s| s.group.as_deref() == Some("Playlist X")).count(), 2);
        assert!(snap.iter().find(|s| s.id == "c").unwrap().group.is_none());
        q.stop();
    }
}
