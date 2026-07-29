//! # ondo-sentinel
//!
//! Un processo, un video. Quattro passi, in ordine:
//!
//! 1. risoluzione del link,
//! 2. metadati + copertina,
//! 3. download del video,
//! 4. `done`.
//!
//! Parla con la libreria stampando una riga JSON per evento su stdout (vedi
//! `ondo::Event`). Non tocca `library.json` e non sposta niente fuori dalla sua
//! cartella di staging: organizzare è compito della libreria.
//!
//! Si lancia anche a mano, ed è il modo più rapido di capire cosa sta succedendo:
//!
//! ```text
//! ondo-sentinel --url <URL> --staging ./tmp --ytdlp tools/yt-dlp.exe --ffmpeg tools/ffmpeg.exe
//! ```

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ondo::{Event, Phase};
use serde_json::Value;

/// Senza un runtime JavaScript yt-dlp non decifra le firme dei formati recenti e
/// i download muoiono a metà con 403.
const JS_RUNTIME: [&str; 2] = ["--js-runtimes", "node"];

/// Alcuni video stanno in un esperimento YouTube che pretende un "PO Token" dai
/// client normali. `android_vr` non è soggetto all'esperimento; sta **accanto** a
/// `default`, non al suo posto, così i video non coinvolti usano i client abituali.
const PLAYER_CLIENTS: [&str; 2] = ["--extractor-args", "youtube:player_client=default,android_vr,web_embedded"];

struct Args {
    url: String,
    staging: PathBuf,
    ytdlp: PathBuf,
    ffmpeg: PathBuf,
    cookies: Option<PathBuf>,
    max_height: Option<u32>,
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(message) => {
            Event::Error { message }.emit();
            std::process::exit(2);
        }
    };
    if let Err(message) = work(&args) {
        Event::Error { message }.emit();
        std::process::exit(1);
    }
}

fn parse_args() -> Result<Args, String> {
    let mut url = None;
    let mut staging = None;
    let mut ytdlp = None;
    let mut ffmpeg = None;
    let mut cookies = None;
    let mut max_height = None;

    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("manca il valore di {flag}"));
        match flag.as_str() {
            "--url" => url = Some(value()?),
            "--staging" => staging = Some(PathBuf::from(value()?)),
            "--ytdlp" => ytdlp = Some(PathBuf::from(value()?)),
            "--ffmpeg" => ffmpeg = Some(PathBuf::from(value()?)),
            "--cookies" => cookies = Some(PathBuf::from(value()?)),
            "--max-height" => {
                let raw = value()?;
                max_height = Some(raw.parse::<u32>().map_err(|_| format!("--max-height: {raw} non è un numero"))?);
            }
            other => return Err(format!("argomento non riconosciuto: {other}")),
        }
    }

    Ok(Args {
        url: url.ok_or("manca --url")?,
        staging: staging.ok_or("manca --staging")?,
        ytdlp: ytdlp.unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" })),
        ffmpeg: ffmpeg.unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })),
        cookies,
        max_height,
    })
}

fn work(args: &Args) -> Result<(), String> {
    std::fs::create_dir_all(&args.staging).map_err(|e| format!("{}: {e}", args.staging.display()))?;

    // ── 1. Risoluzione del link ─────────────────────────────────────────────
    Event::Phase { phase: Phase::Resolve }.emit();
    let info = resolve(args)?;
    let id = info.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    if id.is_empty() {
        return Err("yt-dlp non ha restituito un id per questo link".into());
    }
    if info.get("_type").and_then(Value::as_str) == Some("playlist") {
        return Err("questo link è una playlist o un canale, non un singolo video".into());
    }
    Event::Resolved {
        id: id.clone(),
        title: info.get("title").and_then(Value::as_str).unwrap_or(&id).to_string(),
        author: ondo::model::author_of(&info),
        duration: info.get("duration").and_then(Value::as_f64),
    }
    .emit();

    // ── 2. Metadati e copertina ─────────────────────────────────────────────
    Event::Phase { phase: Phase::Metadata }.emit();
    let metadata_path = write_metadata(&args.staging, &id, info.clone())?;
    Event::Metadata { path: metadata_path.clone() }.emit();

    let cover = match save_cover(args, &id, &info) {
        Ok(path) => {
            Event::Cover { path: path.clone() }.emit();
            Some(path)
        }
        Err(why) => {
            // Una copertina mancante non vale la pena di far fallire un download.
            Event::Log { line: format!("copertina non salvata: {why}") }.emit();
            None
        }
    };

    // ── 3. Download del video ───────────────────────────────────────────────
    Event::Phase { phase: Phase::Video }.emit();
    download_video(args, &id)?;
    let video = find_video_file(&args.staging, &id)
        .ok_or_else(|| format!("yt-dlp è finito senza lasciare un file video per {id}"))?;

    // ── 4. Fatto ────────────────────────────────────────────────────────────
    Event::Done { id, video, cover, metadata: metadata_path }.emit();
    Ok(())
}

// ── Passo 1: risoluzione ────────────────────────────────────────────────────

