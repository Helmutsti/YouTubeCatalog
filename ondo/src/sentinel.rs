//! Il protocollo fra la libreria e il sentinel, e il lato libreria che lo parla.
//!
//! Un evento per riga su stdout, JSON. Nessun socket, nessuna porta: il sentinel
//! si lancia a mano dal terminale e si legge cosa dice.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::error::{Error, Result};

/// I quattro passi del sentinel, in ordine.
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

/// Quello che un sentinel può dire. `#[serde(tag = "event")]` mette il nome del
/// caso nel campo `event`, così una riga si legge a occhio nudo.
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
    /// Una riga grezza di yt-dlp/ffmpeg, per chi vuole vedere i dettagli.
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
    /// Serializza in una riga. Se anche solo questo fallisse, meglio un evento di
    /// errore leggibile che un panic dentro un processo figlio.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|e| format!(r#"{{"event":"error","message":"evento non serializzabile: {e}"}}"#))
    }

    /// Lo stampa su stdout, con flush: chi legge dall'altra parte deve vederlo
    /// subito, non quando il buffer si riempie.
    pub fn emit(&self) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", self.to_line());
        let _ = out.flush();
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

/// Lancia un sentinel su un URL e resta a leggerlo fino alla fine.
///
/// Ogni evento passa da `sink` mentre arriva (è così che l'avanzamento è davvero
/// dal vivo); il valore di ritorno è il `done` finale, o l'errore che il sentinel
/// ha dichiarato.
pub fn run(cfg: &Config, url: &str, staging: &Path, mut sink: impl FnMut(Event)) -> Result<Finished> {
    std::fs::create_dir_all(staging)?;

    let mut cmd = Command::new(&cfg.sentinel);
    cmd.arg("--url")
        .arg(url)
        .arg("--staging")
        .arg(staging)
        .arg("--ytdlp")
        .arg(&cfg.ytdlp)
        .arg("--ffmpeg")
        .arg(&cfg.ffmpeg);
    if let Some(cookies) = &cfg.cookies {
        cmd.arg("--cookies").arg(cookies);
    }
    if let Some(h) = cfg.max_height {
        cmd.arg("--max-height").arg(h.to_string());
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        Error::new(format!(
            "sentinel non avviabile ({}): {e}. Compila il workspace con `cargo build`.",
            cfg.sentinel.display()
        ))
    })?;

    // stderr letto da un thread a parte: se lo si leggesse solo dopo stdout, un
    // figlio verboso riempirebbe il buffer della pipe e si bloccherebbe.
    let mut err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = err_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });

    let mut finished: Option<Finished> = None;
    let mut declared_error: Option<String> = None;

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    sink(Event::Log { line: format!("lettura interrotta: {e}") });
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            // Righe non-JSON (un panic, un warning del runtime) non sono un
            // motivo per fallire: si girano come log e si va avanti.
            let event = match serde_json::from_str::<Event>(&line) {
                Ok(e) => e,
                Err(_) => Event::Log { line },
            };
            match &event {
                Event::Done { id, video, cover, metadata } => {
                    finished = Some(Finished {
                        id: id.clone(),
                        video: video.clone(),
                        cover: cover.clone(),
                        metadata: metadata.clone(),
                    });
                }
                Event::Error { message } => declared_error = Some(message.clone()),
                _ => {}
            }
            sink(event);
        }
    }

    let status = child.wait()?;
    let stderr = err_thread.join().unwrap_or_default();

    if let Some(message) = declared_error {
        return Err(Error::new(message));
    }
    if let Some(done) = finished {
        return Ok(done);
    }
    let tail: String = stderr.lines().rev().take(5).collect::<Vec<_>>().join(" / ");
    Err(Error::new(format!(
        "il sentinel è finito senza dire né `done` né `error` (uscita {}){}",
        status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        if tail.is_empty() { String::new() } else { format!(": {tail}") }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_round_trips() {
        let e = Event::Progress { percent: 45.3 };
        let line = e.to_line();
        assert_eq!(line, r#"{"event":"progress","percent":45.3}"#);
        assert!(matches!(
            serde_json::from_str::<Event>(&line).unwrap(),
            Event::Progress { percent } if percent == 45.3
        ));
    }

    #[test]
    fn phases_are_readable_names_on_the_wire() {
        assert_eq!(
            Event::Phase { phase: Phase::Video }.to_line(),
            r#"{"event":"phase","phase":"video"}"#
        );
    }
}
