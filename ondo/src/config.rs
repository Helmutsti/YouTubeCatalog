use std::path::{Path, PathBuf};

/// Tutto ciò che serve per far girare i sentinel. Si ricava da sola con
/// [`Config::for_root`]; ogni campo resta sovrascrivibile a mano.
#[derive(Debug, Clone)]
pub struct Config {
    /// Radice della libreria: contiene `library.json`, `videos/`, `covers/`, …
    pub root: PathBuf,
    pub ytdlp: PathBuf,
    pub ffmpeg: PathBuf,
    /// Percorso dell'eseguibile del sentinel.
    pub sentinel: PathBuf,
    /// File cookie in formato Netscape, per i video privati/non listati del
    /// proprio account. `None` = non passare `--cookies` (vedi ARCHITETTURA.md:
    /// i cookie insieme al client `android_vr` fanno scattare i 403).
    pub cookies: Option<PathBuf>,
    /// Tetto di risoluzione, `None` = la migliore disponibile.
    pub max_height: Option<u32>,
    /// Quanti sentinel in parallelo.
    pub parallel: usize,
}

impl Config {
    /// Radice + risoluzione automatica dei binari. Ordine di ricerca, per ogni
    /// binario: variabile d'ambiente → `tools/` sotto la radice → `tools/` nella
    /// cartella corrente → il nome nudo, che lascia decidere al `PATH`.
    pub fn for_root(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        Config {
            ytdlp: find_tool("ONDO_YTDLP", "yt-dlp", &root),
            ffmpeg: find_tool("ONDO_FFMPEG", "ffmpeg", &root),
            sentinel: find_sentinel(),
            root,
            cookies: None,
            max_height: None,
            parallel: 3,
        }
    }

    pub fn library_file(&self) -> PathBuf {
        self.root.join("library.json")
    }
    pub fn videos_dir(&self) -> PathBuf {
        self.root.join("videos")
    }
    pub fn covers_dir(&self) -> PathBuf {
        self.root.join("covers")
    }
    pub fn metadata_dir(&self) -> PathBuf {
        self.root.join("metadata")
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_tool(env_var: &str, name: &str, root: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os(env_var) {
        return PathBuf::from(p);
    }
    let file = exe(name);
    let candidates = [root.join("tools").join(&file), PathBuf::from("tools").join(&file)];
    for c in candidates {
        if c.is_file() {
            return c;
        }
    }
    // Ultimo ripiego: il nome nudo. Se non è nel PATH, l'errore arriva al primo
    // spawn con un messaggio che dice quale binario manca.
    PathBuf::from(file)
}

/// Il sentinel è un binario del nostro stesso workspace: vive accanto
/// all'eseguibile che sta girando. Il caso `examples/` è quello che si incontra
/// subito lanciando `cargo run --example`, dove l'eseguibile finisce una cartella
/// più in basso di `target/debug/`.
fn find_sentinel() -> PathBuf {
    if let Some(p) = std::env::var_os("ONDO_SENTINEL") {
        return PathBuf::from(p);
    }
    let file = exe("ondo-sentinel");
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            for d in [dir, dir.parent().unwrap_or(dir)] {
                let c = d.join(&file);
                if c.is_file() {
                    return c;
                }
            }
        }
    }
    PathBuf::from(file)
}
