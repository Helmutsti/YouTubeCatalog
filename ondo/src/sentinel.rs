//! Il **sentinel**: un guardiano per video, quattro passi, che riferisce.
//!
//! 1. risoluzione del link,
//! 2. metadati + copertina,
//! 3. download del video,
//! 4. `done`.
//!
//! Gira su un thread del pool ([`crate::Downloader`]), non in un processo a parte:
//! quello che può impiantarsi è **yt-dlp**, che è un sottoprocesso in ogni caso, e
//! tenendolo noi possiamo ucciderlo direttamente invece di sperare che si accorga
//! di una pipe rotta. Non scrive lo stato della libreria: emette [`Event`] e chi
//! ascolta decide (vedi `ARCHITETTURA.md`).

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::Config;
use crate::error::{Error, Result};
use crate::model::author_of;

/// Senza un runtime JavaScript yt-dlp non decifra le firme dei formati recenti e i
/// download muoiono a metà con 403.
const JS_RUNTIME: [&str; 2] = ["--js-runtimes", "node"];

/// Alcuni video stanno in un esperimento YouTube che pretende un "PO Token" dai
/// client normali. `android_vr` non è soggetto all'esperimento; sta **accanto** a
/// `default`, non al suo posto, così i video non coinvolti usano i client abituali.
const PLAYER_CLIENTS: [&str; 2] =
    ["--extractor-args", "youtube:player_client=default,android_vr,web_embedded"];

/// I quattro passi, in ordine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Risoluzione del link.
    Resolve,
    /// Metadati e copertina.
    Metadata,
    /// Download del video.
    Video,
}

impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Phase::Resolve => "risoluzione",
            Phase::Metadata => "metadati",
            Phase::Video => "download",
        }
    }
}

/// Quello che un sentinel può dire, mentre lo fa.
///
/// Resta serializzabile anche se non attraversa più un confine di processo: è il
/// modo più corto per scriverlo in un log, e `to_line` è quello che si incolla in
/// una segnalazione.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Phase {
        phase: Phase,
    },
    Resolved {
        id: String,
        title: String,
        author: String,
        duration: Option<f64>,
    },
    Metadata {
        path: PathBuf,
    },
    Cover {
        path: PathBuf,
    },
    /// Avanzamento del passo in corso, 0–100.
    Progress {
        percent: f64,
    },
    /// Una riga grezza di yt-dlp/ffmpeg, o il comando esatto che stiamo lanciando.
    Log {
        line: String,
    },
    Done {
        id: String,
        video: PathBuf,
        cover: Option<PathBuf>,
        metadata: PathBuf,
    },
    Error {
        message: String,
    },
}

impl Event {
    /// Una riga sola, da mettere in un log.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|e| format!(r#"{{"event":"error","message":"evento non serializzabile: {e}"}}"#))
    }
}

/// Dove sono i tre file quando un sentinel ha finito.
#[derive(Debug, Clone)]
pub struct Finished {
    pub id: String,
    pub video: PathBuf,
    pub cover: Option<PathBuf>,
    pub metadata: PathBuf,
}

