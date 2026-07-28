//! Backup e ripristino in un archivio `.zip`.
//!
//! ## Cosa c'è dentro, e cosa no
//!
//! **Tutto lo stato tranne i video grezzi.** L'archivio contiene:
//!
//! - `library.json` e `sources.json` — il catalogo;
//! - `metadata/<id>.json` — i metadati grezzi di yt-dlp;
//! - `covers/<id>.jpg` — le copertine;
//! - `authors/<key>.jpg` — le foto profilo;
//! - `config.json` — le impostazioni;
//! - `backup.json` — un manifesto con versione, data e conteggi.
//!
//! **Esclusi di proposito:**
//!
//! - i **file video**: sono decine di GB e sono ri-scaricabili. Un backup che li
//!   includesse non sarebbe utilizzabile;
//! - `cookies.txt`: è una credenziale della sessione YouTube dell'utente. Un backup
//!   viene copiato, spostato, mandato via mail — non è il posto per un segreto.
//!
//! Le copertine invece **entrano**, e non è una contraddizione col punto sopra: pesano
//! poco e, per un video poi rimosso da YouTube, sono l'unica cosa che non si può più
//! ri-scaricare. È lo stesso motivo per cui vengono cachate in locale.
//!
//! ## Il ripristino non cancella niente
//!
//! Prima di sovrascrivere, lo stato attuale viene **copiato** in
//! `data/pre-restore-<data-ora>/`. Se il ripristino si rivela un errore, la strada
//! indietro esiste ancora. Va poi riavviato il programma, perché lo stato letto prima
//! del ripristino è ormai vecchio.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config::{get_paths, Paths};
use crate::error::{ErrorKind, OndoError, Result};
use crate::library::state::{LIBRARY_FILE, SOURCES_FILE};
use crate::library::zip::{create_zip, read_zip, ZipEntry};
use crate::library::{metadata, query, state};
use crate::time::now_iso8601;

const MANIFEST: &str = "backup.json";
const BACKUP_VERSION: u64 = 2;

/// I soli file di primo livello ammessi in un archivio, in lettura e in scrittura.
/// Tutto il resto deve stare sotto una delle cartelle in [`ALLOWED_DIRS`].
const ALLOWED_FILES: [&str; 4] = [LIBRARY_FILE, SOURCES_FILE, "config.json", MANIFEST];
const ALLOWED_DIRS: [&str; 3] = ["metadata/", "covers/", "authors/"];

#[derive(Debug, Clone, Default)]
pub struct BackupReport {
    pub bytes: usize,
    pub videos: usize,
    pub authors: usize,
    pub sources: usize,
    pub metadata_files: usize,
    pub covers: usize,
    pub author_pictures: usize,
}

fn collect_dir(dir: &Path, prefix: &str, entries: &mut Vec<ZipEntry>) -> Result<usize> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut n = 0;
    for e in fs::read_dir(dir)?.flatten() {
        let path = e.path();
        if !path.is_file() {
            continue; // niente ricorsione: queste cartelle sono piatte per progetto
        }
        let Some(name) = path.file_name().and_then(|x| x.to_str()) else { continue };
        // I temporanei di una scrittura atomica interrotta non vanno nel backup.
        if name.ends_with(".tmp") {
            continue;
        }
        entries.push(ZipEntry {
            name: format!("{prefix}{name}"),
            data: fs::read(&path)?,
        });
        n += 1;
    }
    Ok(n)
}

/// Costruisce l'archivio in memoria.
pub fn create_backup() -> Result<(Vec<u8>, BackupReport)> {
    let paths = get_paths()?;
    // Passa da `state::read()`, non da una lettura diretta dei file: così un commit
    // interrotto viene riparato *prima* e il backup contiene uno stato coerente.
    let st = state::read()?;
    let counts = query::counts(&st);

    let mut report = BackupReport {
        videos: counts.total,
        authors: st.authors.len(),
        sources: st.sources.len(),
        ..Default::default()
    };
    let mut entries: Vec<ZipEntry> = Vec::new();

    for name in [LIBRARY_FILE, SOURCES_FILE, "config.json"] {
        let path = paths.data_dir.join(name);
        if path.is_file() {
            entries.push(ZipEntry { name: name.to_string(), data: fs::read(&path)? });
        }
    }

    report.metadata_files = collect_dir(&paths.metadata_dir, "metadata/", &mut entries)?;
    report.covers = collect_dir(&paths.covers_dir, "covers/", &mut entries)?;
    report.author_pictures = collect_dir(&paths.authors_dir, "authors/", &mut entries)?;

    let manifest = json!({
        "backupVersion": BACKUP_VERSION,
        "createdAt": now_iso8601(),
        "createdBy": format!("ondo-core {}", crate::VERSION),
        "counts": {
            "videos": report.videos,
            "authors": report.authors,
            "sources": report.sources,
            "metadataFiles": report.metadata_files,
            "covers": report.covers,
            "authorPictures": report.author_pictures
        },
        // Dichiarato nell'archivio, così chi lo apre fra due anni sa cosa NON troverà.
        "excludes": ["file video (ri-scaricabili)", "cookies.txt (credenziale)"]
    });
    entries.push(ZipEntry {
        name: MANIFEST.to_string(),
        data: serde_json::to_string_pretty(&manifest)?.into_bytes(),
    });

    let bytes = create_zip(&entries);
    report.bytes = bytes.len();
    Ok((bytes, report))
}

