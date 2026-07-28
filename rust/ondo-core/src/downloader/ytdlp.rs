//! Wrapper di `yt-dlp` — porting di `core/src/ytdlp/ytdlpWrapper.js` (731 righe).
//!
//! ⚠️ **Qui quasi nulla è "logica": sono cicatrici di battaglie con YouTube.**
//! Ogni flag ha una motivazione empirica verificata dal vivo, registrata nei
//! commenti come nell'originale. Tradurre è meccanico, *cambiare* è pericoloso:
//! non si tocca un argomento di questo modulo senza un download reale a riprova.
//!
//! ## Una differenza tecnica obbligata: drenare stdout e stderr insieme
//!
//! Node legge le due pipe in modo asincrono senza pensarci. In Rust, leggere
//! stdout fino a EOF mentre stderr si riempie porta a un **deadlock**: yt-dlp si
//! blocca scrivendo su una pipe piena, noi restiamo in attesa di stdout che non
//! arriva più. Per questo `run_ytdlp` drena stderr in un **thread dedicato**.
//! È il tipo di problema che in JS non esiste e in Rust va affrontato subito.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::{get_paths, load_config, Paths};
use crate::error::{ErrorKind, OndoError, Result};
use crate::time::now_iso8601;

/// Esito di un'operazione che ha estratto metadati: i **campi curati** da fondere
/// nella entry di catalogo e l'**info.json grezzo** da archiviare.
///
/// Restituire il grezzo invece di salvarlo è ciò che rende questo layer puro: la
/// prima stesura chiamava `set_metadata()` da qui, creando il ciclo
/// `library → downloader → library`. Ora decide `ops`.
#[derive(Debug, Clone)]
pub struct Extracted {
    pub fields: Value,
    pub raw_info: Value,
}

// ── Argomenti non negoziabili ───────────────────────────────────────────────

/// YouTube richiede un runtime JavaScript per decifrare le firme dei formati:
/// senza, alcuni download falliscono con HTTP 403 **a metà** (verificato).
/// Node è già una dipendenza del progetto, quindi si usa come runtime.
///
/// ⚠️ Nota per il futuro: questo è l'unico punto in cui il progetto in Rust
/// dipende ancora dalla presenza di `node` nel PATH. Non è eliminabile senza
/// rinunciare a yt-dlp — vedi il §2 di docs/rust-core.md.
const JS_RUNTIME_ARGS: [&str; 2] = ["--js-runtimes", "node"];

/// Alcuni video sono assegnati da YouTube a un esperimento che richiede un "PO
/// Token" per i client normali (web/ios/tv): senza, i loro formati falliscono con
/// 403 in modo sistematico e ripetibile. `android_vr` non è soggetto
/// all'esperimento ma a volte espone **solo 360p**; `web_embedded` espone i DASH
/// pieni (1080p video-only + audio-only) senza PO Token — verificato su
/// TDeUgkAGVXU, dove senza di lui si vedeva solo 360p pur essendo 1080p.
/// Tutti e tre **supplementari**: aggiungono opzioni, non sostituiscono nulla.
const PLAYER_CLIENT_ARGS: [&str; 2] = [
    "--extractor-args",
    "youtube:player_client=default,android_vr,web_embedded",
];

/// yt-dlp segnala così un video reso privato o sparito per sempre. Verificato su
/// tre varianti reali: "Private video. Sign in…", "Video unavailable. …account
/// associated with this video has been terminated.", "Video unavailable. It was
/// removed following a copyright removal request…". Sono segnali **definitivi**,
/// diversi da un errore di rete temporaneo: servono a marcare il video "rimosso"
/// subito invece di lasciarlo in limbo, ri-tentato a ogni sync per sempre.
pub fn is_video_gone_error(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("private video") || m.contains("video unavailable")
}

// ── Reporter: dove finiscono log e avanzamento ──────────────────────────────

/// Sostituisce l'`EventEmitter` del JS. Con l'API e il frontend fuori scope non
/// serve più un bus di eventi con storico e bridge SSE: chi lancia l'operazione è
/// lo stesso processo che la mostra, quindi basta un canale diretto.
pub trait Reporter: Send + Sync {
    fn log(&self, line: &str);
    fn progress(&self, percent: f64);
    /// L'utente ha chiesto di fermarsi. Sostituisce `AbortSignal`.
    fn cancelled(&self) -> bool {
        false
    }
}

/// Reporter che scarta tutto: per le operazioni non interattive e i test.
pub struct SilentReporter;
impl Reporter for SilentReporter {
    fn log(&self, _line: &str) {}
    fn progress(&self, _percent: f64) {}
}

/// Reporter che accumula, per i test e per la diagnostica.
#[derive(Default)]
pub struct CollectingReporter {
    pub lines: Mutex<Vec<String>>,
    pub last_percent: Mutex<Option<f64>>,
    pub cancel: AtomicBool,
}

impl Reporter for CollectingReporter {
    fn log(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_string());
    }
    fn progress(&self, percent: f64) {
        *self.last_percent.lock().unwrap() = Some(percent);
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

// ── Esecuzione di yt-dlp ────────────────────────────────────────────────────

/// `[download]  45.3% of …` → `45.3`
fn parse_progress_percent(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let end = rest.find('%')?;
    rest[..end].trim().parse::<f64>().ok()
}

/// Esegue yt-dlp raccogliendo output riga per riga.
///
/// Drena **stderr in un thread separato** per non incorrere nel deadlock delle
/// pipe piene (vedi la nota in testa al modulo). Se il reporter segnala
/// `cancelled()`, il processo figlio viene ucciso.
fn run_ytdlp(paths: &Paths, args: &[String], reporter: &dyn Reporter) -> Result<()> {
    let mut child = Command::new(&paths.ytdlp_binary_path)
        .args(args)
        .current_dir(&paths.project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| {
            OndoError::new(
                ErrorKind::Io,
                format!(
                    "Impossibile avviare yt-dlp ({}): {e}. Esegui `npm run setup`.",
                    paths.ytdlp_binary_path.display()
                ),
            )
        })?;

    let stderr = child.stderr.take().expect("stderr richiesto come pipe");
    // La coda di stderr è ciò che finisce nel messaggio d'errore: yt-dlp scrive lì
    // il motivo vero del fallimento (403, formato non disponibile, video privato).
    let tail = Arc::new(Mutex::new(String::new()));
    let tail_writer = Arc::clone(&tail);
    let stderr_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            let mut t = tail_writer.lock().unwrap();
            t.push('\n');
            t.push_str(&line);
            // Si tiene solo la coda: un log di errore molto lungo non serve.
            if t.len() > 4000 {
                let cut = t.len() - 2000;
                *t = t[cut..].to_string();
            }
        }
    });

    let stdout = child.stdout.take().expect("stdout richiesto come pipe");
    let mut killed_by_user = false;
    for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
        if reporter.cancelled() {
            let _ = child.kill();
            killed_by_user = true;
            break;
        }
        if let Some(pct) = parse_progress_percent(&line) {
            reporter.progress(pct);
        }
        reporter.log(&line);
    }

    let status = child.wait()?;
    let _ = stderr_thread.join();

    if killed_by_user || reporter.cancelled() {
        return Err(OndoError::conflict("Download interrotto dall'utente."));
    }
    if status.success() {
        return Ok(());
    }

    let stderr_tail = tail.lock().unwrap().trim().to_string();
    // Le righe di stderr non passano dal reporter durante l'esecuzione (sono su un
    // altro thread): si riversano qui, così l'utente le vede comunque.
    for line in stderr_tail.lines() {
        reporter.log(line);
    }
    Err(OndoError::new(
        ErrorKind::Io,
        format!(
            "yt-dlp terminato con codice {}: {stderr_tail}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ),
    ))
}