/// Fa i quattro passi su un link, riferendo a `sink` mentre li fa.
///
/// `max_height` è il tetto di risoluzione **di questo download** (`None` = la
/// migliore disponibile): è un parametro e non un campo di `cfg` perché la qualità
/// può essere chiesta link per link.
///
/// `cancel` viene guardato fra i passi e a ogni riga di output: quando diventa vero
/// yt-dlp viene ucciso e si torna con un errore.
pub fn run(
    cfg: &Config,
    url: &str,
    staging: &Path,
    max_height: Option<u32>,
    cancel: &AtomicBool,
    mut sink: impl FnMut(Event),
) -> Result<Finished> {
    std::fs::create_dir_all(staging)?;
    let annullato = || Error::new("annullato".to_string());

    // ── 1. Risoluzione del link ─────────────────────────────────────────────
    if cancel.load(Ordering::Relaxed) {
        return Err(annullato());
    }
    sink(Event::Phase { phase: Phase::Resolve });
    let info = resolve(cfg, url, &mut sink)?;
    let id = info.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    if id.is_empty() {
        return Err(Error::new("yt-dlp non ha restituito un id per questo link".to_string()));
    }
    if info.get("_type").and_then(Value::as_str) == Some("playlist") {
        return Err(Error::new(
            "questo link è una playlist o un canale, non un singolo video".to_string(),
        ));
    }
    sink(Event::Resolved {
        id: id.clone(),
        title: info.get("title").and_then(Value::as_str).unwrap_or(&id).to_string(),
        author: author_of(&info),
        duration: info.get("duration").and_then(Value::as_f64),
    });

    // ── 2. Metadati e copertina ─────────────────────────────────────────────
    if cancel.load(Ordering::Relaxed) {
        return Err(annullato());
    }
    sink(Event::Phase { phase: Phase::Metadata });
    let metadata = write_metadata(staging, &id, info.clone())?;
    sink(Event::Metadata { path: metadata.clone() });

    let cover = match save_cover(cfg, staging, &id, &info) {
        Ok(path) => {
            sink(Event::Cover { path: path.clone() });
            Some(path)
        }
        Err(perche) => {
            // Una copertina mancante non vale la pena di far fallire un download.
            sink(Event::Log { line: format!("copertina non salvata: {perche}") });
            None
        }
    };

    // ── 3. Download del video ───────────────────────────────────────────────
    if cancel.load(Ordering::Relaxed) {
        return Err(annullato());
    }
    sink(Event::Phase { phase: Phase::Video });
    download_video(cfg, url, staging, &id, max_height, cancel, &mut sink)?;
    let video = find_video_file(staging, &id)
        .ok_or_else(|| Error::new(format!("yt-dlp è finito senza lasciare un file video per {id}")))?;

    // ── 4. Fatto ────────────────────────────────────────────────────────────
    //
    // `Done` va **emesso**, non solo restituito: è l'evento terminale su cui chi
    // ascolta chiude il job, aggiorna i conteggi e smette di aspettare. Il valore
    // di ritorno serve a chi chiama `run` direttamente.
    sink(Event::Done {
        id: id.clone(),
        video: video.clone(),
        cover: cover.clone(),
        metadata: metadata.clone(),
    });
    Ok(Finished { id, video, cover, metadata })
}

// ── Passo 1: risoluzione ────────────────────────────────────────────────────

/// `--skip-download -J`: è yt-dlp stesso a riconoscere il sito, quindi funziona
/// per qualunque sito che yt-dlp sappia gestire, senza liste di pattern da tenere
/// aggiornate.
fn resolve(cfg: &Config, url: &str, sink: &mut impl FnMut(Event)) -> Result<Value> {
    let build = |with_cookies: bool| {
        let mut a: Vec<String> = Vec::new();
        a.extend(JS_RUNTIME.iter().map(|s| s.to_string()));
        a.extend(PLAYER_CLIENTS.iter().map(|s| s.to_string()));
        a.push("--no-playlist".into());
        a.push("--skip-download".into());
        a.push("-J".into());
        if with_cookies {
            if let Some(c) = &cfg.cookies {
                a.push("--cookies".into());
                a.push(c.display().to_string());
            }
        }
        a.push(url.to_string());
        a
    };

    let out = match capture(&cfg.ytdlp, &build(false), sink) {
        Ok(out) => out,
        Err(primo) => {
            // I cookie sono il ripiego, non il default: mandarli insieme al client
            // `android_vr` è la combinazione che la CDN di YouTube blocca con 403.
            if cfg.cookies.is_some() {
                sink(Event::Log { line: format!("primo tentativo fallito, riprovo con i cookie: {primo}") });
                capture(&cfg.ytdlp, &build(true), sink)?
            } else {
                return Err(primo);
            }
        }
    };

    serde_json::from_str(&out)
        .map_err(|e| Error::new(format!("yt-dlp ha risposto qualcosa che non è JSON: {e}")))
}

