//! # Ondo
//!
//! Una sola libreria per gestire la libreria video. Si apre su una cartella, e da
//! quel momento tutto passa da qui: scaricare, elencare, cercare, riprodurre.
//!
//! ```no_run
//! let mut lib = ondo::Library::open("ondo-data")?;
//! lib.download(&["https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()], |u| {
//!     println!("{:?}", u.event);
//! });
//! for v in lib.list(ondo::Filter::All) {
//!     println!("{} — {}", v.author, v.title);
//! }
//! # Ok::<(), ondo::Error>(())
//! ```
//!
//! I download li fa un processo a parte, il **sentinel**, uno per video, lanciato
//! più volte in parallelo. Il sentinel non scrive lo stato: riferisce. È la
//! libreria che, a `done`, organizza i file e salva. Per un'interfaccia che deve
//! restare viva mentre i download vanno, vedi [`Downloader`] e [`Library::apply`].
//! Il disegno completo sta in `ARCHITETTURA.md`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub mod config;
pub mod downloader;
pub mod error;
pub mod model;
pub mod organize;
pub mod playback;
pub mod probe;
pub mod search;
pub mod sentinel;
pub mod store;

pub use config::{Config, Quality};
pub use downloader::{Downloader, JobStatus, Update};
pub use error::{Error, Result};
pub use model::{State, Video};
pub use playback::Mode;
pub use sentinel::{Event, Finished, Phase};
pub use store::{LibraryFile, QueuedLink};

/// Le viste della libreria. Sono filtri su campi già presenti: nessun elenco
/// separato da tenere allineato.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Tutto tranne gli archiviati: archiviare serve appunto a togliere di mezzo.
    All,
    Downloaded,
    /// Risolti ma non ancora sul disco.
    Pending,
    Failed,
    Favorites,
    Archived,
    /// Non più disponibili alla fonte. **Nessuno lo imposta ancora**: come
    /// accorgersene è una decisione rimandata (vedi `ARCHITETTURA.md`).
    Removed,
}

impl Filter {
    pub fn label(self) -> &'static str {
        match self {
            Filter::All => "tutti i video",
            Filter::Downloaded => "scaricati",
            Filter::Pending => "da scaricare",
            Filter::Failed => "falliti",
            Filter::Favorites => "preferiti",
            Filter::Archived => "archiviati",
            Filter::Removed => "rimossi da YouTube",
        }
    }

    fn matches(self, v: &Video) -> bool {
        match self {
            Filter::All => !v.archived,
            Filter::Downloaded => v.state == State::Downloaded && !v.archived,
            Filter::Pending => matches!(v.state, State::Pending | State::Downloading),
            Filter::Failed => v.state == State::Failed,
            Filter::Favorites => v.favorite,
            Filter::Archived => v.archived,
            Filter::Removed => v.removed,
        }
    }
}

/// Com'è finito un link.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub url: String,
    /// L'id del video entrato in libreria, se ce l'ha fatta.
    pub id: Option<String>,
    pub error: Option<String>,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.error.is_none()
    }
}

/// La libreria: lo stato in memoria e la cartella su disco che lo rispecchia.
pub struct Library {
    config: Config,
    file: LibraryFile,
}

impl Library {
    /// Apre (o crea) la libreria in `root`, leggendo `config.json` se c'è. Una
    /// cartella vuota è una libreria vuota.
    pub fn open(root: impl AsRef<Path>) -> Result<Library> {
        Library::with_config(Config::load(root)?)
    }

