use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Che qualità scaricare.
///
/// `Ask` non è un tetto: è l'assenza di una decisione presa in anticipo. Chi
/// scarica deve averla risolta **prima** di accodare — il tetto vero viaggia col
/// singolo job (`Downloader::push_with`), non con la config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    /// La migliore disponibile.
    Best,
    /// Chiedi a ogni download.
    Ask,
    /// Al massimo questa altezza (o la migliore sotto).
    Height(u32),
}

impl Default for Quality {
    fn default() -> Self {
        Quality::Best
    }
}

impl Quality {
    /// Il tetto da passare a yt-dlp. `Ask` non ne ha: se arriva qui senza essere
    /// stata risolta, si scarica il meglio, che è il default meno sorprendente.
    pub fn max_height(self) -> Option<u32> {
        match self {
            Quality::Height(h) => Some(h),
            Quality::Best | Quality::Ask => None,
        }
    }

    pub fn label(self) -> String {
        match self {
            Quality::Best => "Massima".into(),
            Quality::Ask => "Chiedi ogni volta".into(),
            Quality::Height(h) => format!("{h}p (o la migliore sotto)"),
        }
    }
}

/// Le impostazioni della libreria, salvate in `<radice>/config.json`.
///
/// I campi *persistiti* sono le scelte dell'utente. I binari esterni no: si
/// ridecidono a ogni avvio, così la stessa libreria funziona su una macchina
/// diversa senza portarsi dietro percorsi che lì non esistono.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Cartella dei video: relativa alla radice, oppure assoluta per tenere
    /// l'archivio su un altro disco.
    pub videos: PathBuf,
    pub covers: PathBuf,
    pub metadata: PathBuf,
    /// L'eseguibile di VLC. Non esiste un percorso valido per tutti: su Windows
    /// l'installazione a 32 bit è la più comune anche su sistemi a 64 bit.
    pub vlc: Option<PathBuf>,
    /// File cookie in formato Netscape, per i video privati/non listati del
    /// proprio account. I cookie **non** si usano di default: insieme al client
    /// `android_vr` sono la combinazione che la CDN di YouTube blocca con 403.
    pub cookies: Option<PathBuf>,
    /// Che qualità scaricare, quando non è deciso per il singolo download.
    pub quality: Quality,
    /// Quanti sentinel insieme.
    pub parallel: usize,

    /// La radice. Non si persiste: è dove il file è stato trovato.
    #[serde(skip)]
    pub root: PathBuf,
    #[serde(skip)]
    pub ytdlp: PathBuf,
    #[serde(skip)]
    pub ffmpeg: PathBuf,
    /// Misura i file scaricati: i metadati di yt-dlp descrivono il miglior formato
    /// disponibile, non quello che si è preso.
    #[serde(skip)]
    pub ffprobe: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            videos: PathBuf::from("videos"),
            covers: PathBuf::from("covers"),
            metadata: PathBuf::from("metadata"),
            vlc: default_vlc(),
            cookies: None,
            quality: Quality::Best,
            parallel: 3,
            root: PathBuf::new(),
            ytdlp: PathBuf::new(),
            ffmpeg: PathBuf::new(),
            ffprobe: PathBuf::new(),
        }
    }
}

impl Config {
    /// I valori di default per una radice, senza leggere niente da disco.
    pub fn for_root(root: impl AsRef<Path>) -> Self {
        let mut cfg = Config { root: root.as_ref().to_path_buf(), ..Config::default() };
        cfg.resolve_tools();
        cfg
    }

    /// Legge `<radice>/config.json`. Un file che non c'è vale come "tutti i
    /// default": una cartella vuota è una libreria valida.
    pub fn load(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let path = root.join("config.json");
        let mut cfg: Config = match std::fs::read_to_string(&path) {
            Ok(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw)
                .map_err(|e| crate::Error::new(format!("{} non è leggibile: {e}", path.display())))?,
            _ => Config::default(),
        };
        cfg.root = root;
        cfg.resolve_tools();
        if cfg.parallel == 0 {
            cfg.parallel = 1;
        }
        Ok(cfg)
    }