// ── Passo 2: metadati e copertina ───────────────────────────────────────────

/// Salva i metadati grezzi, togliendo `automatic_captions`: è un elenco di URL per
/// i sottotitoli auto-tradotti in 150+ lingue, centinaia di KB per video, che non
/// serve mai a nessuno.
fn write_metadata(staging: &Path, id: &str, mut info: Value) -> Result<PathBuf> {
    if let Some(obj) = info.as_object_mut() {
        obj.remove("automatic_captions");
    }
    let path = staging.join(format!("{id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&info)?)
        .map_err(|e| Error::new(format!("{}: {e}", path.display())))?;
    Ok(path)
}

/// La copertina più grande fra quelle esposte dai metadati, scaricata con
/// **ffmpeg**: fa da client HTTP e converte in jpg in un colpo, così non serve
/// nessuna libreria di rete.
fn save_cover(cfg: &Config, staging: &Path, id: &str, info: &Value) -> Result<PathBuf> {
    let url = best_thumbnail(info).ok_or_else(|| Error::new("nessuna copertina nei metadati".to_string()))?;
    let path = staging.join(format!("{id}.jpg"));
    let out = Command::new(&cfg.ffmpeg)
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&url)
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::new(format!("ffmpeg non avviabile ({}): {e}", cfg.ffmpeg.display())))?;
    if !out.status.success() || !path.is_file() {
        return Err(Error::new(tail(&String::from_utf8_lossy(&out.stderr), 3)));
    }
    Ok(path)
}

fn best_thumbnail(info: &Value) -> Option<String> {
    if let Some(list) = info.get("thumbnails").and_then(Value::as_array) {
        let best = list
            .iter()
            .filter(|t| t.get("url").and_then(Value::as_str).is_some())
            .max_by_key(|t| {
                let w = t.get("width").and_then(Value::as_u64).unwrap_or(0);
                let h = t.get("height").and_then(Value::as_u64).unwrap_or(0);
                w * h
            });
        if let Some(url) = best.and_then(|t| t.get("url")).and_then(Value::as_str) {
            return Some(url.to_string());
        }
    }
    info.get("thumbnail").and_then(Value::as_str).map(str::to_string)
}

// ── Passo 3: download ───────────────────────────────────────────────────────

/// Il selettore di formato. L'AV1 è escluso perché alla stessa risoluzione i suoi
/// formati fallivano sistematicamente con 403 mentre il VP9 no — nessun
/// compromesso sulla qualità, solo un codec in meno. L'ultimo ripiego (`b`, senza
/// filtro) esiste per i siti dove l'AV1 è l'unico formato disponibile: meglio
/// scaricare quello che c'è che fallire senza motivo apparente.
fn format_selector(max_height: Option<u32>) -> String {
    let cap = max_height.map(|h| format!("[height<={h}]")).unwrap_or_default();
    format!("bv*{cap}[vcodec!*=av01]+ba/b{cap}[vcodec!*=av01]/bv*{cap}+ba/b{cap}/b")
}

fn download_video(
    cfg: &Config,
    url: &str,
    staging: &Path,
    id: &str,
    max_height: Option<u32>,
    cancel: &AtomicBool,
    sink: &mut impl FnMut(Event),
) -> Result<()> {
    let template = staging.join("%(id)s.%(ext)s");
    let build = |with_cookies: bool| {
        let mut a: Vec<String> = Vec::new();
        a.extend(JS_RUNTIME.iter().map(|s| s.to_string()));
        a.extend(PLAYER_CLIENTS.iter().map(|s| s.to_string()));
        a.push("--no-playlist".into());
        // Senza --newline l'avanzamento arriva con \r sulla stessa riga e non si
        // riesce a leggerlo riga per riga.
        a.push("--newline".into());
        a.push("-f".into());
        a.push(format_selector(max_height));
        a.push("--merge-output-format".into());
        a.push("mp4".into());
        a.push("-o".into());
        a.push(template.display().to_string());
        if with_cookies {
            if let Some(c) = &cfg.cookies {
                a.push("--cookies".into());
                a.push(c.display().to_string());
            }
        }
        a.push(url.to_string());
        a
    };

    match stream(&cfg.ytdlp, &build(false), cancel, sink) {
        Ok(()) => Ok(()),
        Err(primo) => {
            if cfg.cookies.is_some() && !cancel.load(Ordering::Relaxed) {
                sink(Event::Log { line: format!("download fallito, riprovo con i cookie: {primo}") });
                // I resti del tentativo fallito confonderebbero la ricerca del file.
                clean_partials(staging, id);
                stream(&cfg.ytdlp, &build(true), cancel, sink)
            } else {
                Err(primo)
            }
        }
    }
}

