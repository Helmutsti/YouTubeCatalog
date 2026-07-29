//! Il pool di sentinel: si tiene in piedi, accetta link mentre lavora, e non
//! blocca mai chi lo usa.
//!
//! È questo che permette a un'interfaccia di restare viva — prompt attivo, barre
//! che si muovono — mentre i download vanno. Chi chiama fa `push`, poi raccoglie
//! gli aggiornamenti con `try_recv`/`recv_timeout` dentro il proprio ciclo di
//! ridisegno, e li passa a [`crate::Library::apply`], che è l'unico posto dove lo
//! stato viene mutato.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::config::Config;
use crate::sentinel::{self, Event, Phase};

/// A che punto è un job, **secondo il pool**.
///
/// Esiste perché un'interfaccia non deve tenere il conto da sé: gli eventi si
/// consumano una volta sola, quindi chi si ricostruisce lo stato dagli eventi lo
/// perde appena chiude la schermata. Qui invece lo stato sta dove sanno le cose —
/// nel pool — e si rilegge quando serve con [`Downloader::statuses`].
#[derive(Debug, Clone)]
pub struct JobStatus {
    pub job: u64,
    pub url: String,
    /// L'id del video, appena risolto.
    pub id: Option<String>,
    /// `autore — titolo`, appena risolto.
    pub title: String,
    /// `None` = ancora in coda, nessun sentinel partito.
    pub phase: Option<Phase>,
    pub percent: Option<f64>,
    /// Un sentinel ci sta lavorando (o ci ha lavorato).
    pub started: bool,
    pub done: bool,
    pub error: Option<String>,
    /// Il tetto di risoluzione scelto per questo download (`None` = massima).
    pub max_height: Option<u32>,
}

impl JobStatus {
    /// Né finito né fallito: c'è ancora qualcosa in movimento.
    pub fn active(&self) -> bool {
        !self.done && self.error.is_none()
    }
}

/// Un evento, con l'indicazione di quale link l'ha prodotto.
#[derive(Debug, Clone)]
pub struct Update {
    /// Numero del job, quello restituito da [`Downloader::push`]: è così che si
    /// tengono distinte N barre di avanzamento in parallelo.
    pub job: u64,
    pub url: String,
    /// L'id del video, appena la risoluzione l'ha reso noto.
    pub id: Option<String>,
    pub event: Event,
}

impl Update {
    /// Se questo aggiornamento chiude il job. Ogni job ne produce **esattamente
    /// uno**: `done` oppure `error`, mai entrambi, mai nessuno.
    pub fn is_terminal(&self) -> bool {
        matches!(self.event, Event::Done { .. } | Event::Error { .. })
    }
}

struct Job {
    id: u64,
    url: String,
    /// Deciso quando il link è stato accodato: la qualità può essere chiesta link
    /// per link, quindi non si può rileggere dalla config al momento del download.
    max_height: Option<u32>,
}

struct Inner {
    jobs: VecDeque<Job>,
    closed: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    /// I worker dormono qui quando non c'è niente da fare.
    ready: Condvar,
    cancel: AtomicBool,
    in_flight: AtomicUsize,
    /// Quanti worker si vogliono, e quanti ce ne sono. Quando i vivi sono più dei
    /// voluti, quelli in eccesso si congedano da sé appena finiscono il loro job:
    /// è così che si può ridurre il parallelismo senza interrompere un download.
    target: AtomicUsize,
    live: AtomicUsize,
    /// Lo stato di ogni job di questa sessione, quello che [`Downloader::statuses`]
    /// restituisce. Sta in un lock a parte da `inner` perché lo si legge a ogni
    /// ridisegno, mentre `inner` lo toccano solo i worker che prendono un job.
    status: Mutex<BTreeMap<u64, JobStatus>>,
}

impl Shared {
    /// Vero se questo worker è di troppo e deve andarsene. Il posto viene liberato
    /// qui dentro, una volta sola, così due worker non se lo prendono a vicenda.
    fn retire_if_excess(&self) -> bool {
        loop {
            let live = self.live.load(Ordering::Relaxed);
            if live <= self.target.load(Ordering::Relaxed) {
                return false;
            }
            if self
                .live
                .compare_exchange(live, live - 1, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return true;
            }
        }
    }

