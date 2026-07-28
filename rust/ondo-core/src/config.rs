//! Configurazione e percorsi — porting di `core/src/config.js`.
//!
//! ## Una differenza voluta rispetto al JS: come si trova la radice del progetto
//!
//! `config.js` calcola `PROJECT_ROOT` con `path.resolve(__dirname, '../..')`,
//! cioè assume "sto dentro questo monorepo, due livelli sopra il mio file". Per
//! un modulo ESM è ragionevole; per un binario compilato non funziona: l'exe può
//! stare in `rust/target/release/`, essere installato altrove, o essere caricato
//! come libreria da un processo ospite qualunque (che è esattamente lo scopo
//! dell'ABI C). Qui la radice si **cerca**, in questo ordine:
//!
//!   1. la variabile d'ambiente `ONDO_ROOT` (via di fuga esplicita, utile ai test);
//!   2. risalendo dalla directory corrente;
//!   3. risalendo dalla posizione dell'eseguibile.
//!
//! Il marcatore è la presenza simultanea di `package.json` e `core/src/index.js`:
//! inequivocabile per questo progetto. Il limite (a) annotato in `PIANO.md` per
//! Electron ("`config.js` assume di stare dentro il monorepo") qui non esiste.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::error::{OndoError, Result};

// ── Radice del progetto ─────────────────────────────────────────────────────

static PROJECT_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn looks_like_project_root(dir: &Path) -> bool {
    dir.join("package.json").is_file() && dir.join("core/src/index.js").is_file()
}

