//! Misurare un file video con ffprobe.
//!
//! Serve perché i metadati di yt-dlp (`-J`) descrivono il **miglior formato
//! disponibile**, non quello che si è scaricato: con un tetto di risoluzione il
//! record direbbe 3840×2160 di un file che è 640×360. L'unica fonte attendibile su
//! cosa c'è dentro un file è il file.

use std::path::Path;
use std::process::{Command, Stdio};

/// Cosa dice il file di sé.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dimensions {
    pub width: u64,
    pub height: u64,
    pub fps: Option<f64>,
}

/// Misura la prima traccia video. `None` se ffprobe non c'è o non capisce il file:
/// una misura mancante non è un motivo per far fallire un download.
pub fn dimensions(ffprobe: &Path, file: &Path) -> Option<Dimensions> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// `width=640\nheight=360\nr_frame_rate=30000/1001` → 640×360 @ 29.97
fn parse(text: &str) -> Option<Dimensions> {
    let mut width = None;
    let mut height = None;
    let mut fps = None;
    for line in text.lines() {
        let Some((chiave, valore)) = line.split_once('=') else { continue };
        match chiave.trim() {
            "width" => width = valore.trim().parse::<u64>().ok(),
            "height" => height = valore.trim().parse::<u64>().ok(),
            "r_frame_rate" => fps = parse_rate(valore.trim()),
            _ => {}
        }
    }
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some(Dimensions { width: w, height: h, fps }),
        _ => None,
    }
}

/// ffprobe dà il frame rate come frazione (`30000/1001`), perché il video a 29.97
/// fps non ha un valore decimale esatto.
fn parse_rate(raw: &str) -> Option<f64> {
    let (num, den) = raw.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 || num == 0.0 {
        return None;
    }
    Some((num / den * 100.0).round() / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_ffprobe_says() {
        let d = parse("width=640\nheight=360\nr_frame_rate=30000/1001\n").unwrap();
        assert_eq!((d.width, d.height), (640, 360));
        assert_eq!(d.fps, Some(29.97));
    }

    #[test]
    fn integer_frame_rates_stay_integer() {
        assert_eq!(parse("width=1920\nheight=1080\nr_frame_rate=25/1").unwrap().fps, Some(25.0));
    }

    #[test]
    fn nonsense_is_no_measure_rather_than_a_wrong_one() {
        assert!(parse("").is_none());
        assert!(parse("width=0\nheight=0").is_none(), "zero non è una misura");
        assert!(parse("qualcosa=altro").is_none());
        // Un frame rate illeggibile non butta via le dimensioni, che sono valide.
        let d = parse("width=8\nheight=4\nr_frame_rate=0/0").unwrap();
        assert!(d.fps.is_none());
    }
}