/// Nome consigliato: ordinabile e senza caratteri problematici su Windows.
pub fn suggested_filename() -> String {
    format!("ondo-backup-{}.zip", now_iso8601().replace([':', '.'], "-"))
}

/// Scrive il backup su disco.
pub fn write_backup_to(path: &Path) -> Result<BackupReport> {
    let (bytes, report) = create_backup()?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, &bytes)?;
    Ok(report)
}

// ── Ripristino ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct RestoreReport {
    pub restored_files: usize,
    pub safety_copy: Option<PathBuf>,
    pub manifest: Option<Value>,
    pub skipped: Vec<String>,
}

/// Un nome è ammesso solo se è uno dei file di primo livello previsti, oppure se sta
/// sotto una delle cartelle previste **senza risalire**.
///
/// Non è paranoia teorica: un archivio può contenere `../../qualcosa`, e un
/// estrattore ingenuo scriverebbe fuori dalla cartella dei dati. Un backup arriva da
/// fuori — anche quando l'ha prodotto lo stesso programma — e va trattato come input
/// non fidato.
fn is_allowed(name: &str) -> bool {
    if name.contains('\\') || name.contains("..") || name.starts_with('/') || name.contains(':') {
        return false;
    }
    if ALLOWED_FILES.contains(&name) {
        return true;
    }
    ALLOWED_DIRS.iter().any(|dir| {
        name.starts_with(dir) && {
            let rest = &name[dir.len()..];
            !rest.is_empty() && !rest.contains('/')
        }
    })
}

fn safety_copy(paths: &Paths) -> Result<Option<PathBuf>> {
    let dir = paths
        .data_dir
        .join(format!("pre-restore-{}", now_iso8601().replace([':', '.'], "-")));

    let mut copied = 0;
    for name in [LIBRARY_FILE, SOURCES_FILE, "config.json"] {
        let from = paths.data_dir.join(name);
        if from.is_file() {
            fs::create_dir_all(&dir)?;
            fs::copy(&from, dir.join(name))?;
            copied += 1;
        }
    }
    // I metadati sono molti file ma piccoli: si copiano anche loro, altrimenti un
    // ripristino sbagliato li perderebbe senza rimedio.
    if paths.metadata_dir.is_dir() {
        let target = dir.join("metadata");
        for e in fs::read_dir(&paths.metadata_dir)?.flatten() {
            let path = e.path();
            if path.is_file() {
                fs::create_dir_all(&target)?;
                if let Some(n) = path.file_name() {
                    fs::copy(&path, target.join(n))?;
                    copied += 1;
                }
            }
        }
    }
    Ok((copied > 0).then_some(dir))
}