/// Gli scarti che yt-dlp lascia quando un download muore a metà.
fn clean_partials(staging: &Path, id: &str) {
    let Ok(entries) = std::fs::read_dir(staging) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(id) && (name.ends_with(".part") || name.ends_with(".ytdl")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Il file video prodotto, fra quello che c'è nello staging. Lo cerca per nome
/// (`-o %(id)s.%(ext)s`, quindi il nome è noto) escludendo ciò che non è un video.
fn find_video_file(staging: &Path, id: &str) -> Option<PathBuf> {
    let prefix = format!("{id}.");
    let skip = ["json", "jpg", "jpeg", "png", "webp", "part", "ytdl", "tmp", "temp"];
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(staging).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if skip.contains(&ext.as_str()) || !path.is_file() {
            continue;
        }
        // Con `bv*+ba` yt-dlp scarica due flussi separati e li fonde: se per un
        // qualunque motivo la fusione lasciasse dei resti, il file grande è quello
        // giusto.
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best = Some((size, path));
        }
    }
    best.map(|(_, p)| p)
}

// ── Esecuzione di yt-dlp ────────────────────────────────────────────────────

/// `[download]  45.3% of …` → `45.3`
fn parse_percent(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let end = rest.find('%')?;
    rest[..end].trim().parse::<f64>().ok()
}

/// Il comando esatto, pronto da incollare in un terminale. È la prima cosa che
/// serve quando yt-dlp fa qualcosa di inspiegabile.
fn cmdline(program: &Path, args: &[String]) -> String {
    let mut riga = format!("{}", program.display());
    for a in args {
        if a.contains(' ') || a.contains('"') {
            riga.push_str(&format!(" \"{}\"", a.replace('"', "\\\"")));
        } else {
            riga.push_str(&format!(" {a}"));
        }
    }
    riga
}

/// Legge lo stderr in un thread a parte: se lo si leggesse solo dopo lo stdout, un
/// figlio verboso riempirebbe il buffer della pipe e si bloccherebbe.
fn stderr_reader(child: &mut std::process::Child) -> std::thread::JoinHandle<String> {
    let mut pipe = child.stderr.take();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(p) = pipe.as_mut() {
            let _ = p.read_to_string(&mut buf);
        }
        buf
    })
}

fn spawn(program: &Path, args: &[String], sink: &mut impl FnMut(Event)) -> Result<std::process::Child> {
    sink(Event::Log { line: format!("$ {}", cmdline(program, args)) });
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            Error::new(format!(
                "{} non avviabile: {e}. Metti i binari in tools/ o nel PATH.",
                program.display()
            ))
        })
}

fn failure(program: &Path, code: Option<i32>, stderr: &str) -> Error {
    Error::new(format!(
        "{} è fallito (uscita {}): {}",
        program.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        tail(stderr, 4)
    ))
}