/// Esegue yt-dlp catturando stdout come JSON (per `-J`), senza streaming.
fn run_ytdlp_json(paths: &Paths, args: &[String], what: &str) -> Result<Value> {
    let output = Command::new(&paths.ytdlp_binary_path)
        .args(args)
        .current_dir(&paths.project_root)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            OndoError::new(
                ErrorKind::Io,
                format!("Impossibile avviare yt-dlp ({what}): {e}. Esegui `npm run setup`."),
            )
        })?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let tail: String = err.chars().rev().take(500).collect::<String>().chars().rev().collect();
        return Err(OndoError::new(
            ErrorKind::Io,
            format!(
                "yt-dlp ({what}) terminato con codice {}: {}",
                output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                tail.trim()
            ),
        ));
    }

    Ok(serde_json::from_slice(&output.stdout)?)
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

fn base_args() -> Vec<String> {
    let mut v = owned(&JS_RUNTIME_ARGS);
    v.extend(owned(&PLAYER_CLIENT_ARGS));
    v
}

// ── Interrogazioni ──────────────────────────────────────────────────────────

pub fn get_ytdlp_version() -> Result<String> {
    let paths = get_paths()?;
    let output = Command::new(&paths.ytdlp_binary_path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| OndoError::new(ErrorKind::Io, format!("yt-dlp non eseguibile: {e}")))?;
    if !output.status.success() {
        return Err(OndoError::new(ErrorKind::Io, "yt-dlp --version è fallito."));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Debug, Clone)]
pub struct PlaylistEntry {
    pub id: String,
    pub title: Option<String>,
    pub channel_name: Option<String>,
    pub duration_seconds: Option<f64>,
    pub playlist_index: u64,
}

#[derive(Debug, Clone)]
pub struct PlaylistListing {
    pub title: Option<String>,
    /// Totale dichiarato da YouTube. Se differisce dagli entry enumerati, qualche
    /// video non era visibile in questa estrazione (privato/rimosso/glitch).
    /// Può essere `None` se yt-dlp non lo espone.
    pub declared_count: Option<u64>,
    pub entries: Vec<PlaylistEntry>,
}