fn walk_up(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if looks_like_project_root(dir) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

pub fn project_root() -> &'static Path {
    PROJECT_ROOT.get_or_init(|| {
        if let Some(explicit) = env::var_os("ONDO_ROOT") {
            return PathBuf::from(explicit);
        }
        if let Some(found) = env::current_dir().ok().and_then(|d| walk_up(&d)) {
            return found;
        }
        if let Some(found) = env::current_exe().ok().and_then(|exe| {
            exe.parent().and_then(walk_up)
        }) {
            return found;
        }
        // Ripiego: la directory corrente. Le operazioni falliranno con un errore
        // chiaro invece di scrivere file in un posto inatteso.
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

pub fn core_dir() -> PathBuf {
    project_root().join("core")
}

// ── Config ──────────────────────────────────────────────────────────────────

/// Gli stessi default di `DEFAULT_CONFIG` in `config.js`, nello stesso ordine.
pub fn default_config() -> Value {
    json!({
        "mediaRoot": "./media",
        // Percorso dedicato ai soli file video. Se null → mediaRoot/videos
        // (retrocompatibile). Serve a tenere i video (grandi) su un disco
        // separato dalle copertine/avatar (piccoli, sotto mediaRoot).
        "videosRoot": Value::Null,
        "port": 3001,
        "ytdlp": {
            // null = scelta automatica del binario in base al sistema operativo.
            // Un percorso esplicito qui ha comunque sempre la precedenza.
            "binaryPath": Value::Null,
            "format": "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b",
            "mergeOutputFormat": "mp4",
            "maxHeight": Value::Null,
            "cookiesFile": Value::Null,
            "ffmpegLocation": Value::Null
        },
        "download": {
            // Qualità predefinita: decide se il download si ferma a chiedere.
            //   "ask"  → chiede la risoluzione fra quelle disponibili (default)
            //   "max"  → parte subito alla massima qualità
            //   "720p" → parte subito con un tetto (accettati anche 720 e "720")
            // Con un valore diverso da "ask" il download parte SENZA interruzioni:
            // è ciò che permette di lanciare più istanze in parallelo senza dover
            // rispondere a un prompt in ognuna.
            "defaultQuality": "ask",
            // Quanti download far girare insieme, su thread separati dello stesso
            // processo. 1 = uno alla volta (con la barra di avanzamento).
            // Tenuto basso di proposito: ogni download in più è una connessione in
            // più verso la CDN di YouTube, e alzarlo troppo invita i 403.
            "parallel": 3
        },
        "playback": {
            "vlcPath": "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe"
        },
        "jobs": { "maxAttempts": 3 }
    })
}

/// Qualità predefinita per i download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityPref {
    /// Chiede all'utente fra le risoluzioni realmente disponibili.
    Ask,
    /// Parte subito, nessun tetto.
    Max,
    /// Parte subito con un tetto di altezza. È un **cap** (`height<=N`), non una
    /// richiesta esatta: se il video non ha quella risoluzione si prende la migliore
    /// sotto di essa.
    Cap(u64),
}

impl QualityPref {
    /// Come si scrive in `config.json`.
    pub fn as_config_value(self) -> Value {
        match self {
            QualityPref::Ask => json!("ask"),
            QualityPref::Max => json!("max"),
            QualityPref::Cap(h) => json!(format!("{h}p")),
        }
    }

    pub fn label(self) -> String {
        match self {
            QualityPref::Ask => "Chiedi ogni volta".into(),
            QualityPref::Max => "Massima".into(),
            QualityPref::Cap(h) => format!("{h}p (o la migliore sotto)"),
        }
    }

    /// Valore da passare a `download_video`: `None` = "usa la config"
    /// (che qui non capita mai, perché la scelta è già stata fatta),
    /// `Some(None)` = nessun tetto, `Some(Some(h))` = tetto esplicito.
    pub fn max_height(self) -> Option<Option<u64>> {
        match self {
            QualityPref::Ask => None,
            QualityPref::Max => Some(None),
            QualityPref::Cap(h) => Some(Some(h)),
        }
    }

    /// Accetta `"ask"`, `"max"`, `"720p"`, `"720"` e il numero `720`. Qualunque altra
    /// cosa ricade su `Ask`: una config scritta male non deve far partire download a
    /// una risoluzione che l'utente non ha chiesto.
    pub fn parse(value: Option<&Value>) -> Self {
        match value {
            Some(Value::String(s)) => {
                let s = s.trim().to_lowercase();
                match s.as_str() {
                    "ask" | "chiedi" => QualityPref::Ask,
                    "max" | "massima" | "best" => QualityPref::Max,
                    other => other
                        .trim_end_matches('p')
                        .parse::<u64>()
                        .ok()
                        .filter(|h| *h > 0)
                        .map(QualityPref::Cap)
                        .unwrap_or(QualityPref::Ask),
                }
            }
            Some(Value::Number(n)) => n
                .as_u64()
                .filter(|h| *h > 0)
                .map(QualityPref::Cap)
                .unwrap_or(QualityPref::Ask),
            _ => QualityPref::Ask,
        }
    }
}

/// Le risoluzioni proposte nel menu delle impostazioni. Sono i tagli standard di
/// YouTube; un valore arbitrario resta scrivibile a mano in `config.json`.
pub const QUALITY_CHOICES: [QualityPref; 8] = [
    QualityPref::Ask,
    QualityPref::Max,
    QualityPref::Cap(2160),
    QualityPref::Cap(1440),
    QualityPref::Cap(1080),
    QualityPref::Cap(720),
    QualityPref::Cap(480),
    QualityPref::Cap(360),
];

/// Quanti download in parallelo. Limitato a 1..=8: oltre non si guadagna banda, si
/// guadagnano solo 403 dalla CDN di YouTube. Un valore assurdo in config ricade su 1,
/// che è sempre sicuro.
pub const MAX_PARALLEL: u64 = 8;

pub fn parallel_downloads() -> Result<usize> {
    Ok(load_config()?
        .pointer("/download/parallel")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, MAX_PARALLEL) as usize)
}

pub fn set_parallel_downloads(n: usize) -> Result<()> {
    let n = (n as u64).clamp(1, MAX_PARALLEL);
    update_config(&json!({ "download": { "parallel": n } }))?;
    Ok(())
}

pub fn default_quality() -> Result<QualityPref> {
    Ok(QualityPref::parse(load_config()?.pointer("/download/defaultQuality")))
}

pub fn set_default_quality(pref: QualityPref) -> Result<()> {
    update_config(&json!({ "download": { "defaultQuality": pref.as_config_value() } }))?;
    Ok(())
}

fn config_path() -> PathBuf {
    project_root().join("data").join("config.json")
}

/// Deep merge: gli oggetti si fondono ricorsivamente, tutto il resto (array
/// compresi) viene sostituito. Stessa semantica di `deepMerge()` in JS.
fn deep_merge(defaults: &Value, overrides: &Value) -> Value {
    match (defaults, overrides) {
        (Value::Object(d), Value::Object(o)) => {
            let mut result = d.clone();
            for (key, ov) in o {
                let merged = match d.get(key) {
                    Some(dv) => deep_merge(dv, ov),
                    None => ov.clone(),
                };
                result.insert(key.clone(), merged);
            }
            Value::Object(result)
        }
        (_, o) => o.clone(),
    }
}

/// Carica `data/config.json`, creandolo coi default se assente — come il JS.
/// **Non** memorizza in cache: il porting evita deliberatamente il singleton
/// `cachedConfig` di `config.js`, che è la causa del "riavvia il processo dopo
/// aver cambiato la config" documentato in `documentazione.md`. Rileggere un
/// file di 400 byte costa microsecondi.
pub fn load_config() -> Result<Value> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let defaults = default_config();
    if !path.is_file() {
        let text = format!("{}\n", serde_json::to_string_pretty(&defaults)?);
        fs::write(&path, text)?;
        return Ok(defaults);
    }

    let user: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    Ok(deep_merge(&defaults, &user))
}