/// Ripristina da un archivio, dopo aver messo da parte lo stato attuale.
///
/// Sostituisce i file presenti nell'archivio e **non cancella** quelli che
/// nell'archivio non ci sono: un backup più vecchio non fa sparire una copertina
/// scaricata dopo. Le voci non riconosciute vengono elencate in
/// [`RestoreReport::skipped`] invece di essere estratte in silenzio.
pub fn restore_backup(zip_bytes: &[u8]) -> Result<RestoreReport> {
    let paths = get_paths()?;
    let entries = read_zip(zip_bytes)?;

    if entries.is_empty() {
        return Err(OndoError::invalid("L'archivio è vuoto."));
    }

    let manifest = entries
        .iter()
        .find(|e| e.name == MANIFEST)
        .and_then(|e| serde_json::from_slice::<Value>(&e.data).ok());

    // Un archivio senza né library.json né catalog.json non è un backup di Ondo:
    // meglio dirlo prima di aver toccato qualunque cosa.
    let looks_like_backup = entries
        .iter()
        .any(|e| e.name == LIBRARY_FILE || e.name == "catalog.json");
    if !looks_like_backup {
        return Err(OndoError::invalid(
            "Questo archivio non sembra un backup di Ondo: manca library.json (o catalog.json).",
        ));
    }

    let mut report = RestoreReport { manifest, ..Default::default() };
    report.safety_copy = safety_copy(&paths)?;

    for entry in &entries {
        // `catalog.json` è ammesso in lettura anche se non è nella whitelist di
        // scrittura: è il formato vecchio, e ripristinarlo permette poi di migrarlo.
        let allowed = is_allowed(&entry.name) || entry.name == "catalog.json" || entry.name == "metadata.json";
        if !allowed {
            report.skipped.push(entry.name.clone());
            continue;
        }
        if entry.name == MANIFEST {
            continue; // descrive l'archivio, non fa parte dello stato
        }

        let dest = paths.data_dir.join(&entry.name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        // Scrittura atomica per file: un ripristino interrotto non lascia un json
        // troncato al posto di uno valido.
        let tmp = dest.with_extension(format!(
            "{}.tmp",
            dest.extension().and_then(|e| e.to_str()).unwrap_or("bak")
        ));
        fs::write(&tmp, &entry.data)?;
        fs::rename(&tmp, &dest)?;
        report.restored_files += 1;
    }

    if report.restored_files == 0 {
        return Err(OndoError::new(
            ErrorKind::Invalid,
            "Nessun file valido trovato nell'archivio.",
        ));
    }
    Ok(report)
}

/// Legge un archivio senza applicarlo: serve a mostrare all'utente cosa contiene
/// **prima** di sovrascrivere il suo stato.
pub fn inspect_backup(zip_bytes: &[u8]) -> Result<(Option<Value>, usize, usize)> {
    let entries = read_zip(zip_bytes)?;
    let manifest = entries
        .iter()
        .find(|e| e.name == MANIFEST)
        .and_then(|e| serde_json::from_slice::<Value>(&e.data).ok());
    let total_bytes = entries.iter().map(|e| e.data.len()).sum();
    Ok((manifest, entries.len(), total_bytes))
}

/// Quanti metadati sono presenti: usato dalla vista di stato per dire all'utente
/// quanto peserebbe un backup.
pub fn estimate_size() -> Result<usize> {
    let paths = get_paths()?;
    let mut total = 0;
    for name in [LIBRARY_FILE, SOURCES_FILE, "config.json"] {
        total += fs::metadata(paths.data_dir.join(name)).map(|m| m.len()).unwrap_or(0) as usize;
    }
    total += metadata::stats().map(|(_, b)| b as usize).unwrap_or(0);
    for dir in [&paths.covers_dir, &paths.authors_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                total += e.metadata().map(|m| m.len()).unwrap_or(0) as usize;
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_whitelist_accepts_what_belongs_and_nothing_else() {
        for good in [
            "library.json",
            "sources.json",
            "config.json",
            "backup.json",
            "metadata/abc123.json",
            "covers/abc123.jpg",
            "authors/UC_qualcosa.jpg",
            "authors/Créatôr 🎧.jpg",
        ] {
            assert!(is_allowed(good), "doveva essere ammesso: {good}");
        }

        for bad in [
            // Traversal in tutte le forme che un archivio può contenere.
            "../fuori.json",
            "metadata/../../fuori.json",
            "../../Windows/System32/x.dll",
            "/etc/passwd",
            "C:/Windows/x.dll",
            "metadata\\abc.json",
            // Annidamento non previsto: le cartelle sono piatte per progetto.
            "metadata/sub/abc.json",
            "covers/sub/x.jpg",
            // Cartella senza file.
            "metadata/",
            // File di primo livello non previsti.
            "cookies.txt",
            "videos/film.mp4",
            "qualsiasi.json",
        ] {
            assert!(!is_allowed(bad), "NON doveva essere ammesso: {bad}");
        }
    }

    #[test]
    fn the_suggested_filename_is_sortable_and_windows_safe() {
        let name = suggested_filename();
        assert!(name.starts_with("ondo-backup-") && name.ends_with(".zip"));
        assert!(
            !name.contains(':') && !name.contains('/') && !name.contains('\\'),
            "nessun carattere vietato su Windows: {name}"
        );
    }

    #[test]
    fn an_archive_without_the_catalog_is_refused_before_touching_anything() {
        let zip = create_zip(&[ZipEntry { name: "qualcosa.txt".into(), data: b"x".to_vec() }]);
        let err = restore_backup(&zip).unwrap_err();
        assert!(err.message.contains("non sembra un backup"), "{}", err.message);
    }

    #[test]
    fn an_empty_archive_is_refused() {
        let zip = create_zip(&[]);
        assert!(restore_backup(&zip).is_err());
    }

    #[test]
    fn inspect_reads_the_manifest_without_applying_anything() {
        let manifest = json!({ "backupVersion": 2, "counts": { "videos": 7 } });
        let zip = create_zip(&[
            ZipEntry { name: LIBRARY_FILE.into(), data: b"{}".to_vec() },
            ZipEntry {
                name: MANIFEST.into(),
                data: serde_json::to_vec(&manifest).unwrap(),
            },
        ]);
        let (found, count, bytes) = inspect_backup(&zip).unwrap();
        assert_eq!(found.unwrap()["counts"]["videos"], 7);
        assert_eq!(count, 2);
        assert!(bytes > 0);
    }
}