/// `--flat-playlist -J`: economico, non tocca alcun file.
pub fn get_playlist_entries(playlist_url: &str) -> Result<PlaylistListing> {
    let paths = get_paths()?;
    let mut args = base_args();
    args.extend(owned(&["--flat-playlist", "-J", playlist_url]));
    let data = run_ytdlp_json(&paths, &args, "enumerazione playlist")?;

    let entries = data
        .get("entries")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .enumerate()
                .filter_map(|(i, e)| {
                    Some(PlaylistEntry {
                        id: e.get("id")?.as_str()?.to_string(),
                        title: e.get("title").and_then(Value::as_str).map(str::to_string),
                        channel_name: e
                            .get("channel")
                            .and_then(Value::as_str)
                            .or_else(|| e.get("uploader").and_then(Value::as_str))
                            .map(str::to_string),
                        duration_seconds: e.get("duration").and_then(Value::as_f64),
                        playlist_index: i as u64 + 1,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(PlaylistListing {
        title: data.get("title").and_then(Value::as_str).map(str::to_string),
        declared_count: data.get("playlist_count").and_then(Value::as_u64),
        entries,
    })
}

#[derive(Debug, Clone)]
pub struct FormatsSummary {
    pub max_video_height: u64,
    pub max_combined_height: u64,
    pub has_audio_only: bool,
    /// Altezze distinte dei formati con video, dalla più alta: è la lista che si
    /// mostra all'utente per scegliere la risoluzione.
    pub available_heights: Vec<u64>,
    /// La miglior risoluzione video-only supera il miglior combinato **e** non
    /// c'è audio-only da fondere: yt-dlp ripiegherebbe sul combinato basso
    /// (spesso 360p) senza dirlo. Serve chiedere all'utente.
    pub needs_audio_choice: bool,
}

/// Analizza i formati esposti da un'estrazione `-J` per capire se la qualità
/// piena è ottenibile out-of-the-box o se serve una scelta.
pub fn summarize_formats(info: &Value) -> FormatsSummary {
    let empty = Vec::new();
    let formats = info.get("formats").and_then(Value::as_array).unwrap_or(&empty);

    let has_codec = |f: &Value, key: &str| {
        f.get(key)
            .and_then(Value::as_str)
            .map(|c| !c.is_empty() && c != "none")
            .unwrap_or(false)
    };
    let height = |f: &Value| f.get("height").and_then(Value::as_u64).unwrap_or(0);

    let mut max_video_height = 0;
    let mut max_combined_height = 0;
    let mut has_audio_only = false;
    let mut heights: Vec<u64> = Vec::new();

    for f in formats {
        let v = has_codec(f, "vcodec");
        let a = has_codec(f, "acodec");
        if v {
            let h = height(f);
            max_video_height = max_video_height.max(h);
            if h > 0 && !heights.contains(&h) {
                heights.push(h);
            }
            if a {
                max_combined_height = max_combined_height.max(h);
            }
        } else if a {
            has_audio_only = true;
        }
    }

    heights.sort_unstable_by(|a, b| b.cmp(a));

    FormatsSummary {
        needs_audio_choice: !has_audio_only && max_video_height > max_combined_height,
        max_video_height,
        max_combined_height,
        has_audio_only,
        available_heights: heights,
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedVideo {
    pub id: String,
    pub title: Option<String>,
    pub extractor: Option<String>,
    pub webpage_url: String,
    pub channel_name: Option<String>,
    pub duration_seconds: Option<f64>,
    pub formats: FormatsSummary,
}

/// Risolve id/titolo/canale/extractor di un singolo video da un URL **qualunque**,
/// senza scaricare nulla. È così che il download one-off supporta ogni sito che
/// yt-dlp sa gestire (YouTube, Rumble, …) senza mantenere una lista di pattern:
/// il riconoscimento lo fa yt-dlp. Gli extractor-args specifici di YouTube sono
/// innocui altrove — yt-dlp li ignora se l'extractor in uso non è "youtube".
pub fn resolve_video_info(url: &str) -> Result<ResolvedVideo> {
    let paths = get_paths()?;
    let mut args = base_args();
    args.extend(owned(&["--skip-download", "-J"]));
    if let Some(cookies) = &paths.cookies_path {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    args.push(url.to_string());

    let info = run_ytdlp_json(&paths, &args, "risoluzione video")?;

    if info.get("_type").and_then(Value::as_str) == Some("playlist")
        || info.get("entries").map(Value::is_array).unwrap_or(false)
    {
        return Err(OndoError::invalid(
            "Questo link punta a una playlist/canale, non a un singolo video — \
             usa \"Gestisci fonti\" per una playlist.",
        ));
    }

    let id = info
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| OndoError::invalid("yt-dlp non ha restituito un id per questo link."))?
        .to_string();

    Ok(ResolvedVideo {
        title: info.get("title").and_then(Value::as_str).map(str::to_string),
        extractor: info.get("extractor").and_then(Value::as_str).map(str::to_string),
        webpage_url: info
            .get("webpage_url")
            .and_then(Value::as_str)
            .unwrap_or(url)
            .to_string(),
        channel_name: info
            .get("channel")
            .and_then(Value::as_str)
            .or_else(|| info.get("uploader").and_then(Value::as_str))
            .map(str::to_string),
        duration_seconds: info.get("duration").and_then(Value::as_f64),
        formats: summarize_formats(&info),
        id,
    })
}

/// La foto profilo di un canale non ha una chiave dedicata: vive dentro
/// `thumbnails` (array condiviso con il banner) taggata `avatar_uncropped` —
/// verificato empiricamente contro un canale reale su yt-dlp 2026.07.04.
/// Fallback difensivi: un id che contiene "avatar", poi la thumbnail quadrata più
/// grande (l'avatar è sempre 1:1, il banner molto più largo che alto).
pub fn resolve_channel_avatar(channel_url: &str) -> Result<Option<String>> {
    let paths = get_paths()?;
    let mut args = owned(&JS_RUNTIME_ARGS);
    // --playlist-items 0 evita di enumerare i video del canale: economico.
    args.extend(owned(&["--playlist-items", "0", "-J"]));
    if let Some(cookies) = &paths.cookies_path {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    args.push(channel_url.to_string());

    let data = run_ytdlp_json(&paths, &args, "risoluzione avatar canale")?;
    let empty = Vec::new();
    let thumbs = data.get("thumbnails").and_then(Value::as_array).unwrap_or(&empty);

    let url_of = |t: &Value| t.get("url").and_then(Value::as_str).map(str::to_string);

    if let Some(t) = thumbs.iter().find(|t| t.get("id").and_then(Value::as_str) == Some("avatar_uncropped")) {
        return Ok(url_of(t));
    }
    if let Some(t) = thumbs.iter().find(|t| {
        t.get("id")
            .and_then(Value::as_str)
            .map(|id| id.to_lowercase().contains("avatar"))
            .unwrap_or(false)
    }) {
        return Ok(url_of(t));
    }
    let mut square: Vec<&Value> = thumbs
        .iter()
        .filter(|t| {
            let w = t.get("width").and_then(Value::as_u64);
            let h = t.get("height").and_then(Value::as_u64);
            matches!((w, h), (Some(w), Some(h)) if w > 0 && w == h)
        })
        .collect();
    square.sort_by_key(|t| std::cmp::Reverse(t.get("width").and_then(Value::as_u64).unwrap_or(0)));
    Ok(square.first().copied().and_then(url_of))
}

// ── Selettori di formato ────────────────────────────────────────────────────

/// L'esclusione AV1 è un workaround **specifico di YouTube**: l'AV1 alla
/// risoluzione massima dà 403 sistematico, mentre lo stesso video in VP9 scarica
/// senza problemi (nessun compromesso di qualità: stessa risoluzione). Su altri
/// siti però può escludere l'unico formato disponibile, per questo l'ultimo
/// fallback non la applica.
fn build_format_selector(config_format: &str, max_height: Option<u64>) -> String {
    match max_height {
        None => config_format.to_string(),
        Some(h) => format!(
            "bv*[height<={h}][vcodec!*=av01]+ba/b[height<={h}][vcodec!*=av01]/b[height<={h}]"
        ),
    }
}

/// Opzione A: solo il miglior formato **combinato** (audio+video già insieme),
/// coerente ma a risoluzione più bassa.
fn combined_selector(max_height: Option<u64>) -> String {
    let h = max_height.map(|h| format!("[height<={h}]")).unwrap_or_default();
    format!("b{h}[vcodec!*=av01]/b{h}/b")
}

/// Opzione B: il miglior flusso **video-only**, da fondere poi con l'audio via
/// ffmpeg (yt-dlp non sa prendere l'audio da un combinato in un merge `-f`).
fn video_only_selector(max_height: Option<u64>) -> String {
    let h = max_height.map(|h| format!("[height<={h}]")).unwrap_or_default();
    format!("bv*{h}[vcodec!*=av01]/bv*{h}/bv*")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AudioStrategy {
    /// Selettore di default: video-only + audio-only, poi combinato.
    #[default]
    Auto,
    /// Opzione A: solo il miglior combinato.
    Combined,
    /// Opzione B: video max + audio fuso via ffmpeg.
    Merged,
}

// ── File scritti da yt-dlp ──────────────────────────────────────────────────

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn is_video_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".mp4") || lower.ends_with(".mkv") || lower.ends_with(".webm")
}

#[derive(Debug, Default)]
struct DownloadedFiles {
    video_file: Option<String>,
    info_file: Option<String>,
    thumbnail_file: Option<String>,
}

/// I video vivono in sottocartelle per creator con nome `<Titolo> [<id>].<ext>`:
/// non basta un match per prefisso. Si cerca ricorsivamente il file il cui
/// basename contiene il marker `[<id>]` — l'id è univoco, quindi il match è
/// robusto qualunque sia la sanitizzazione che yt-dlp applica al titolo.
/// I percorsi tornano **relativi** a `videosDir` con separatori `/`, così
/// finiscono direttamente in `video.localPath`.
fn find_downloaded_files(paths: &Paths, video_id: &str) -> DownloadedFiles {
    let marker = format!("[{video_id}]");
    let mut all = Vec::new();
    if paths.videos_dir.is_dir() {
        walk_files(&paths.videos_dir, &mut all);
    }

    let matching: Vec<&PathBuf> = all
        .iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(&marker))
                .unwrap_or(false)
        })
        .collect();

    let to_rel = |abs: &Path| {
        abs.strip_prefix(&paths.videos_dir)
            .ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"))
    };

    let video_file = matching
        .iter()
        .find(|p| p.file_name().and_then(|n| n.to_str()).map(is_video_ext).unwrap_or(false))
        .and_then(|p| to_rel(p));
    let info_file = matching
        .iter()
        .find(|p| p.to_string_lossy().ends_with(".info.json"))
        .and_then(|p| to_rel(p));

    let thumbnail_file = std::fs::read_dir(&paths.covers_dir)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .find(|n| {
                    n.starts_with(&format!("{video_id}."))
                        && ["jpg", "jpeg", "png", "webp"]
                            .iter()
                            .any(|ext| n.to_lowercase().ends_with(ext))
                })
        });

    DownloadedFiles { video_file, info_file, thumbnail_file }
}

/// Se il download fallisce, yt-dlp può aver già scritto `.info.json` e/o la
/// thumbnail: senza pulizia restano orfani (invisibili, ma occupano spazio).
/// Il file `.part` del video viene invece **deliberatamente preservato**: yt-dlp
/// lo userà per riprendere il download dal punto in cui si era fermato.
fn cleanup_failed_artifacts(paths: &Paths, video_id: &str) {
    let marker = format!("[{video_id}]");
    let mut all = Vec::new();
    if paths.videos_dir.is_dir() {
        walk_files(&paths.videos_dir, &mut all);
    }
    for path in all {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.contains(&marker) {
            continue;
        }
        if name.ends_with(".part") || is_video_ext(name) {
            continue;
        }
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(entries) = std::fs::read_dir(&paths.covers_dir) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_str()
                .map(|n| n.starts_with(&format!("{video_id}.")))
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

pub fn hash_file_sha256(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

// ── Mappatura info.json → schema del catalogo ───────────────────────────────

fn iso_date_from_yyyymmdd(value: Option<&str>) -> Value {
    match value {
        Some(s) if s.len() == 8 => json!(format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])),
        _ => Value::Null,
    }
}

fn opt(info: &Value, key: &str) -> Value {
    info.get(key).cloned().unwrap_or(Value::Null)
}

fn first_of(info: &Value, a: &str, b: &str) -> Value {
    match info.get(a) {
        Some(v) if !v.is_null() => v.clone(),
        _ => opt(info, b),
    }
}

pub struct MapArgs<'a> {
    pub video_file: Option<&'a str>,
    pub thumbnail_file: Option<&'a str>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<&'a str>,
    pub ytdlp_version: Option<&'a str>,
}

/// Porting di `mapInfoJsonToVideoFields()`. Restituisce **solo** i campi curati
/// da fondere nella entry di catalogo, nello stesso ordine del JS.
pub fn map_info_json_to_video_fields(info: &Value, args: MapArgs<'_>) -> Value {
    let requested = info
        .get("requested_downloads")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);

    let codec = |key: &str| match requested.get(key) {
        Some(v) if !v.is_null() => v.clone(),
        _ => opt(info, key),
    };

    let container = args
        .video_file
        .and_then(|f| f.rsplit_once('.').map(|(_, e)| json!(e)))
        .unwrap_or(Value::Null);

    json!({
        "title": opt(info, "title"),
        "description": opt(info, "description"),
        "webpageUrl": opt(info, "webpage_url"),
        "originalUrl": first_of(info, "original_url", "webpage_url"),
        "extractor": opt(info, "extractor"),
        "channel": {
            "id": opt(info, "channel_id"),
            "name": first_of(info, "channel", "uploader"),
            "url": opt(info, "channel_url"),
            "uploaderId": opt(info, "uploader_id"),
            "uploaderUrl": opt(info, "uploader_url"),
            "subscriberCountAtDownload": opt(info, "channel_follower_count")
        },
        "uploadDate": iso_date_from_yyyymmdd(info.get("upload_date").and_then(Value::as_str)),
        "releaseTimestamp": match info.get("release_timestamp").and_then(Value::as_i64) {
            Some(ts) => json!(crate::time::from_epoch_millis(ts * 1000)),
            None => Value::Null,
        },
        "durationSeconds": opt(info, "duration"),
        "categories": info.get("categories").cloned().unwrap_or(json!([])),
        "tags": info.get("tags").cloned().unwrap_or(json!([])),
        "language": opt(info, "language"),
        "ageLimit": opt(info, "age_limit"),
        "availability": opt(info, "availability"),
        "license": opt(info, "license"),
        "isLive": json!(info.get("is_live").and_then(Value::as_bool).unwrap_or(false)),
        "wasLive": json!(info.get("was_live").and_then(Value::as_bool).unwrap_or(false)),
        "statsAtDownload": {
            "viewCount": opt(info, "view_count"),
            "likeCount": opt(info, "like_count"),
            "commentCount": opt(info, "comment_count"),
            "averageRating": opt(info, "average_rating")
        },
        "resolution": {
            "width": opt(info, "width"),
            "height": opt(info, "height"),
            "fps": opt(info, "fps"),
            "dynamicRange": opt(info, "dynamic_range")
        },
        "thumbnails": info.get("thumbnails").and_then(Value::as_array).map(|arr| {
            Value::Array(arr.iter().map(|t| json!({
                "url": opt(t, "url"), "width": opt(t, "width"), "height": opt(t, "height")
            })).collect())
        }).unwrap_or(json!([])),
        "thumbnail": {
            "sourceUrl": opt(info, "thumbnail"),
            "localPath": args.thumbnail_file.map(|f| json!(f)).unwrap_or(Value::Null)
        },
        "chapters": info.get("chapters").and_then(Value::as_array).map(|arr| {
            Value::Array(arr.iter().map(|c| json!({
                "title": opt(c, "title"),
                "startSeconds": opt(c, "start_time"),
                "endSeconds": opt(c, "end_time")
            })).collect())
        }).unwrap_or(json!([])),
        "subtitleLanguagesAvailable": info.get("subtitles").and_then(Value::as_object)
            .map(|m| Value::Array(m.keys().map(|k| json!(k)).collect()))
            .unwrap_or(json!([])),
        "video": {
            "localPath": args.video_file.map(|f| json!(f)).unwrap_or(Value::Null),
            "formatId": opt(info, "format_id"),
            "container": container,
            "videoCodec": codec("vcodec"),
            "audioCodec": codec("acodec"),
            "bitrateKbps": opt(info, "tbr"),
            "sizeBytes": args.size_bytes.map(|s| json!(s)).unwrap_or(Value::Null),
            "sha256": args.sha256.map(|s| json!(s)).unwrap_or(Value::Null),
            "downloadedAt": json!(now_iso8601()),
            "ytdlpVersion": args.ytdlp_version.map(|v| json!(v)).unwrap_or(Value::Null)
        }
    })
}