/// Scrittura atomica (tmp + rename) di una patch deep-merged sulle sole
/// override utente, come `updateConfig()`.
pub fn update_config(patch: &Value) -> Result<Value> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing: Value = if path.is_file() {
        serde_json::from_str(&fs::read_to_string(&path)?)?
    } else {
        json!({})
    };
    let updated = deep_merge(&existing, patch);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(&updated)?))?;
    fs::rename(&tmp, &path)?;
    load_config()
}

// ── Nomi dei binari esterni ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolNames {
    pub ytdlp: &'static str,
    pub ffmpeg: &'static str,
    pub ffprobe: &'static str,
}

/// Porting di `expectedToolNames()` (M64). Deve restare **identica** alla
/// versione JS: se le due divergono, un'installazione fatta da `npm run setup`
/// diventa invisibile al binario Rust (e viceversa).
pub fn expected_tool_names() -> ToolNames {
    if cfg!(target_os = "windows") {
        ToolNames { ytdlp: "yt-dlp.exe", ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" }
    } else if cfg!(target_os = "macos") {
        ToolNames { ytdlp: "yt-dlp_macos", ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
    } else {
        ToolNames { ytdlp: "yt-dlp_linux", ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
    }
}

// ── Percorsi risolti ────────────────────────────────────────────────────────

/// Percorsi risolti.
///
/// ## Le tre radici restano separate, di proposito
///
/// `data_dir` (piccolo: json, copertine, foto profilo) e `videos_dir` (decine di GB,
/// tipicamente su un altro disco) sono **configurabili indipendentemente**. Unirli
/// sotto una cartella sola sarebbe una regressione: riporterebbe i video sul disco
/// di sistema. `covers_dir` e `authors_dir` stanno sotto `data_dir` perché sono
/// piccoli e vanno insieme allo stato, non ai video.
#[derive(Debug, Clone)]
pub struct Paths {
    pub project_root: PathBuf,
    pub core_dir: PathBuf,
    pub data_dir: PathBuf,
    /// Video, grandi: `<Autore>/<Titolo> [<id>].<ext>`.
    pub videos_dir: PathBuf,
    /// Copertine dei video, `<id>.jpg`.
    pub covers_dir: PathBuf,
    /// Foto profilo degli autori, `<key>.jpg`.
    pub authors_dir: PathBuf,
    /// Metadati grezzi, **un file per video**: `<id>.json`.
    pub metadata_dir: PathBuf,
    pub sources_path: PathBuf,
    pub library_path: PathBuf,
    /// Il vecchio file monolitico: esiste solo finché la migrazione non è stata fatta.
    pub legacy_catalog_path: PathBuf,
    pub runs_path: PathBuf,
    pub tools_dir: PathBuf,
    pub ytdlp_binary_path: PathBuf,
    pub download_archive_path: PathBuf,
    pub cookies_path: Option<PathBuf>,
    pub ffmpeg_location: Option<PathBuf>,
    pub vlc_path: String,
}

fn resolve_from_root(root: &Path, value: &str) -> PathBuf {
    let p = Path::new(value);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

/// Porting di `getPaths()`. Come il JS, crea le cartelle media mancanti.
pub fn get_paths() -> Result<Paths> {
    let config = load_config()?;
    let root = project_root().to_path_buf();

    // `dataRoot` ospita lo stato e i file piccoli; `videosRoot` i video, che possono
    // stare su un altro disco. `video.localPath` resta relativo a videos_dir,
    // qualunque sia la sua posizione: spostare l'archivio richiede solo cambiare la
    // config, non riscrivere lo stato.
    let data_dir = match config.get("dataRoot").and_then(Value::as_str) {
        Some(v) if !v.is_empty() => resolve_from_root(&root, v),
        // Retrocompatibilità: `mediaRoot` era la vecchia chiave, ma ospitava i media,
        // non lo stato — quindi non la si riusa come dataRoot. Default: ./data.
        _ => root.join("data"),
    };
    let videos_dir = match config.get("videosRoot").and_then(Value::as_str) {
        Some(v) if !v.is_empty() => resolve_from_root(&root, v),
        _ => match config.get("mediaRoot").and_then(Value::as_str) {
            // Se esiste ancora la vecchia mediaRoot, i video stavano in mediaRoot/videos.
            Some(m) if !m.is_empty() => resolve_from_root(&root, m).join("videos"),
            _ => root.join("videos"),
        },
    };
    let covers_dir = data_dir.join("covers");
    let authors_dir = data_dir.join("authors");
    let metadata_dir = data_dir.join("metadata");

    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&videos_dir)?;
    fs::create_dir_all(&covers_dir)?;
    fs::create_dir_all(&authors_dir)?;
    fs::create_dir_all(&metadata_dir)?;

    // Cookie: un percorso esplicito in config vince; altrimenti core/cookies.txt
    // se esiste. Rilevato a ogni chiamata, quindi non serve riavviare dopo un
    // upload/cancellazione.
    let default_cookies = core_dir().join("cookies.txt");
    let cookies_path = match config.pointer("/ytdlp/cookiesFile").and_then(Value::as_str) {
        Some(explicit) if !explicit.is_empty() => {
            let p = resolve_from_root(&root, explicit);
            p.is_file().then_some(p)
        }
        _ => default_cookies.is_file().then_some(default_cookies),
    };

    let names = expected_tool_names();
    let ytdlp_binary_path = match config.pointer("/ytdlp/binaryPath").and_then(Value::as_str) {
        Some(explicit) if !explicit.is_empty() => resolve_from_root(&root, explicit),
        _ => root.join("tools").join(names.ytdlp),
    };
    let tools_dir = ytdlp_binary_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("tools"));

    // ffmpeg: config → accanto a yt-dlp (tools/) → PATH di sistema (None).
    let ffmpeg_location = match config.pointer("/ytdlp/ffmpegLocation").and_then(Value::as_str) {
        Some(explicit) if !explicit.is_empty() => Some(resolve_from_root(&root, explicit)),
        _ => tools_dir.join(names.ffmpeg).is_file().then(|| tools_dir.clone()),
    };

    Ok(Paths {
        sources_path: data_dir.join("sources.json"),
        library_path: data_dir.join("library.json"),
        legacy_catalog_path: data_dir.join("catalog.json"),
        runs_path: data_dir.join("jobs.json"),
        download_archive_path: data_dir.join(".ytdlp-archive.txt"),
        vlc_path: config
            .pointer("/playback/vlcPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        project_root: root,
        core_dir: core_dir(),
        videos_dir,
        covers_dir,
        authors_dir,
        metadata_dir,
        data_dir,
        tools_dir,
        ytdlp_binary_path,
        cookies_path,
        ffmpeg_location,
    })
}

// ── Preflight (porting di core/src/preflight.js, M64) ───────────────────────

#[derive(Debug, Clone)]
pub struct ToolsStatus {
    pub ok: bool,
    pub ytdlp_ok: bool,
    pub ytdlp_path: PathBuf,
    pub ffmpeg_source: Option<String>,
    pub messages: Vec<String>,
}

fn ffmpeg_on_path() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn check_tools() -> Result<ToolsStatus> {
    let paths = get_paths()?;
    let names = expected_tool_names();
    let mut messages = Vec::new();

    let ytdlp_ok = paths.ytdlp_binary_path.is_file();
    if !ytdlp_ok {
        messages.push(format!(
            "yt-dlp non trovato in {}\n  Serve il file \"{}\" nella cartella tools/.",
            paths.ytdlp_binary_path.display(),
            names.ytdlp
        ));
    }

    let ffmpeg_source = if let Some(loc) = &paths.ffmpeg_location {
        Some(loc.display().to_string())
    } else if ffmpeg_on_path() {
        Some("PATH di sistema".to_string())
    } else {
        messages.push(format!(
            "ffmpeg non trovato (né in {} né nel PATH di sistema).\n  \
             Serve per unire video e audio: senza, i download falliscono.",
            paths.tools_dir.display()
        ));
        None
    };

    // ffprobe accompagna sempre ffmpeg: yt-dlp lo usa per ispezionare i flussi
    // prima della fusione. Controllato solo quando ffmpeg viene da tools/.
    if let Some(loc) = &paths.ffmpeg_location {
        if !loc.join(names.ffprobe).is_file() {
            messages.push(format!(
                "{} manca accanto a ffmpeg in {}\n  \
                 yt-dlp ne ha bisogno insieme a ffmpeg: servono entrambi i file.",
                names.ffprobe,
                loc.display()
            ));
        }
    }

    Ok(ToolsStatus {
        ok: messages.is_empty(),
        ytdlp_ok,
        ytdlp_path: paths.ytdlp_binary_path,
        ffmpeg_source,
        messages,
    })
}

/// Imposta la cartella media/video: **solo ripuntamento**, non sposta file.
/// Regge sul fatto che i `localPath` nel catalogo sono relativi a `mediaRoot`.
pub fn set_media_root(new_path: &str) -> Result<PathBuf> {
    set_root_key("mediaRoot", new_path)
}

pub fn set_videos_root(new_path: &str) -> Result<PathBuf> {
    set_root_key("videosRoot", new_path)
}

fn set_root_key(key: &str, new_path: &str) -> Result<PathBuf> {
    let value = new_path.trim();
    if value.is_empty() {
        return Err(OndoError::invalid("Percorso non valido."));
    }
    let resolved = resolve_from_root(project_root(), value);
    if !resolved.exists() {
        return Err(OndoError::invalid(format!(
            "Il percorso non esiste: {}. Sposta prima la cartella in questa posizione, \
             poi imposta il percorso.",
            resolved.display()
        )));
    }
    if !resolved.is_dir() {
        return Err(OndoError::invalid(format!(
            "Il percorso non è una cartella: {}.",
            resolved.display()
        )));
    }
    update_config(&json!({ key: value }))?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_merge_replaces_scalars_and_arrays_but_fuses_objects() {
        let d = json!({"a": 1, "n": {"x": 1, "y": 2}, "arr": [1, 2]});
        let o = json!({"n": {"y": 9}, "arr": [3]});
        assert_eq!(
            deep_merge(&d, &o),
            json!({"a": 1, "n": {"x": 1, "y": 9}, "arr": [3]})
        );
    }

    #[test]
    fn quality_preference_accepts_every_reasonable_spelling() {
        let p = |v: Value| QualityPref::parse(Some(&v));
        assert_eq!(p(json!("ask")), QualityPref::Ask);
        assert_eq!(p(json!("chiedi")), QualityPref::Ask);
        assert_eq!(p(json!("ASK")), QualityPref::Ask);
        assert_eq!(p(json!("max")), QualityPref::Max);
        assert_eq!(p(json!("massima")), QualityPref::Max);
        assert_eq!(p(json!("720p")), QualityPref::Cap(720));
        assert_eq!(p(json!("720")), QualityPref::Cap(720));
        assert_eq!(p(json!(720)), QualityPref::Cap(720));
        assert_eq!(p(json!(" 1080P ")), QualityPref::Cap(1080));
    }

    #[test]
    fn a_nonsensical_setting_falls_back_to_asking_never_to_a_silent_quality() {
        // Il ripiego conta: una config scritta male non deve far partire download a una
        // risoluzione che l'utente non ha chiesto. Meglio fermarsi e domandare.
        let p = |v: Value| QualityPref::parse(Some(&v));
        for bad in [json!("boh"), json!(""), json!("0p"), json!(0), json!(-720), json!(true), json!(null), json!({})] {
            assert_eq!(p(bad.clone()), QualityPref::Ask, "input: {bad}");
        }
        assert_eq!(QualityPref::parse(None), QualityPref::Ask, "chiave assente");
    }

    #[test]
    fn quality_round_trips_through_the_config_representation() {
        for pref in QUALITY_CHOICES {
            let scritto = pref.as_config_value();
            assert_eq!(
                QualityPref::parse(Some(&scritto)),
                pref,
                "scritto come {scritto}, riletto diverso"
            );
        }
    }

    #[test]
    fn only_ask_means_stop_and_prompt() {
        assert_eq!(QualityPref::Ask.max_height(), None, "None = chiedi");
        assert_eq!(QualityPref::Max.max_height(), Some(None), "Some(None) = nessun tetto");
        assert_eq!(QualityPref::Cap(720).max_height(), Some(Some(720)));
    }

    #[test]
    fn the_default_config_asks() {
        // Un utente che non ha mai toccato l'impostazione deve vedere il prompt: è il
        // comportamento meno sorprendente.
        assert_eq!(
            QualityPref::parse(default_config().pointer("/download/defaultQuality")),
            QualityPref::Ask
        );
    }

    #[test]
    fn tool_names_match_the_javascript_convention() {
        let n = expected_tool_names();
        if cfg!(target_os = "windows") {
            assert_eq!((n.ytdlp, n.ffmpeg, n.ffprobe), ("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(n.ytdlp, "yt-dlp_macos");
        } else {
            assert_eq!(n.ytdlp, "yt-dlp_linux");
        }
    }
}