    /// Aggiorna lo stato di un job. Va fatto **prima** di spedire l'evento
    /// corrispondente: chi si sveglia sull'evento e poi rilegge gli stati non deve
    /// vedere una fotografia più vecchia dell'evento che l'ha svegliato.
    fn touch(&self, job: u64, change: impl FnOnce(&mut JobStatus)) {
        let mut map = self.status.lock().unwrap();
        if let Some(s) = map.get_mut(&job) {
            change(s);
        }
        // Uno storico di sessione non deve crescere per sempre: i job chiusi più
        // vecchi si buttano, quelli attivi mai.
        if map.len() > 200 {
            let vecchi: Vec<u64> = map
                .iter()
                .filter(|(_, s)| !s.active())
                .map(|(k, _)| *k)
                .take(map.len() - 200)
                .collect();
            for k in vecchi {
                map.remove(&k);
            }
        }
    }
}

/// Il pool. Vive quanto serve; si chiude con [`Downloader::shutdown`] (aspetta) o
/// [`Downloader::shutdown_now`] (interrompe).
pub struct Downloader {
    shared: Arc<Shared>,
    updates: Receiver<Update>,
    /// Serve per far nascere altri worker quando si alza il parallelismo. Tenerlo
    /// vivo significa che il canale non si chiude mai da sé: qui non importa,
    /// perché chi ascolta conta gli eventi terminali, non aspetta la chiusura.
    tx: Sender<Update>,
    config: Config,
    handles: Vec<JoinHandle<()>>,
    next_job: u64,
    /// Il tetto da usare per chi accoda senza dire niente: quello della config al
    /// momento dell'avvio.
    default_max_height: Option<u32>,
}