/// "Segnala soltanto": un download ≤360p su YouTube è quasi sempre un **ripiego**
/// (estrazione degradata / gating PO-token), non la qualità reale del video. Va
/// segnalato sempre, anche quando l'intera estrazione era degradata a 360p — caso
/// reale in cui il vecchio confronto "max > scaricato" non scattava mai e
/// l'utente non veniva avvisato. `maxAvailableHeight` è noto solo se *questa*
/// estrazione esponeva formati più alti; altrimenti null = "non noto".
fn detect_quality_note(info: &Value) -> Value {
    let downloaded = info.get("height").and_then(Value::as_u64).unwrap_or(0);
    if downloaded == 0 || downloaded > 360 {
        return Value::Null;
    }
    let summary = summarize_formats(info);
    json!({
        "downloadedHeight": downloaded,
        "maxAvailableHeight": if summary.max_video_height > downloaded {
            json!(summary.max_video_height)
        } else {
            Value::Null
        },
        "at": now_iso8601()
    })
}

// ── Download ────────────────────────────────────────────────────────────────

fn build_download_args(
    paths: &Paths,
    merge_format: &str,
    format_selector: &str,
    url: &str,
    use_cookies: bool,
) -> Vec<String> {
    let mut args = base_args();
    args.extend(owned(&["-f", format_selector]));
    args.extend(owned(&["--merge-output-format", merge_format]));
    args.extend(owned(&[
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--write-info-json",
        // --newline: senza, yt-dlp aggiorna l'avanzamento con \r sulla stessa
        // riga e il lettore a righe non vede nulla fino alla fine.
        "--newline",
    ]));

    // Archivio canonico per creator: media/videos/<Creator>/<Titolo> [<id>].<ext>.
    // yt-dlp sanifica da sé i caratteri non validi e crea le sottocartelle; il
    // fallback |Sconosciuto copre i rari casi senza channel/uploader.
    // L'.info.json segue automaticamente questo stesso template.
    args.push("-o".into());
    args.push(
        paths
            .videos_dir
            .join("%(channel,uploader|Sconosciuto)s")
            .join("%(title)s [%(id)s].%(ext)s")
            .display()
            .to_string(),
    );
    // Le thumbnail restano piatte per id (interne, non sfogliate dall'utente).
    args.push("-o".into());
    args.push(format!(
        "thumbnail:{}",
        paths.covers_dir.join("%(id)s.%(ext)s").display()
    ));
    args.push("--download-archive".into());
    args.push(paths.download_archive_path.display().to_string());

    if let Some(loc) = &paths.ffmpeg_location {
        args.push("--ffmpeg-location".into());
        args.push(loc.display().to_string());
    }
    if use_cookies {
        if let Some(cookies) = &paths.cookies_path {
            args.push("--cookies".into());
            args.push(cookies.display().to_string());
        }
    }
    args.push(url.to_string());
    args
}

