//! Riproduzione con VLC.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Video o solo audio: la seconda serve per ascoltare senza tenere una finestra
/// aperta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Video,
    Audio,
}

/// Lancia VLC su un file e **non aspetta**: parte come processo indipendente e
/// continua a suonare anche se chi l'ha lanciato viene chiuso.
pub fn play(vlc: Option<&Path>, file: &Path, mode: Mode) -> Result<()> {
    let vlc = vlc.ok_or_else(|| {
        Error::new("VLC non è configurato: impostalo dalle impostazioni (`vlc` in config.json)".to_string())
    })?;
    if !vlc.is_file() {
        return Err(Error::new(format!(
            "VLC non è in {}: correggi il percorso dalle impostazioni",
            vlc.display()
        )));
    }
    if !file.is_file() {
        return Err(Error::new(format!("il file non c'è: {}", file.display())));
    }

    let mut cmd = Command::new(vlc);
    if mode == Mode::Audio {
        cmd.arg("--no-video");
    }
    cmd.arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::new(format!("VLC non avviabile ({}): {e}", vlc.display())))?;
    Ok(())
}