impl Downloader {
    /// Avvia `config.parallel` worker. Partono subito, e stanno in attesa.
    pub fn start(config: &Config) -> Downloader {
        let quanti = config.parallel.max(1);
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner { jobs: VecDeque::new(), closed: false }),
            ready: Condvar::new(),
            cancel: AtomicBool::new(false),
            in_flight: AtomicUsize::new(0),
            target: AtomicUsize::new(quanti),
            live: AtomicUsize::new(quanti),
            status: Mutex::new(BTreeMap::new()),
        });
        let (tx, updates) = mpsc::channel::<Update>();
        let handles = (0..quanti)
            .map(|_| spawn_worker(config.clone(), Arc::clone(&shared), tx.clone()))
            .collect();
        Downloader {
            shared,
            updates,
            tx,
            config: config.clone(),
            handles,
            next_job: 1,
            default_max_height: config.quality.max_height(),
        }
    }

    /// Quanti download insieme, adesso.
    pub fn parallel(&self) -> usize {
        self.shared.target.load(Ordering::Relaxed)
    }

    /// Cambia il parallelismo **a caldo**.
    ///
    /// Alzarlo fa nascere subito altri worker. Abbassarlo non interrompe niente: i
    /// worker di troppo si congedano quando hanno finito il download che hanno per
    /// le mani, quindi per un po' possono essercene più del voluto.
    pub fn set_parallel(&mut self, quanti: usize) {
        let quanti = quanti.max(1);
        self.shared.target.store(quanti, Ordering::Relaxed);
        while self.shared.live.load(Ordering::Relaxed) < quanti {
            self.shared.live.fetch_add(1, Ordering::Relaxed);
            self.handles.push(spawn_worker(
                self.config.clone(),
                Arc::clone(&self.shared),
                self.tx.clone(),
            ));
        }
        // Sveglia chi dorme: chi è di troppo se ne accorge e se ne va.
        self.shared.ready.notify_all();
        self.handles.retain(|h| !h.is_finished());
    }

    /// Accoda un link con la qualità predefinita della config. Ritorna il numero
    /// del job, che comparirà in ogni [`Update`] che lo riguarda.
    pub fn push(&mut self, url: impl Into<String>) -> u64 {
        let max_height = self.default_max_height;
        self.push_with(url, max_height)
    }

    /// Accoda un link con un tetto di risoluzione deciso per **questo** download
    /// (`None` = la migliore disponibile). È la forma da usare quando la qualità si
    /// chiede volta per volta.
    pub fn push_with(&mut self, url: impl Into<String>, max_height: Option<u32>) -> u64 {
        let job = self.next_job;
        self.next_job += 1;
        let url = url.into();
        self.shared.status.lock().unwrap().insert(
            job,
            JobStatus {
                job,
                url: url.clone(),
                id: None,
                title: String::new(),
                phase: None,
                percent: None,
                started: false,
                done: false,
                error: None,
                max_height,
            },
        );
        let mut inner = self.shared.inner.lock().unwrap();
        inner.jobs.push_back(Job { id: job, url, max_height });
        drop(inner);
        self.shared.ready.notify_one();
        job
    }

    /// Lo stato di tutti i job di questa sessione, dal primo all'ultimo.
    ///
    /// È qui che un'interfaccia ripesca l'avanzamento quando torna su una
    /// schermata: non c'è niente da ricordare fuori dal pool, quindi non c'è
    /// niente da perdere andandosene.
    pub fn statuses(&self) -> Vec<JobStatus> {
        self.shared.status.lock().unwrap().values().cloned().collect()
    }

    /// Solo i job che stanno ancora andando (in coda o in corso).
    pub fn active(&self) -> Vec<JobStatus> {
        self.shared
            .status
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.active())
            .cloned()
            .collect()
    }

    /// Un aggiornamento se ce n'è, senza aspettare.
    pub fn try_recv(&self) -> Option<Update> {
        self.updates.try_recv().ok()
    }

    /// Un aggiornamento, aspettando al massimo `timeout`. È la forma comoda per un
    /// ciclo di ridisegno: si aspetta un po', si ridisegna, si ricomincia.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Update> {
        self.updates.recv_timeout(timeout).ok()
    }

    /// Link in attesa di un worker libero.
    pub fn queued(&self) -> usize {
        self.shared.inner.lock().unwrap().jobs.len()
    }

    /// Download in corso adesso.
    pub fn in_flight(&self) -> usize {
        self.shared.in_flight.load(Ordering::Relaxed)
    }

    pub fn busy(&self) -> bool {
        self.in_flight() > 0 || self.queued() > 0
    }

    /// Chiude la coda e aspetta che i download in corso finiscano.
    pub fn shutdown(mut self) {
        self.close();
        self.join();
    }

    /// Chiude e **interrompe**: la coda si svuota e i sentinel in corso vengono
    /// uccisi. Il loro yt-dlp se ne accorge subito dopo, perché si ritrova a
    /// scrivere in una pipe senza nessuno all'altro capo.
    pub fn shutdown_now(mut self) {
        self.shared.cancel.store(true, Ordering::Relaxed);
        self.clear();
        self.close();
        self.join();
    }

    fn clear(&self) {
        self.shared.inner.lock().unwrap().jobs.clear();
    }

    fn close(&self) {
        self.shared.inner.lock().unwrap().closed = true;
        self.shared.ready.notify_all();
    }

    fn join(&mut self) {
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for Downloader {
    /// Un pool lasciato cadere interrompe, non aspetta: restare bloccati per
    /// minuti dentro un `drop` implicito sarebbe peggio di un download perso —
    /// yt-dlp riprende i file parziali, quindi non si butta via nulla di
    /// definitivo. Per aspettare davvero, chiama [`Downloader::shutdown`].
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::Relaxed);
        self.clear();
        self.close();
        self.join();
    }
}

fn spawn_worker(cfg: Config, shared: Arc<Shared>, tx: Sender<Update>) -> JoinHandle<()> {
    std::thread::spawn(move || worker(cfg, shared, tx))
}