    pub fn save(&self) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        let path = self.config_file();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("config.json")
    }
    pub fn library_file(&self) -> PathBuf {
        self.root.join("library.json")
    }
    /// Le cartelle configurate, rese assolute rispetto alla radice.
    pub fn videos_dir(&self) -> PathBuf {
        self.under_root(&self.videos)
    }
    pub fn covers_dir(&self) -> PathBuf {
        self.under_root(&self.covers)
    }
    pub fn metadata_dir(&self) -> PathBuf {
        self.under_root(&self.metadata)
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }

    fn under_root(&self, dir: &Path) -> PathBuf {
        if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            self.root.join(dir)
        }
    }

    /// Ricalcola i percorsi dei binari esterni per questa macchina.
    pub fn resolve_tools(&mut self) {
        self.ytdlp = find_tool("ONDO_YTDLP", "yt-dlp", &self.root);
        self.ffmpeg = find_tool("ONDO_FFMPEG", "ffmpeg", &self.root);
        self.ffprobe = find_tool("ONDO_FFPROBE", "ffprobe", &self.root);
    }
}

/// Le due installazioni di VLC che esistono davvero su Windows, in ordine di
/// probabilità: la a 32 bit è la più diffusa anche sui sistemi a 64 bit.
fn default_vlc() -> Option<PathBuf> {
    let candidates: [&str; 3] = if cfg!(windows) {
        [
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            "",
        ]
    } else {
        ["/usr/bin/vlc", "/usr/local/bin/vlc", "/Applications/VLC.app/Contents/MacOS/VLC"]
    };
    candidates
        .iter()
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Cerca un eseguibile nel `PATH`, restituendo il percorso **assoluto**.
///
/// Serve perché "il nome nudo funziona, tanto ci pensa il sistema" non si può
/// verificare: un percorso che esiste si controlla con `is_file()`, un nome nudo no.
/// Risolvendolo qui, ogni percorso in [`Config`] è controllabile, e un binario
/// mancante si può dire all'avvio invece di scoprirlo a metà del primo download.
pub fn in_path(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(&file)).find(|c| c.is_file())
}

/// Il nome della radice, quando nessuno ne dice un altro.
pub const DEFAULT_ROOT_NAME: &str = "ondo-data";

/// Dove sta la libreria, quando nessuno l'ha detto.
///
/// Una radice **relativa alla cartella corrente** e nient'altro era un modo
/// silenzioso di perdere la libreria: lanciando l'eseguibile da un'altra cartella
/// non si apriva la propria, se ne creava una nuova vuota lì. Quindi si cerca una
/// `ondo-data` che **esiste già**, e l'ordine è lo stesso della `dist` della web
/// app: prima accanto all'eseguibile — l'installazione è exe e libreria nella
/// stessa cartella, e così quella cartella si sposta dove si vuole e continua a
/// funzionare — e poi la cartella corrente.
///
/// Non trovarne nessuna significa che non c'è ancora: si usa il nome relativo, che
/// la crea nella cartella corrente. È il comportamento di sempre, ed è anche quello
/// che lascia in pace lo sviluppo, dove l'eseguibile sta in `target/debug` e non è
/// certo lì che va la libreria.
pub fn find_root(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(p) = explicit {
        return p;
    }
    if let Some(p) = std::env::var_os("ONDO_ROOT") {
        return PathBuf::from(p);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let accanto = dir.join(DEFAULT_ROOT_NAME);
        if accanto.is_dir() {
            return accanto;
        }
    }
    PathBuf::from(DEFAULT_ROOT_NAME)
}

/// I runtime JavaScript che yt-dlp sa usare, in ordine di priorità (`deno` è il
/// solo abilitato di default, gli altri li abilitiamo noi).
pub const JS_RUNTIME_NAMES: [&str; 4] = ["deno", "node", "quickjs", "bun"];