/// `--skip-download -J`: è yt-dlp stesso a riconoscere il sito, quindi funziona
/// per qualunque sito che yt-dlp sappia gestire, senza liste di pattern da tenere
/// aggiornate.
fn resolve(args: &Args) -> Result<Value, String> {
    let build = |with_cookies: bool| {
        let mut a: Vec<String> = Vec::new();
        a.extend(JS_RUNTIME.iter().map(|s| s.to_string()));
        a.extend(PLAYER_CLIENTS.iter().map(|s| s.to_string()));
        a.push("--no-playlist".into());
        a.push("--skip-download".into());
        a.push("-J".into());
        if with_cookies {
            if let Some(c) = &args.cookies {
                a.push("--cookies".into());
                a.push(c.display().to_string());
            }
        }
        a.push(args.url.clone());
        a
    };

    let first = capture(&args.ytdlp, &build(false));
    let out = match first {
        Ok(out) => out,
        Err(first_error) => {
            // I cookie sono il ripiego, non il default: mandarli insieme al client
            // `android_vr` è la combinazione che la CDN di YouTube blocca con 403.
            if args.cookies.is_some() {
                Event::Log { line: format!("primo tentativo fallito, riprovo con i cookie: {first_error}") }.emit();
                capture(&args.ytdlp, &build(true))?
            } else {
                return Err(first_error);
            }
        }
    };

    serde_json::from_str(&out).map_err(|e| format!("yt-dlp ha risposto qualcosa che non è JSON: {e}"))
}

// ── Passo 2: metadati e copertina ───────────────────────────────────────────

/// Salva i metadati grezzi, togliendo `automatic_captions`: è un elenco di URL per
/// i sottotitoli auto-tradotti in 150+ lingue, centinaia di KB per video, che non
/// serve mai a nessuno.
fn write_metadata(staging: &Path, id: &str, mut info: Value) -> Result<PathBuf, String> {
    if let Some(obj) = info.as_object_mut() {
        obj.remove("automatic_captions");
    }
    let path = staging.join(format!("{id}.json"));
    let body = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// La copertina più grande fra quelle esposte dai metadati, scaricata con
/// **ffmpeg**: fa da client HTTP e converte in jpg in un colpo, così non serve
/// nessuna libreria di rete.
fn save_cover(args: &Args, id: &str, info: &Value) -> Result<PathBuf, String> {
    let url = best_thumbnail(info).ok_or("nessuna copertina nei metadati")?;
    let path = args.staging.join(format!("{id}.jpg"));
    let out = Command::new(&args.ffmpeg)
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&url)
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg non avviabile ({}): {e}", args.ffmpeg.display()))?;
    if !out.status.success() || !path.is_file() {
        return Err(tail(&String::from_utf8_lossy(&out.stderr), 3));
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

fn download_video(args: &Args, id: &str) -> Result<(), String> {
    let template = args.staging.join("%(id)s.%(ext)s");
    let build = |with_cookies: bool| {
        let mut a: Vec<String> = Vec::new();
        a.extend(JS_RUNTIME.iter().map(|s| s.to_string()));
        a.extend(PLAYER_CLIENTS.iter().map(|s| s.to_string()));
        a.push("--no-playlist".into());
        // Senza --newline l'avanzamento arriva con \r sulla stessa riga e non si
        // riesce a leggerlo riga per riga.
        a.push("--newline".into());
        a.push("-f".into());
        a.push(format_selector(args.max_height));
        a.push("--merge-output-format".into());
        a.push("mp4".into());
        a.push("-o".into());
        a.push(template.display().to_string());
        if with_cookies {
            if let Some(c) = &args.cookies {
                a.push("--cookies".into());
                a.push(c.display().to_string());
            }
        }
        a.push(args.url.clone());
        a
    };

    match stream(&args.ytdlp, &build(false)) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if args.cookies.is_some() {
                Event::Log { line: format!("download fallito, riprovo con i cookie: {first_error}") }.emit();
                // I resti del tentativo fallito confonderebbero la ricerca del file.
                clean_partials(&args.staging, id);
                stream(&args.ytdlp, &build(true))
            } else {
                Err(first_error)
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

// ── Esecuzione dei processi esterni ─────────────────────────────────────────

/// `[download]  45.3% of …` → `45.3`
fn parse_percent(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let end = rest.find('%')?;
    rest[..end].trim().parse::<f64>().ok()
}

/// Esegue e riporta tutto quello che dice, riga per riga, mentre lo dice.
fn stream(program: &Path, args: &[String]) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{} non avviabile: {e}", program.display()))?;

    let mut err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_string(&mut buf);
        }
        buf
    });

    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(percent) = parse_percent(&line) {
                Event::Progress { percent }.emit();
            }
            Event::Log { line }.emit();
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} è fallito (uscita {}): {}",
            program.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            tail(&stderr, 4)
        ))
    }
}

/// Esegue e restituisce stdout intero: per `-J`, che sputa un JSON solo.
fn capture(program: &Path, args: &[String]) -> Result<String, String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{} non avviabile: {e}", program.display()))?;
    if !out.status.success() {
        return Err(format!(
            "{} è fallito (uscita {}): {}",
            program.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            tail(&String::from_utf8_lossy(&out.stderr), 4)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
}