fn worker(cfg: Config, shared: Arc<Shared>, tx: Sender<Update>) {
    loop {
        // Prendere un job: si dorme sulla Condvar finché non ce n'è uno, finché la
        // coda non viene chiusa, o finché non si scopre di essere di troppo.
        let job = {
            let mut inner = shared.inner.lock().unwrap();
            loop {
                if shared.retire_if_excess() {
                    return;
                }
                if let Some(job) = inner.jobs.pop_front() {
                    break Some(job);
                }
                if inner.closed {
                    break None;
                }
                inner = shared.ready.wait(inner).unwrap();
            }
        };
        let Some(Job { id: job, url, max_height }) = job else {
            shared.live.fetch_sub(1, Ordering::Relaxed);
            break;
        };
        if shared.cancel.load(Ordering::Relaxed) {
            continue;
        }

        shared.in_flight.fetch_add(1, Ordering::Relaxed);
        shared.touch(job, |s| s.started = true);
        let staging = cfg.staging_dir().join(format!("job-{job}"));
        // Residui di un giro precedente interrotto darebbero file vecchi da
        // organizzare: si parte da pulito.
        let _ = std::fs::remove_dir_all(&staging);

        let mut video_id: Option<String> = None;
        let mut terminal = false;
        // `catch_unwind` è ciò che rimpiazza il vecchio confine di processo: un
        // panic dentro un sentinel diventa **un download fallito**, non un worker
        // che scompare lasciando il suo posto occupato per sempre.
        let esito = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sentinel::run(&cfg, &url, &staging, max_height, &shared.cancel, |event| {
                if let Event::Resolved { id, .. } = &event {
                    video_id = Some(id.clone());
                }
                record(&shared, job, &event);
                if matches!(event, Event::Done { .. } | Event::Error { .. }) && !terminal {
                    terminal = true;
                    // Il conteggio cala **prima** di spedire l'evento finale: chi lo
                    // riceve deve poter chiedere `busy()` e avere una risposta vera,
                    // non una che diventa vera un istante dopo.
                    shared.in_flight.fetch_sub(1, Ordering::Relaxed);
                }
                let _ = tx.send(Update { job, url: url.clone(), id: video_id.clone(), event });
            })
        }));
        let result = match esito {
            Ok(result) => result,
            Err(_) => Err(crate::Error::new(
                "il sentinel è andato in panic: è un difetto nostro, non del video".to_string(),
            )),
        };

        // Ogni job deve chiudersi con un evento terminale, anche quando il
        // fallimento è di quelli che il sentinel non ha potuto dichiarare (yt-dlp
        // non si è avviato, il thread è morto a metà). Chi ascolta non deve avere
        // casi speciali.
        if let Err(e) = &result {
            if !terminal {
                shared.in_flight.fetch_sub(1, Ordering::Relaxed);
                record(&shared, job, &Event::Error { message: e.0.clone() });
                let _ = tx.send(Update {
                    job,
                    url: url.clone(),
                    id: video_id.clone(),
                    event: Event::Error { message: e.0.clone() },
                });
            }
            // Quando è andata bene lo staging lo svuota chi sposta i file
            // (`Library::apply`): qui i file servono ancora.
            let _ = std::fs::remove_dir_all(&staging);
        }
    }
}

