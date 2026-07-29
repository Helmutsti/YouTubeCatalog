//! # Ondo
//!
//! Una sola libreria per gestire la libreria video. Si apre su una cartella, e da
//! quel momento tutto passa da qui: scaricare, elencare, cercare, togliere.
//!
//! ```no_run
//! let mut lib = ondo::Library::open("ondo-data")?;
//! lib.download(&["https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()], |u| {
//!     println!("{:?}", u.event);
//! });
//! for v in lib.list() {
//!     println!("{} — {}", v.author, v.title);
//! }
//! # Ok::<(), ondo::Error>(())
//! ```
//!
//! I download li fa un processo a parte, il **sentinel**, uno per video, lanciato
//! più volte in parallelo. Il sentinel non scrive lo stato: riferisce. È la
//! libreria che, a `done`, organizza i file e salva. Vedi `ARCHITETTURA.md`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub mod config;
pub mod error;
pub mod model;
pub mod organize;
pub mod search;
pub mod sentinel;
pub mod store;

pub use config::Config;
pub use error::{Error, Result};
pub use model::Video;
pub use sentinel::{Event, Finished, Phase};
pub use store::LibraryFile;

/// Un evento di un sentinel, con l'indicazione di quale link l'ha prodotto.
#[derive(Debug, Clone)]
pub struct Update {
    /// Posizione del link nell'elenco passato a [`Library::download`]: è così che
    /// si tengono distinte N barre di avanzamento in parallelo.
    pub index: usize,
    pub url: String,
    pub event: Event,
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

/// La libreria: stato in memoria + la cartella su disco che lo rispecchia.
pub struct Library {
    config: Config,
    file: LibraryFile,
}

impl Library {
    /// Apre (o crea) la libreria in `root`. Una cartella vuota è una libreria vuota.
    pub fn open(root: impl AsRef<Path>) -> Result<Library> {
        Library::with_config(Config::for_root(root))
    }