/// Args per scaricare la sola miglior traccia audio in un file temporaneo:
/// niente info.json/thumbnail/archivio, che restano di competenza del download
/// video-only principale.
fn build_audio_only_args(paths: &Paths, out_template: &str, url: &str, use_cookies: bool) -> Vec<String> {
    let mut args = base_args();
    args.extend(owned(&["-f", "ba*/b", "--newline", "-o", out_template]));
    if let Some(loc) = &paths.ffmpeg_location {
        args.push("--ffmpeg-location".into());
        args.push(loc.display().to_string());
    }
    if use_cookies {
        if let Some(cookies) = &paths.cookies_path {
            args.push("--cookies".into());
            args.push(cookies.display().to_string());
        }
    }
    args.push(url.to_string());
    args
}

/// Esegue con il fallback sui cookie: **prima senza**.
///
/// Motivo verificato: inviare i cookie del browser insieme all'identità client
/// `android_vr` (usata per bypassare l'esperimento PO Token) produce un mix che
/// la CDN video di YouTube tratta come sospetto e rifiuta con 403, *anche quando*
/// le fasi di estrazione precedenti con quegli stessi cookie riescono. Tutti i
/// video di un catalogo personale sono tipicamente pubblici, quindi il primo
/// tentativo è senza; il retry con cookie resta per l'unico caso in cui servono
/// davvero, i video privati/non listati del proprio account.
fn run_with_cookie_fallback(
    paths: &Paths,
    video_id: &str,
    reporter: &dyn Reporter,
    build: impl Fn(bool) -> Vec<String>,
) -> Result<()> {
    match run_ytdlp(paths, &build(false), reporter) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Interruzione manuale: mai il retry — l'utente ha chiesto di
            // fermarsi, non di riprovare in un altro modo.
            if reporter.cancelled() || paths.cookies_path.is_none() {
                return Err(first);
            }
            reporter.log(
                "Primo tentativo (senza cookie) fallito, riprovo con i cookie \
                 (potrebbe essere un video privato/non listato)...",
            );
            cleanup_failed_artifacts(paths, video_id);
            run_ytdlp(paths, &build(true), reporter)
        }
    }
}