/// Il runtime JavaScript che yt-dlp troverebbe su questa macchina, se ce n'è uno.
///
/// Non è una dipendenza di Ondo: **yt-dlp** ha bisogno di eseguire il JavaScript
/// del player di YouTube per calcolare i parametri offuscati degli URL dei flussi.
/// Senza nessun runtime, i download YouTube muoiono a metà con 403 — vale la pena
/// dirlo prima, non dopo. Va bene qualunque dei quattro.
pub fn js_runtime() -> Option<(&'static str, PathBuf)> {
    JS_RUNTIME_NAMES.iter().find_map(|nome| in_path(nome).map(|p| (*nome, p)))
}

fn find_tool(env_var: &str, name: &str, root: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os(env_var) {
        return PathBuf::from(p);
    }
    let file = exe(name);
    for c in [root.join("tools").join(&file), PathBuf::from("tools").join(&file)] {
        if c.is_file() {
            return c;
        }
    }
    if let Some(p) = in_path(name) {
        return p;
    }
    // Irrisolvibile: si tiene il nome nudo, così il messaggio dice *cosa* manca.
    PathBuf::from(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_dirs_hang_off_the_root_absolute_ones_do_not() {
        let mut cfg = Config::for_root("radice");
        assert_eq!(cfg.videos_dir(), Path::new("radice").join("videos"));
        let altrove = if cfg!(windows) { r"D:\archivio" } else { "/mnt/archivio" };
        cfg.videos = PathBuf::from(altrove);
        assert_eq!(cfg.videos_dir(), PathBuf::from(altrove));
    }

    #[test]
    fn an_explicit_root_wins_and_the_default_is_a_relative_name() {
        let scelta = if cfg!(windows) { r"D:\Video\ondo-data" } else { "/mnt/video/ondo-data" };
        assert_eq!(find_root(Some(PathBuf::from(scelta))), PathBuf::from(scelta));
        // Senza `ONDO_ROOT` e senza una radice accanto all'eseguibile dei test, si
        // ricade sul nome relativo: la libreria creata nella cartella corrente al
        // primo avvio. La variabile la legge chi lancia i test, quindi se c'è il
        // caso non è verificabile e non lo si finge.
        if std::env::var_os("ONDO_ROOT").is_none() {
            assert_eq!(find_root(None), PathBuf::from(DEFAULT_ROOT_NAME));
        }
    }

    #[test]
    fn quality_is_a_choice_not_just_a_number() {
        assert_eq!(Quality::Best.max_height(), None);
        assert_eq!(Quality::Height(1080).max_height(), Some(1080));
        // «Chiedi» non è un tetto: chi non l'ha risolta prende il meglio.
        assert_eq!(Quality::Ask.max_height(), None);
        // E sopravvive a un giro su disco con un nome leggibile.
        assert_eq!(serde_json::to_string(&Quality::Ask).unwrap(), "\"ask\"");
        assert_eq!(serde_json::to_string(&Quality::Height(720)).unwrap(), r#"{"height":720}"#);
    }

    #[test]
    fn a_saved_config_comes_back_the_same() {
        let root = std::env::temp_dir().join(format!("ondo-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut cfg = Config::for_root(&root);
        cfg.quality = Quality::Height(1080);
        cfg.parallel = 5;
        cfg.videos = PathBuf::from("altrove");
        cfg.save().unwrap();

        let letta = Config::load(&root).unwrap();
        assert_eq!(letta.quality, Quality::Height(1080));
        assert_eq!(letta.parallel, 5);
        assert_eq!(letta.videos, PathBuf::from("altrove"));
        assert_eq!(letta.root, root, "la radice è dove il file è stato trovato, non ciò che dice");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_path_is_searched_for_real() {
        // Un eseguibile che c'è di sicuro, su ogni sistema.
        let sicuro = if cfg!(windows) { "cmd" } else { "sh" };
        let trovato = in_path(sicuro).expect("dovrebbe essere nel PATH");
        assert!(trovato.is_absolute() && trovato.is_file());
        assert!(in_path("questo-eseguibile-non-esiste-affatto").is_none());
    }

    #[test]
    fn a_missing_file_means_defaults() {
        let cfg = Config::load(std::env::temp_dir().join("ondo-non-esiste-affatto")).unwrap();
        assert_eq!(cfg.parallel, 3);
        assert_eq!(cfg.quality, Quality::Best);
    }
}
