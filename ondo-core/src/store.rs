use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::Video;

pub const VERSION: u32 = 1;

/// Un link incollato ma non ancora diventato un video.
///
/// Serve perché prima della risoluzione **non c'è un id**: un link appena
/// incollato non può essere una chiave in `videos`. Se la risoluzione fallisce, il
/// link resta qui con il suo `error` — è così che un fallimento precoce non
/// scompare nel nulla.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedLink {
    pub url: String,
    pub error: Option<String>,
    pub at: u64,
}

/// Il contenuto di `library.json`. `BTreeMap` e non `HashMap`: l'ordine delle
/// chiavi è stabile, quindi il file è diffabile e non si rimescola a ogni salvataggio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryFile {
    pub version: u32,
    pub videos: BTreeMap<String, Video>,
    /// I link non ancora risolti, in ordine di arrivo.
    pub queue: Vec<QueuedLink>,
}

impl Default for LibraryFile {
    fn default() -> Self {
        LibraryFile { version: VERSION, videos: BTreeMap::new(), queue: Vec::new() }
    }
}

/// Un file mancante non è un errore: è una libreria vuota.
pub fn load(path: &Path) -> Result<LibraryFile> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LibraryFile::default()),
        Err(e) => return Err(Error::new(format!("{}: {e}", path.display()))),
    };
    if raw.trim().is_empty() {
        return Ok(LibraryFile::default());
    }
    let file: LibraryFile =
        serde_json::from_str(&raw).map_err(|e| Error::new(format!("{} non è leggibile: {e}", path.display())))?;
    if file.version > VERSION {
        return Err(Error::new(format!(
            "{} è in versione {} ma questa build capisce fino alla {VERSION}",
            path.display(),
            file.version
        )));
    }
    Ok(file)
}

/// Scrittura atomica: si scrive un `.tmp` accanto al file e si rinomina. Il
/// rename è atomico su NTFS e su ext4, quindi non esiste il momento in cui
/// `library.json` è mezzo scritto — un crash lascia il file vecchio, intero.
pub fn save(path: &Path, file: &LibraryFile) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(file)?;
    std::fs::write(&tmp, body).map_err(|e| Error::new(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| Error::new(format!("{}: {e}", path.display())))?;
    Ok(())
}