/// Scarica un video e restituisce i campi curati da fondere nel catalogo.
///
/// `video_id` è l'id già risolto (da `resolve_video_info` o dall'enumerazione
/// playlist), usato **solo** per ritrovare i file scritti da yt-dlp. `url` è il
/// link reale da cui scaricare — qualunque sito, non solo YouTube: passare un URL
/// YouTube ricostruito dall'id era un bug vero, trovato su un video Rumble.
/// ⚠️ **Il chiamante deve aver già togliato l'id da `--download-archive`.** Una riga
/// residua fa *saltare* il download a yt-dlp, che esce con successo senza scrivere
/// l'`.info.json` → "file mancanti" → il video finisce `failed` pur avendo un file.
/// La pulizia sta in `ops` perché tocca lo stato su disco, non qui.
pub fn download_video(
    video_id: &str,
    url: &str,
    strategy: AudioStrategy,
    max_height: Option<Option<u64>>,
    reporter: &dyn Reporter,
) -> Result<Extracted> {
    let paths = get_paths()?;
    let config = load_config()?;

    // Tetto effettivo: la scelta per-download se passata, altrimenti il default
    // globale. `None` esterno = "usa config"; `Some(None)` = "massima" (nessun cap).
    let effective_max_height = match max_height {
        Some(explicit) => explicit,
        None => config.pointer("/ytdlp/maxHeight").and_then(Value::as_u64),
    };
    let merge_format = config
        .pointer("/ytdlp/mergeOutputFormat")
        .and_then(Value::as_str)
        .unwrap_or("mp4")
        .to_string();
    let config_format = config
        .pointer("/ytdlp/format")
        .and_then(Value::as_str)
        .unwrap_or("bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b")
        .to_string();

    let result = if strategy == AudioStrategy::Merged {
        download_merged(video_id, url, &paths, &merge_format, effective_max_height, reporter)
    } else {
        let selector = if strategy == AudioStrategy::Combined {
            combined_selector(effective_max_height)
        } else {
            build_format_selector(&config_format, effective_max_height)
        };
        run_with_cookie_fallback(&paths, video_id, reporter, |use_cookies| {
            build_download_args(&paths, &merge_format, &selector, url, use_cookies)
        })
        .and_then(|()| finalize_download(&paths, video_id))
    };

    match result {
        Ok(fields) => Ok(fields),
        Err(err) => {
            cleanup_failed_artifacts(&paths, video_id);
            Err(err)
        }
    }
}

/// Opzione B: scarica il miglior video-only e la miglior traccia audio in due
/// passaggi, poi li fonde con ffmpeg. Serve perché in un'estrazione degradata
/// (nessun audio-only, video-only alto + solo un combinato basso) yt-dlp da solo
/// scarterebbe il combinato in un merge `-f`, lasciando video senza audio.
fn download_merged(
    video_id: &str,
    url: &str,
    paths: &Paths,
    merge_format: &str,
    max_height: Option<u64>,
    reporter: &dyn Reporter,
) -> Result<Extracted> {
    let audio_template = paths
        .covers_dir
        .join(format!("__mux_{video_id}_audio.%(ext)s"))
        .display()
        .to_string();

    let outcome = (|| -> Result<Extracted> {
        reporter.log("Strategia \"fusione\": scarico il flusso video alla massima risoluzione...");
        let selector = video_only_selector(max_height);
        run_with_cookie_fallback(paths, video_id, reporter, |use_cookies| {
            build_download_args(paths, merge_format, &selector, url, use_cookies)
        })?;

        reporter.log("Scarico la migliore traccia audio disponibile...");
        run_with_cookie_fallback(paths, video_id, reporter, |use_cookies| {
            build_audio_only_args(paths, &audio_template, url, use_cookies)
        })?;

        let found = find_downloaded_files(paths, video_id);
        let video_rel = found.video_file.ok_or_else(|| {
            OndoError::new(
                ErrorKind::Io,
                format!("Flusso video non trovato dopo il download per {video_id}"),
            )
        })?;
        let video_abs = paths.videos_dir.join(&video_rel);
        let audio_abs = find_temp_audio_file(paths, video_id).ok_or_else(|| {
            OndoError::new(
                ErrorKind::Io,
                format!("Traccia audio non trovata dopo il download per {video_id}"),
            )
        })?;

        reporter.log("Fondo video e audio (ffmpeg)...");
        let merged = mux_video_audio(paths, &video_abs, &audio_abs, reporter)?;
        if merged != video_abs && video_abs.exists() {
            let _ = std::fs::remove_file(&video_abs);
        }
        let _ = std::fs::remove_file(&audio_abs);

        finalize_download(paths, video_id)
    })();

    if outcome.is_err() {
        if let Some(leftover) = find_temp_audio_file(paths, video_id) {
            let _ = std::fs::remove_file(leftover);
        }
    }
    outcome
}

fn find_temp_audio_file(paths: &Paths, video_id: &str) -> Option<PathBuf> {
    let prefix = format!("__mux_{video_id}_audio.");
    std::fs::read_dir(&paths.covers_dir).ok().and_then(|entries| {
        entries
            .flatten()
            .find(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
            })
            .map(|e| e.path())
    })
}