/// Annota nello stato del job ciò che l'evento dice. È il duplicato *voluto* di
/// quello che un'interfaccia disegnerebbe: sta qui perché così l'interfaccia non
/// deve ricordare niente.
fn record(shared: &Shared, job: u64, event: &Event) {
    shared.touch(job, |s| match event {
        Event::Phase { phase } => {
            s.phase = Some(*phase);
            s.percent = None;
        }
        Event::Resolved { id, title, author, .. } => {
            s.id = Some(id.clone());
            s.title = format!("{author} — {title}");
        }
        Event::Progress { percent } => s.percent = Some(*percent),
        Event::Done { .. } => {
            s.done = true;
            s.percent = Some(100.0);
        }
        Event::Error { message } => s.error = Some(message.clone()),
        Event::Log { .. } | Event::Metadata { .. } | Event::Cover { .. } => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un pool con un sentinel che non esiste: ogni job deve comunque chiudersi
    /// con un errore, e nessun thread deve restare appeso.
    #[test]
    fn every_job_ends_even_when_the_sentinel_is_missing() {
        let mut cfg = Config::for_root(std::env::temp_dir().join("ondo-dl-test"));
        cfg.ytdlp = std::path::PathBuf::from("questo-binario-non-esiste-davvero");
        cfg.parallel = 2;

        let mut dl = Downloader::start(&cfg);
        dl.push("https://esempio/uno");
        dl.push("https://esempio/due");

        let mut terminali = 0;
        while terminali < 2 {
            if let Some(u) = dl.recv_timeout(Duration::from_secs(5)) {
                if u.is_terminal() {
                    assert!(matches!(u.event, Event::Error { .. }));
                    terminali += 1;
                }
            } else {
                panic!("il pool non ha chiuso i job");
            }
        }
        assert!(!dl.busy());
        dl.shutdown();
    }

    /// Il parallelismo si cambia a caldo, in entrambe le direzioni, e i job
    /// continuano a chiudersi tutti.
    #[test]
    fn parallelism_changes_hot_without_losing_jobs() {
        let mut cfg = Config::for_root(std::env::temp_dir().join("ondo-par-test"));
        cfg.ytdlp = std::path::PathBuf::from("questo-binario-non-esiste-davvero");
        cfg.parallel = 1;
        let mut dl = Downloader::start(&cfg);
        assert_eq!(dl.parallel(), 1);

        dl.set_parallel(4);
        assert_eq!(dl.parallel(), 4);
        for i in 0..4 {
            dl.push(format!("https://esempio/{i}"));
        }
        attendi(&dl, 4);

        // Scendere non perde i job successivi: chi è di troppo si congeda, gli altri
        // continuano a lavorare.
        dl.set_parallel(1);
        assert_eq!(dl.parallel(), 1);
        for i in 4..7 {
            dl.push(format!("https://esempio/{i}"));
        }
        attendi(&dl, 3);
        assert_eq!(dl.statuses().len(), 7, "tutti e sette hanno lasciato traccia");
        dl.shutdown();
    }

    fn attendi(dl: &Downloader, quanti: usize) {
        let mut chiusi = 0;
        while chiusi < quanti {
            match dl.recv_timeout(Duration::from_secs(5)) {
                Some(u) if u.is_terminal() => chiusi += 1,
                Some(_) => {}
                None => panic!("il pool non ha chiuso {quanti} job (chiusi: {chiusi})"),
            }
        }
    }

    /// Il bug per cui questo stato esiste: un'interfaccia che si ricostruiva le
    /// righe dagli eventi le perdeva uscendo dalla schermata, perché un evento si
    /// consuma una volta sola. Rileggendo il pool, invece, non c'è niente da
    /// perdere: lo stato è suo, e resta anche a job chiuso.
    #[test]
    fn the_state_survives_whoever_is_watching() {
        let mut cfg = Config::for_root(std::env::temp_dir().join("ondo-status-test"));
        cfg.ytdlp = std::path::PathBuf::from("questo-binario-non-esiste-davvero");
        cfg.parallel = 1;
        let mut dl = Downloader::start(&cfg);

        let job = dl.push("https://esempio/uno");
        // Appena accodato, prima che qualunque worker lo prenda, il job si vede già.
        let subito = dl.statuses();
        assert_eq!(subito.len(), 1);
        assert_eq!(subito[0].job, job);
        assert_eq!(subito[0].url, "https://esempio/uno");
        assert!(subito[0].active());

        while dl.busy() {
            let _ = dl.recv_timeout(Duration::from_secs(5));
        }
        // Gli eventi sono stati consumati (o buttati): lo stato no.
        while dl.try_recv().is_some() {}
        let dopo = dl.statuses();
        assert_eq!(dopo.len(), 1, "il job chiuso resta visibile");
        assert!(dopo[0].error.is_some(), "col suo motivo");
        assert!(!dopo[0].active());
        assert!(dl.active().is_empty());
        dl.shutdown();
    }
}