/// Esegue e riporta tutto quello che dice, riga per riga, mentre lo dice.
/// Se `cancel` diventa vero, yt-dlp viene ucciso qui — nessuna pipe da rompere,
/// nessuna attesa: abbiamo noi il processo.
fn stream(program: &Path, args: &[String], cancel: &AtomicBool, sink: &mut impl FnMut(Event)) -> Result<()> {
    let mut child = spawn(program, args, sink)?;
    let stderr = stderr_reader(&mut child);
    let mut annullato = false;

    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(std::io::Result::ok) {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                annullato = true;
                break;
            }
            if let Some(percent) = parse_percent(&line) {
                sink(Event::Progress { percent });
            }
            sink(Event::Log { line });
        }
    }

    let status = child.wait()?;
    let stderr = stderr.join().unwrap_or_default();
    if annullato {
        return Err(Error::new("annullato".to_string()));
    }
    if status.success() {
        Ok(())
    } else {
        Err(failure(program, status.code(), &stderr))
    }
}

/// Esegue e restituisce stdout intero: per `-J`, che sputa un JSON solo.
fn capture(program: &Path, args: &[String], sink: &mut impl FnMut(Event)) -> Result<String> {
    let mut child = spawn(program, args, sink)?;
    let stderr = stderr_reader(&mut child);
    let mut stdout = String::new();
    if let Some(out) = child.stdout.as_mut() {
        out.read_to_string(&mut stdout)?;
    }
    let status = child.wait()?;
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        Err(failure(program, status.code(), &stderr))
    }
}

/// Le ultime righe non vuote: in un messaggio d'errore è dove sta il motivo vero.
fn tail(text: &str, lines: usize) -> String {
    let mut last: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let keep = last.len().saturating_sub(lines);
    last.drain(..keep);
    last.join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn progress_comes_only_from_download_lines() {
        assert_eq!(parse_percent("[download]  45.3% of 100MiB"), Some(45.3));
        assert_eq!(parse_percent("[download] 100.0% of 1KiB"), Some(100.0));
        assert_eq!(parse_percent("[download] Destination: file.mp4"), None);
        assert_eq!(parse_percent("[info] qualcosa 50%"), None);
        assert_eq!(parse_percent(""), None);
    }

    #[test]
    fn the_selector_always_has_a_last_resort_without_the_av1_filter() {
        let s = format_selector(None);
        assert!(s.starts_with("bv*[vcodec!*=av01]+ba/"));
        assert!(s.ends_with("/b"), "l'ultimo ripiego non filtra i codec: {s}");
        assert!(format_selector(Some(1080)).contains("[height<=1080]"));
    }

    #[test]
    fn picks_the_biggest_thumbnail() {
        let info = json!({
            "thumbnail": "https://esempio/piccola.jpg",
            "thumbnails": [
                { "url": "https://esempio/media.jpg", "width": 480, "height": 360 },
                { "url": "https://esempio/grande.jpg", "width": 1920, "height": 1080 }
            ]
        });
        assert_eq!(best_thumbnail(&info).unwrap(), "https://esempio/grande.jpg");
        // Senza elenco si ripiega sul campo singolo.
        assert_eq!(
            best_thumbnail(&json!({ "thumbnail": "https://esempio/unica.jpg" })).unwrap(),
            "https://esempio/unica.jpg"
        );
        assert!(best_thumbnail(&json!({})).is_none());
    }

    #[test]
    fn tail_keeps_the_end_and_drops_the_blanks() {
        assert_eq!(tail("a\n\nb\nc", 2), "b / c");
        assert_eq!(tail("solo", 4), "solo");
        assert_eq!(tail("", 3), "");
    }

    #[test]
    fn the_logged_command_can_be_pasted_in_a_terminal() {
        let riga = cmdline(
            Path::new("tools/yt-dlp.exe"),
            &["-o".into(), "C:/con spazi/%(id)s.%(ext)s".into(), "https://x".into()],
        );
        assert_eq!(riga, r#"tools/yt-dlp.exe -o "C:/con spazi/%(id)s.%(ext)s" https://x"#);
    }

    #[test]
    fn an_event_still_becomes_one_readable_line() {
        assert_eq!(
            Event::Phase { phase: Phase::Video }.to_line(),
            r#"{"event":"phase","phase":"video"}"#
        );
    }
}