/// Fonde video + audio in un mp4 (stream copy, nessuna ricodifica) mappando il
/// video dal primo input e l'audio dal secondo.
fn mux_video_audio(paths: &Paths, video_abs: &Path, audio_abs: &Path, reporter: &dyn Reporter) -> Result<PathBuf> {
    let dir = video_abs.parent().unwrap_or(&paths.videos_dir);
    let stem = video_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| OndoError::new(ErrorKind::Io, "Nome file video non leggibile."))?;
    let final_abs = dir.join(format!("{stem}.mp4"));
    let tmp_abs = dir.join(format!("{stem}.__muxtmp.mp4"));

    let bin = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let ffmpeg = paths
        .ffmpeg_location
        .as_ref()
        .map(|loc| loc.join(bin))
        .unwrap_or_else(|| PathBuf::from(bin));

    let output = Command::new(&ffmpeg)
        .args(["-y", "-i"])
        .arg(video_abs)
        .arg("-i")
        .arg(audio_abs)
        .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart"])
        .arg(&tmp_abs)
        .stdin(Stdio::null())
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_abs);
            return Err(OndoError::new(
                ErrorKind::Io,
                format!("Impossibile avviare ffmpeg ({}): {e}", ffmpeg.display()),
            ));
        }
    };

    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp_abs);
        let err = String::from_utf8_lossy(&output.stderr);
        let tail: String = err.lines().rev().take(10).collect::<Vec<_>>().join("\n");
        reporter.log(&tail);
        return Err(OndoError::new(
            ErrorKind::Io,
            format!("ffmpeg (fusione video+audio) è fallito: {}", tail.trim()),
        ));
    }

    if final_abs.exists() && final_abs != video_abs {
        let _ = std::fs::remove_file(&final_abs);
    }
    std::fs::rename(&tmp_abs, &final_abs)?;
    Ok(final_abs)
}

/// Passi comuni post-download: individua i file scritti da yt-dlp, legge
/// l'`.info.json`, calcola size/sha, mappa i campi curati e aggiunge la nota di
/// qualità. **Restituisce** anche il grezzo: archiviarlo tocca a `ops`.
fn finalize_download(paths: &Paths, video_id: &str) -> Result<Extracted> {
    let found = find_downloaded_files(paths, video_id);
    let (Some(video_rel), Some(info_rel)) = (found.video_file.as_ref(), found.info_file.as_ref()) else {
        return Err(OndoError::new(
            ErrorKind::Io,
            format!(
                "Download completato ma file mancanti per {video_id} (video: {:?}, info.json: {:?})",
                found.video_file, found.info_file
            ),
        ));
    };

    let info_abs = paths.videos_dir.join(info_rel);
    let video_abs = paths.videos_dir.join(video_rel);
    let info: Value = serde_json::from_str(&std::fs::read_to_string(&info_abs)?)?;
    let size_bytes = std::fs::metadata(&video_abs)?.len();
    let sha256 = hash_file_sha256(&video_abs)?;
    let version = get_ytdlp_version().unwrap_or_default();

    // Il sidecar si cancella qui (è un file che abbiamo prodotto noi, e non lasciarne
    // in giro fa parte del contratto di questo layer); il suo *contenuto* torna al
    // chiamante, che decide dove archiviarlo.
    let _ = std::fs::remove_file(&info_abs);

    let mut fields = map_info_json_to_video_fields(
        &info,
        MapArgs {
            video_file: Some(video_rel),
            thumbnail_file: found.thumbnail_file.as_deref(),
            size_bytes: Some(size_bytes),
            sha256: Some(&sha256),
            ytdlp_version: Some(&version),
        },
    );
    if let Some(video) = fields.get_mut("video").and_then(Value::as_object_mut) {
        video.insert("qualityNote".into(), detect_quality_note(&info));
    }
    Ok(Extracted { fields, raw_info: info })
}