    /// Come [`Library::open`], ma con la configurazione decisa da chi chiama.
    pub fn with_config(config: Config) -> Result<Library> {
        std::fs::create_dir_all(&config.root)?;
        let file = store::load(&config.library_file())?;
        Ok(Library { config, file })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Per cambiare a caldo qualità, parallelismo o cookie.
    pub fn config_mut(&mut self) -> &mut Config {
        &mut self.config
    }

    // ── Lettura ─────────────────────────────────────────────────────────────

    /// Tutti i video, dal più recente.
    pub fn list(&self) -> Vec<&Video> {
        let mut all: Vec<&Video> = self.file.videos.values().collect();
        all.sort_by(|a, b| b.added_at.cmp(&a.added_at).then_with(|| a.title.cmp(&b.title)));
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

    /// I video che rispondono alla query, dal più pertinente.
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
        for v in self.file.videos.values() {
            *counts.entry(v.author.as_str()).or_default() += 1;
        }
        counts.into_iter().map(|(a, n)| (a.to_string(), n)).collect()
    }

    /// I video di un autore, dal più recente.
    pub fn by_author(&self, author: &str) -> Vec<&Video> {
        let mut all: Vec<&Video> = self.file.videos.values().filter(|v| v.author == author).collect();
        all.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        all
    }

    /// Percorso assoluto del video. I percorsi in `library.json` sono relativi:
    /// è questa funzione che li àncora alla radice corrente.
    pub fn file_path(&self, video: &Video) -> PathBuf {
        self.config.root.join(&video.file)
    }

    pub fn cover_path(&self, video: &Video) -> Option<PathBuf> {
        video.cover.as_ref().map(|c| self.config.root.join(c))
    }

    pub fn metadata_path(&self, video: &Video) -> Option<PathBuf> {
        video.metadata.as_ref().map(|m| self.config.root.join(m))
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

    /// Gli id il cui file è sparito dal disco: sono quelli da riscaricare.
    pub fn missing_files(&self) -> Vec<String> {
        self.file
            .videos
            .values()
            .filter(|v| !self.file_path(v).is_file())
            .map(|v| v.id.clone())
            .collect()
    }

    // ── Scrittura ───────────────────────────────────────────────────────────

    /// Toglie un video dalla libreria. Con `delete_files` cancella anche video,
    /// copertina e metadati (e la cartella dell'autore, se resta vuota).
    /// Ritorna `false` se quell'id non c'era.
    pub fn remove(&mut self, id: &str, delete_files: bool) -> Result<bool> {
        let Some(video) = self.file.videos.remove(id) else {
            return Ok(false);
        };
        if delete_files {
            let file = self.config.root.join(&video.file);
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

    /// Scarica i link dati, `config.parallel` alla volta.
    ///
    /// Ogni link ha il suo sentinel; `on` riceve gli eventi di tutti mentre
    /// arrivano, mescolati ma etichettati con [`Update::index`]. Un link che
    /// fallisce non ferma gli altri: l'esito di ciascuno sta nel valore di ritorno,
    /// nello stesso ordine dei link.
    ///
    /// Un video già in libreria viene riscaricato e **sostituito** (stesso id):
    /// la data di ingresso viene conservata, il vecchio file rimosso se il nome è
    /// cambiato. Per non riscaricarlo, filtra prima con [`Library::get`].
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

        // La config viene clonata perché i thread la leggono mentre il thread
        // orchestratore ha bisogno di `&mut self` per organizzare i file.
        let cfg = self.config.clone();
        let jobs: Mutex<VecDeque<(usize, String)>> =
            Mutex::new(urls.iter().cloned().enumerate().collect());
        let workers = cfg.parallel.max(1).min(urls.len());

        enum Msg {
            Ev(Event),
            End(Result<Finished>),
        }
        let (tx, rx) = mpsc::channel::<(usize, Msg)>();

        std::thread::scope(|scope| {
            for _ in 0..workers {
                let tx = tx.clone();
                let jobs = &jobs;
                let cfg = &cfg;
                scope.spawn(move || {
                    loop {
                        let Some((index, url)) = jobs.lock().unwrap().pop_front() else {
                            break;
                        };
                        let staging = cfg.staging_dir().join(format!("job-{index}"));
                        // Residui di un giro precedente interrotto darebbero file
                        // vecchi da organizzare: si parte da pulito.
                        let _ = std::fs::remove_dir_all(&staging);
                        let sent = tx.clone();
                        let result = sentinel::run(cfg, &url, &staging, |event| {
                            let _ = sent.send((index, Msg::Ev(event)));
                        });
                        let _ = tx.send((index, Msg::End(result)));
                    }
                });
            }
            // Il ricevitore chiude solo quando l'ultimo mittente sparisce: questa
            // copia deve andarsene ora, o il ciclo qui sotto non finirebbe mai.
            drop(tx);

            for (index, msg) in rx {
                match msg {
                    Msg::Ev(event) => {
                        on(&Update { index, url: urls[index].clone(), event });
                    }
                    Msg::End(result) => {
                        match result {
                            Ok(done) => match self.absorb(&done, &urls[index]) {
                                Ok(id) => outcomes[index].id = Some(id),
                                Err(e) => {
                                    outcomes[index].error = Some(e.0.clone());
                                    on(&Update {
                                        index,
                                        url: urls[index].clone(),
                                        event: Event::Error { message: e.0 },
                                    });
                                }
                            },
                            Err(e) => outcomes[index].error = Some(e.0),
                        }
                        // Lo staging si svuota in ogni caso, riuscita o no: i resti
                        // di un tentativo fallito non servono a nessuno (yt-dlp
                        // riparte da capo, non da qui).
                        let _ = std::fs::remove_dir_all(cfg.staging_dir().join(format!("job-{index}")));
                    }
                }
            }
        });

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
        let dest = self.config.root.join(&rel);

        // Se c'era già, si conserva la data di ingresso e si ripulisce il vecchio
        // file quando il nome canonico è cambiato (titolo o autore diversi).
        let previous = self.file.videos.get(&id).cloned();
        if let Some(old) = &previous {
            if old.file != rel {
                let _ = std::fs::remove_file(self.config.root.join(&old.file));
            }
        }

        organize::move_file(&done.video, &dest)?;
        video.file = rel;
        video.size_bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

        let meta_rel = format!("metadata/{id}.json");
        organize::move_file(&done.metadata, &self.config.root.join(&meta_rel))?;
        video.metadata = Some(meta_rel);

        if let Some(cover) = &done.cover {
            let ext = cover.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
            let cover_rel = format!("covers/{id}.{ext}");
            organize::move_file(cover, &self.config.root.join(&cover_rel))?;
            video.cover = Some(cover_rel);
        } else {
            video.cover = previous.as_ref().and_then(|p| p.cover.clone());
        }

        video.added_at = previous.map(|p| p.added_at).unwrap_or_else(now);

        self.file.videos.insert(id.clone(), video);
        self.save()?;
        Ok(id)
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