    /// Come [`Library::open`], ma con la configurazione decisa da chi chiama.
    pub fn with_config(config: Config) -> Result<Library> {
        std::fs::create_dir_all(&config.root)?;
        let mut file = store::load(&config.library_file())?;
        // Un `downloading` trovato all'apertura vuol dire che il processo è morto
        // mentre scaricava: non c'è nessun sentinel dietro, torna in coda.
        let mut healed = false;
        for v in file.videos.values_mut() {
            if v.state == State::Downloading {
                v.state = State::Pending;
                healed = true;
            }
        }
        let lib = Library { config, file };
        if healed {
            lib.save()?;
        }
        Ok(lib)
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Per cambiare le impostazioni. Ricordarsi [`Library::save_config`].
    pub fn config_mut(&mut self) -> &mut Config {
        &mut self.config
    }

    pub fn save_config(&self) -> Result<()> {
        self.config.save()
    }

    // ── Lettura ─────────────────────────────────────────────────────────────

    /// I video di una vista, **dall'ultimo pubblicato**. Chi non ha una data di
    /// pubblicazione va in fondo, ordinato per data di ingresso.
    pub fn list(&self, filter: Filter) -> Vec<&Video> {
        let mut all: Vec<&Video> = self.file.videos.values().filter(|v| filter.matches(v)).collect();
        all.sort_by(|a, b| {
            b.upload_date
                .cmp(&a.upload_date)
                .then_with(|| b.added_at.cmp(&a.added_at))
                .then_with(|| a.title.cmp(&b.title))
        });
        all
    }

    pub fn get(&self, id: &str) -> Option<&Video> {
        self.file.videos.get(id)
    }

    pub fn len(&self) -> usize {
        self.file.videos.len()
    }

    pub fn is_empty(&self) -> bool {
        self.file.videos.is_empty()
    }

    /// Quanti video ci sono in ciascuna vista: serve per mostrare i conteggi in un
    /// menu senza chiedere sette elenchi.
    pub fn count(&self, filter: Filter) -> usize {
        self.file.videos.values().filter(|v| filter.matches(v)).count()
    }

    /// I video che rispondono alla query, dal più pertinente. Cerca in tutta la
    /// libreria, archiviati compresi: si cerca proprio quando non si sa dov'è.
    pub fn search(&self, query: &str) -> Vec<&Video> {
        let terms = search::terms(query);
        let mut hits: Vec<(u32, &Video)> = self
            .file
            .videos
            .values()
            .filter_map(|v| search::score(v, &terms).map(|s| (s, v)))
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
        hits.into_iter().map(|(_, v)| v).collect()
    }

    /// Gli autori presenti, con quanti video ciascuno, in ordine alfabetico.
    pub fn authors(&self) -> Vec<(String, usize)> {
        let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
        for v in self.file.videos.values().filter(|v| !v.archived) {
            *counts.entry(v.author.as_str()).or_default() += 1;
        }
        counts.into_iter().map(|(a, n)| (a.to_string(), n)).collect()
    }

    /// I video di un autore, dall'ultimo pubblicato.
    pub fn by_author(&self, author: &str) -> Vec<&Video> {
        let mut all: Vec<&Video> = self
            .file
            .videos
            .values()
            .filter(|v| v.author == author && !v.archived)
            .collect();
        all.sort_by(|a, b| b.upload_date.cmp(&a.upload_date).then_with(|| b.added_at.cmp(&a.added_at)));
        all
    }

    /// I link incollati ma non ancora diventati video (compresi quelli che non si
    /// sono lasciati risolvere, che portano il loro errore).
    pub fn queue(&self) -> &[QueuedLink] {
        &self.file.queue
    }

    /// Percorso assoluto del video. I percorsi nei record sono relativi alla loro
    /// cartella: è questa funzione che li àncora a dove le cartelle sono adesso.
    pub fn file_path(&self, video: &Video) -> PathBuf {
        self.config.videos_dir().join(&video.file)
    }

    pub fn cover_path(&self, video: &Video) -> Option<PathBuf> {
        video.cover.as_ref().map(|c| self.config.covers_dir().join(c))
    }

    pub fn metadata_path(&self, video: &Video) -> Option<PathBuf> {
        video.metadata.as_ref().map(|m| self.config.metadata_dir().join(m))
    }

    /// I metadati grezzi di yt-dlp, riletti da disco: sono grossi, non stanno in
    /// memoria.
    pub fn metadata(&self, id: &str) -> Result<Value> {
        let video = self.get(id).ok_or_else(|| Error::new(format!("nessun video con id {id}")))?;
        let path = self
            .metadata_path(video)
            .ok_or_else(|| Error::new(format!("{id} non ha metadati salvati")))?;
        Ok(serde_json::from_str(&std::fs::read_to_string(&path)?)?)
    }

    /// Gli id dati per scaricati il cui file è sparito dal disco.
    pub fn missing_files(&self) -> Vec<String> {
        self.file
            .videos
            .values()
            .filter(|v| v.state == State::Downloaded && !self.file_path(v).is_file())
            .map(|v| v.id.clone())
            .collect()
    }

    /// Riproduce un video già scaricato.
    pub fn play(&self, id: &str, mode: Mode) -> Result<()> {
        let video = self.get(id).ok_or_else(|| Error::new(format!("nessun video con id {id}")))?;
        if video.state != State::Downloaded {
            return Err(Error::new(format!("«{}» non è ancora scaricato", video.title)));
        }
        playback::play(self.config.vlc.as_deref(), &self.file_path(video), mode)
    }

    // ── Scrittura ───────────────────────────────────────────────────────────

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<bool> {
        self.edit(id, |v| v.favorite = favorite)
    }

    pub fn set_archived(&mut self, id: &str, archived: bool) -> Result<bool> {
        self.edit(id, |v| v.archived = archived)
    }

    pub fn set_removed(&mut self, id: &str, removed: bool) -> Result<bool> {
        self.edit(id, |v| v.removed = removed)
    }

    /// Rimette in coda un video fallito (o uno il cui file è sparito). Ritorna
    /// l'URL da dare al [`Downloader`], oppure `None` se quell'id non c'è.
    pub fn retry(&mut self, id: &str) -> Result<Option<String>> {
        let Some(video) = self.file.videos.get_mut(id) else {
            return Ok(None);
        };
        video.state = State::Pending;
        video.error = None;
        let url = video.url.clone();
        self.save()?;
        Ok(Some(url))
    }

    fn edit(&mut self, id: &str, change: impl FnOnce(&mut Video)) -> Result<bool> {
        let Some(video) = self.file.videos.get_mut(id) else {
            return Ok(false);
        };
        change(video);
        self.save()?;
        Ok(true)
    }

    /// Mette un link in coda. Se c'era già (o se è un video già in libreria non
    /// scaricato) non lo duplica.
    pub fn enqueue(&mut self, url: &str) -> Result<()> {
        if !self.file.queue.iter().any(|q| q.url == url) {
            self.file.queue.push(QueuedLink { url: url.to_string(), error: None, at: now() });
            self.save()?;
        }
        Ok(())
    }

    /// Toglie un link dalla coda. Ritorna `false` se non c'era.
    pub fn dequeue(&mut self, url: &str) -> Result<bool> {
        let before = self.file.queue.len();
        self.file.queue.retain(|q| q.url != url);
        let removed = self.file.queue.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Toglie un video dalla libreria. Con `delete_files` cancella anche video,
    /// copertina e metadati (e la cartella dell'autore, se resta vuota).
    /// Ritorna `false` se quell'id non c'era.
    pub fn remove(&mut self, id: &str, delete_files: bool) -> Result<bool> {
        let Some(video) = self.file.videos.remove(id) else {
            return Ok(false);
        };
        if delete_files {
            let file = self.config.videos_dir().join(&video.file);
            let _ = std::fs::remove_file(&file);
            if let Some(cover) = self.cover_path(&video) {
                let _ = std::fs::remove_file(cover);
            }
            if let Some(meta) = self.metadata_path(&video) {
                let _ = std::fs::remove_file(meta);
            }
            // `remove_dir` fallisce se la cartella non è vuota: è esattamente il
            // controllo che serve, senza doverlo scrivere.
            if let Some(dir) = file.parent() {
                let _ = std::fs::remove_dir(dir);
            }
        }
        self.save()?;
        Ok(true)
    }

    pub fn save(&self) -> Result<()> {
        store::save(&self.config.library_file(), &self.file)
    }

    // ── Download ────────────────────────────────────────────────────────────

    /// Applica al catalogo l'effetto di un aggiornamento del [`Downloader`].
    ///
    /// È **l'unico** posto che muta lo stato durante i download, e va chiamato per
    /// ogni aggiornamento che arriva:
    ///
    /// - `resolved` → il video entra in libreria (o si aggiorna) come *in corso*, e
    ///   il link esce dalla coda: da qui in avanti ha un id;
    /// - `done` → i file vanno al loro posto canonico, lo stato diventa *scaricato*;
    /// - `error` → se l'id è noto il video diventa *fallito* col suo motivo,
    ///   altrimenti l'errore resta attaccato al link in coda.
    pub fn apply(&mut self, update: &Update) -> Result<()> {
        match &update.event {
            Event::Resolved { id, title, author, duration } => {
                self.file.queue.retain(|q| q.url != update.url);
                match self.file.videos.get_mut(id) {
                    Some(existing) => {
                        existing.state = State::Downloading;
                        existing.error = None;
                    }
                    None => {
                        let mut stub = Video::stub(id, title, author, *duration, &update.url);
                        stub.added_at = now();
                        self.file.videos.insert(id.clone(), stub);
                    }
                }
                self.save()
            }
            Event::Done { id, video, cover, metadata } => {
                let done = Finished {
                    id: id.clone(),
                    video: video.clone(),
                    cover: cover.clone(),
                    metadata: metadata.clone(),
                };
                self.absorb(&done, &update.url)?;
                self.clean_staging(video);
                Ok(())
            }
            Event::Error { message } => {
                let known = update.id.as_ref().filter(|id| self.file.videos.contains_key(*id)).cloned();
                match known {
                    Some(id) => {
                        let video = self.file.videos.get_mut(&id).expect("verificato appena sopra");
                        video.state = State::Failed;
                        video.error = Some(message.clone());
                        video.attempts += 1;
                    }
                    None => match self.file.queue.iter_mut().find(|q| q.url == update.url) {
                        Some(link) => link.error = Some(message.clone()),
                        None => self.file.queue.push(QueuedLink {
                            url: update.url.clone(),
                            error: Some(message.clone()),
                            at: now(),
                        }),
                    },
                }
                self.save()
            }
            _ => Ok(()),
        }
    }

    /// Scarica i link dati e **aspetta** che finiscano, `config.parallel` alla
    /// volta. Involucro comodo sopra [`Downloader`] per chi non deve restare
    /// interattivo (script, esempi, test).
    ///
    /// Un link che fallisce non ferma gli altri: gli esiti tornano nello stesso
    /// ordine dei link.
    pub fn download<F>(&mut self, urls: &[String], mut on: F) -> Vec<Outcome>
    where
        F: FnMut(&Update),
    {
        let mut outcomes: Vec<Outcome> = urls
            .iter()
            .map(|u| Outcome { url: u.clone(), id: None, error: None })
            .collect();
        if urls.is_empty() {
            return outcomes;
        }

        let mut dl = Downloader::start(&self.config);
        let mut of_job: std::collections::HashMap<u64, usize> = Default::default();
        for (i, url) in urls.iter().enumerate() {
            let _ = self.enqueue(url);
            of_job.insert(dl.push(url.clone()), i);
        }

        let mut chiusi = 0;
        while chiusi < urls.len() {
            let Some(update) = dl.recv_timeout(Duration::from_millis(250)) else {
                continue;
            };
            if let Err(e) = self.apply(&update) {
                // Un errore nostro (un file che non si sposta) non è un errore del
                // sentinel: va segnalato a chi guarda, non ingoiato.
                let index = of_job.get(&update.job).copied().unwrap_or(0);
                outcomes[index].error = Some(e.0.clone());
                on(&Update { event: Event::Error { message: e.0 }, ..update.clone() });
            } else {
                on(&update);
            }
            if update.is_terminal() {
                chiusi += 1;
                if let Some(&index) = of_job.get(&update.job) {
                    match &update.event {
                        Event::Done { id, .. } if outcomes[index].error.is_none() => {
                            outcomes[index].id = Some(id.clone())
                        }
                        Event::Error { message } => outcomes[index].error = Some(message.clone()),
                        _ => {}
                    }
                }
            }
        }
        dl.shutdown();
        outcomes
    }

    /// Prende in carico quello che un sentinel ha prodotto: legge i metadati,
    /// sposta i file al posto canonico, aggiorna e salva lo stato.
    fn absorb(&mut self, done: &Finished, source_url: &str) -> Result<String> {
        let raw = std::fs::read_to_string(&done.metadata)
            .map_err(|e| Error::new(format!("metadati non leggibili ({}): {e}", done.metadata.display())))?;
        let meta: Value = serde_json::from_str(&raw)?;

        let mut video = Video::from_metadata(&meta);
        if video.id.is_empty() {
            video.id = done.id.clone();
        }
        if video.url.is_empty() {
            video.url = source_url.to_string();
        }
        let id = video.id.clone();
        if id.is_empty() {
            return Err(Error::new("il sentinel non ha prodotto un id".to_string()));
        }

        let ext = done.video.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
        let rel = organize::video_rel_path(&video.author, &video.title, &id, ext);
        let dest = self.config.videos_dir().join(&rel);

        // Se c'era già, si conservano i flag e la data di ingresso, e si ripulisce
        // il vecchio file quando il nome canonico è cambiato (titolo o autore
        // diversi).
        let previous = self.file.videos.get(&id).cloned();
        if let Some(old) = &previous {
            if old.file != rel && !old.file.is_empty() {
                let _ = std::fs::remove_file(self.config.videos_dir().join(&old.file));
            }
        }

        organize::move_file(&done.video, &dest)?;
        video.file = rel;
        video.size_bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

        // La risoluzione si misura sul **file**, non sui metadati: quelli
        // descrivono il miglior formato che YouTube aveva, e con un tetto di
        // qualità direbbero 3840×2160 di un file che è 640×360. Se ffprobe non c'è,
        // si tengono i numeri dei metadati: meglio approssimativi che assenti.
        if let Some(d) = probe::dimensions(&self.config.ffprobe, &dest) {
            video.width = Some(d.width);
            video.height = Some(d.height);
            video.fps = d.fps.or(video.fps);
        }

        let meta_rel = format!("{id}.json");
        organize::move_file(&done.metadata, &self.config.metadata_dir().join(&meta_rel))?;
        video.metadata = Some(meta_rel);

        if let Some(cover) = &done.cover {
            let ext = cover.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
            let cover_rel = format!("{id}.{ext}");
            organize::move_file(cover, &self.config.covers_dir().join(&cover_rel))?;
            video.cover = Some(cover_rel);
        } else {
            video.cover = previous.as_ref().and_then(|p| p.cover.clone());
        }

        video.state = State::Downloaded;
        video.error = None;
        if let Some(old) = &previous {
            video.added_at = old.added_at;
            video.favorite = old.favorite;
            video.archived = old.archived;
            video.attempts = old.attempts;
        } else {
            video.added_at = now();
        }

        self.file.videos.insert(id.clone(), video);
        self.file.queue.retain(|q| q.url != source_url);
        self.save()?;
        Ok(id)
    }

    /// Svuota la cartella di staging del job, che è quella dove stava il video.
    /// Il controllo sul prefisso c'è perché questa funzione cancella una cartella
    /// intera: se il percorso non viene da dentro `staging/`, non si tocca niente.
    fn clean_staging(&self, staged_video: &Path) {
        let Some(dir) = staged_video.parent() else { return };
        if dir.starts_with(self.config.staging_dir()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