/// Arricchimento metadati: estrae i metadati **completi** di un video senza
/// scaricarlo e ne cacha la copertina in `media/thumbnails/<id>.jpg`. Così la
/// libreria si popola di schede ricche subito dopo aver aggiunto una fonte, e un
/// video poi "rimosso" conserva la copertina anche quando l'URL YouTube muore —
/// che è il punto dell'intero progetto.
pub fn fetch_video_metadata(video_id: &str, url: &str, reporter: &dyn Reporter) -> Result<Extracted> {
    let paths = get_paths()?;
    let mut args = base_args();
    args.extend(owned(&[
        "--skip-download",
        "--write-info-json",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
    ]));
    args.push("-o".into());
    args.push(paths.covers_dir.join("%(id)s.%(ext)s").display().to_string());
    if let Some(loc) = &paths.ffmpeg_location {
        args.push("--ffmpeg-location".into());
        args.push(loc.display().to_string());
    }
    // I cookie qui sono innocui: l'estrazione dei soli metadati non scarica i byte
    // del video dalla CDN, dove il mix cookie+android_vr darebbe 403.
    if let Some(cookies) = &paths.cookies_path {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    args.push(url.to_string());

    run_ytdlp(&paths, &args, reporter)?;

    let info_path = paths.covers_dir.join(format!("{video_id}.info.json"));
    if !info_path.is_file() {
        return Err(OndoError::new(
            ErrorKind::Io,
            format!("Metadati non trovati dopo l'estrazione per {video_id}"),
        ));
    }
    let info: Value = serde_json::from_str(&std::fs::read_to_string(&info_path)?)?;

    // Pulisce le thumbnail intermedie (es. .webp prima della conversione a jpg)
    // per non lasciare orfani accanto alla copertina definitiva.
    if let Ok(entries) = std::fs::read_dir(&paths.covers_dir) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            if name.starts_with(&format!("{video_id}."))
                && !name.ends_with(".jpg")
                && !name.ends_with(".info.json")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let thumb = paths.covers_dir.join(format!("{video_id}.jpg"));
    let thumbnail_file = thumb.is_file().then(|| format!("{video_id}.jpg"));

    let fields = map_info_json_to_video_fields(
        &info,
        MapArgs {
            video_file: None,
            thumbnail_file: thumbnail_file.as_deref(),
            size_bytes: None,
            sha256: None,
            ytdlp_version: None,
        },
    );
    let _ = std::fs::remove_file(&info_path);
    Ok(Extracted { fields, raw_info: info })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_parsed_from_download_lines() {
        assert_eq!(parse_progress_percent("[download]  45.3% of 100MiB"), Some(45.3));
        assert_eq!(parse_progress_percent("[download] 100.0% of 1KiB"), Some(100.0));
        assert_eq!(parse_progress_percent("[download] Destination: file.mp4"), None);
        assert_eq!(parse_progress_percent("[info] qualcosa 50%"), None);
        assert_eq!(parse_progress_percent(""), None);
    }

    #[test]
    fn gone_errors_are_recognised_in_all_three_real_variants() {
        assert!(is_video_gone_error("ERROR: [youtube] x: Private video. Sign in if you've been granted access"));
        assert!(is_video_gone_error(
            "ERROR: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated."
        ));
        assert!(is_video_gone_error(
            "ERROR: Video unavailable. It was removed following a copyright removal request"
        ));
        // Un errore di rete NON deve essere confuso con "sparito per sempre".
        assert!(!is_video_gone_error("ERROR: unable to download: HTTP Error 503"));
        assert!(!is_video_gone_error(""));
    }

    #[test]
    fn format_selectors_match_the_javascript_strings() {
        let default_fmt = "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b";
        assert_eq!(build_format_selector(default_fmt, None), default_fmt);
        assert_eq!(
            build_format_selector(default_fmt, Some(720)),
            "bv*[height<=720][vcodec!*=av01]+ba/b[height<=720][vcodec!*=av01]/b[height<=720]"
        );
        assert_eq!(combined_selector(None), "b[vcodec!*=av01]/b/b");
        assert_eq!(combined_selector(Some(480)), "b[height<=480][vcodec!*=av01]/b[height<=480]/b");
        assert_eq!(video_only_selector(None), "bv*[vcodec!*=av01]/bv*/bv*");
        assert_eq!(video_only_selector(Some(1080)), "bv*[height<=1080][vcodec!*=av01]/bv*[height<=1080]/bv*");
    }

    #[test]
    fn formats_summary_detects_the_missing_audio_only_trap() {
        // Il caso che M55 esisteva per intercettare: video-only a 1080 ma nessun
        // audio-only, e solo un combinato a 360 → yt-dlp ripiegherebbe sul 360.
        let info = serde_json::json!({ "formats": [
            { "vcodec": "avc1", "acodec": "none", "height": 1080 },
            { "vcodec": "avc1", "acodec": "mp4a", "height": 360 }
        ]});
        let s = summarize_formats(&info);
        assert_eq!(s.max_video_height, 1080);
        assert_eq!(s.max_combined_height, 360);
        assert!(!s.has_audio_only);
        assert!(s.needs_audio_choice, "va chiesta la strategia audio all'utente");
        assert_eq!(s.available_heights, vec![1080, 360]);

        // Caso sano: c'è l'audio-only, nessuna scelta necessaria.
        let info = serde_json::json!({ "formats": [
            { "vcodec": "avc1", "acodec": "none", "height": 1080 },
            { "vcodec": "none", "acodec": "mp4a" },
            { "vcodec": "avc1", "acodec": "mp4a", "height": 360 }
        ]});
        let s = summarize_formats(&info);
        assert!(s.has_audio_only);
        assert!(!s.needs_audio_choice);
    }

    #[test]
    fn quality_note_flags_low_resolution_even_when_extraction_was_degraded() {
        // Caso reale: l'intera estrazione era degradata a 360p, quindi
        // "max > scaricato" non scattava e l'utente non veniva avvisato.
        let info = serde_json::json!({ "height": 360, "formats": [
            { "vcodec": "avc1", "acodec": "mp4a", "height": 360 }
        ]});
        let note = detect_quality_note(&info);
        assert_eq!(note["downloadedHeight"], 360);
        assert!(note["maxAvailableHeight"].is_null(), "non noto, non zero");

        // Con formati più alti nella stessa estrazione, il massimo è noto.
        let info = serde_json::json!({ "height": 360, "formats": [
            { "vcodec": "avc1", "acodec": "none", "height": 1080 },
            { "vcodec": "avc1", "acodec": "mp4a", "height": 360 }
        ]});
        assert_eq!(detect_quality_note(&info)["maxAvailableHeight"], 1080);

        // Sopra i 360p nessuna nota.
        assert!(detect_quality_note(&serde_json::json!({ "height": 1080 })).is_null());
    }

    #[test]
    fn upload_date_becomes_iso() {
        assert_eq!(iso_date_from_yyyymmdd(Some("20091025")), serde_json::json!("2009-10-25"));
        assert!(iso_date_from_yyyymmdd(Some("2009")).is_null());
        assert!(iso_date_from_yyyymmdd(None).is_null());
    }

    #[test]
    fn mapping_shapes_the_curated_fields_like_the_js() {
        let info = serde_json::json!({
            "id": "abc", "title": "T", "description": "D",
            "webpage_url": "https://y/watch?v=abc",
            "extractor": "youtube", "channel_id": "UC1", "channel": "Creator",
            "upload_date": "20260101", "duration": 212, "tags": ["a"],
            "is_live": false, "view_count": 10, "height": 1080, "width": 1920,
            "thumbnail": "https://t/x.jpg",
            "thumbnails": [{ "url": "https://t/x.jpg", "width": 1, "height": 2 }],
            "chapters": [{ "title": "Intro", "start_time": 0, "end_time": 18 }],
            "subtitles": { "en": [], "it": [] },
            "requested_downloads": [{ "vcodec": "avc1.64", "acodec": "mp4a.40" }],
            "format_id": "248+140", "tbr": 4500
        });
        let out = map_info_json_to_video_fields(
            &info,
            MapArgs {
                video_file: Some("Creator/T [abc].mp4"),
                thumbnail_file: Some("abc.jpg"),
                size_bytes: Some(123),
                sha256: Some("deadbeef"),
                ytdlp_version: Some("2026.07.04"),
            },
        );

        assert_eq!(out["title"], "T");
        assert_eq!(out["channel"]["name"], "Creator");
        assert_eq!(out["uploadDate"], "2026-01-01");
        // originalUrl ricade su webpage_url quando original_url manca.
        assert_eq!(out["originalUrl"], "https://y/watch?v=abc");
        assert_eq!(out["video"]["localPath"], "Creator/T [abc].mp4");
        assert_eq!(out["video"]["container"], "mp4");
        assert_eq!(out["video"]["videoCodec"], "avc1.64", "preso da requested_downloads");
        assert_eq!(out["video"]["sha256"], "deadbeef");
        assert_eq!(out["thumbnail"]["localPath"], "abc.jpg");
        assert_eq!(out["chapters"][0]["startSeconds"], 0);
        assert_eq!(out["subtitleLanguagesAvailable"].as_array().unwrap().len(), 2);
        // I campi assenti diventano null, non vengono omessi: il formato su disco
        // deve restare identico a quello prodotto dal JS.
        assert!(out["license"].is_null());
        assert!(out["releaseTimestamp"].is_null());
    }
}
