//! Metadati grezzi di yt-dlp: **un file per video**, in `data/metadata/<id>.json`.
//!
//! ## Perché non un file unico
//!
//! Misurato sui dati veri: dopo aver rimosso `automatic_captions` un metadato pesa
//! in media **95 KB** (132 KB su un video con 38 formati, 57 KB su uno con 13) →
//! **~25 MB** per i 274 video reali.
//!
//! Con un `metadata.json` unico, ogni salvataggio riscrive tutto: un arricchimento
//! completo del catalogo significherebbe ~3,4 GB scritti e — ai tempi misurati in
//! M66 (40 MB ≈ 51ms in parse + 61ms in stringify) — una quindicina di secondi di
//! puro serializza/deserializza, per aggiornare 95 KB alla volta.
//!
//! Un file per video: una scrittura da 95 KB, nessun read-modify-write, nessun lock
//! (ogni file ha un solo scrittore possibile — il video stesso). Il costo è qualche
//! centinaio di file piccoli in una cartella, che non è un costo.
//!
//! `automatic_captions` viene rimosso **qui**, unico punto di scrittura: elenca gli
//! URL dei sottotitoli auto-tradotti in 150+ lingue, gonfia il file di 5 volte e non
//! serve a niente.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::config::get_paths;
use crate::error::Result;

fn dir() -> Result<PathBuf> {
    let d = get_paths()?.metadata_dir;
    fs::create_dir_all(&d)?;
    Ok(d)
}

fn path_of(id: &str) -> Result<PathBuf> {
    Ok(dir()?.join(format!("{id}.json")))
}

pub fn get(id: &str) -> Result<Option<Value>> {
    let path = path_of(id)?;
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(&path)?)?))
}

pub fn set(id: &str, info: &Value) -> Result<()> {
    let mut trimmed = info.clone();
    if let Some(obj) = trimmed.as_object_mut() {
        obj.remove("automatic_captions");
    }
    let path = path_of(id)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&trimmed)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Non fallisce se l'id non c'è: la usa la cancellazione totale di un video.
pub fn delete(id: &str) -> Result<()> {
    let _ = fs::remove_file(path_of(id)?);
    Ok(())
}

pub fn has(id: &str) -> bool {
    path_of(id).map(|p| p.is_file()).unwrap_or(false)
}

/// Quanti video hanno metadati salvati, e quanto occupano. Per la vista di stato.
pub fn stats() -> Result<(usize, u64)> {
    let d = dir()?;
    let mut count = 0;
    let mut bytes = 0;
    if let Ok(entries) = fs::read_dir(&d) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                count += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok((count, bytes))
}

/// Migrazione dal vecchio `metadata.json` monolitico ai file per video.
/// Conserva il file originale rinominandolo, non lo cancella.
pub fn migrate_from_monolith() -> Result<usize> {
    let paths = get_paths()?;
    let legacy = paths.data_dir.join("metadata.json");
    if !legacy.is_file() {
        return Ok(0);
    }
    let root: Value = serde_json::from_str(&fs::read_to_string(&legacy)?)?;
    let Some(map) = root.as_object() else { return Ok(0) };

    let mut migrated = 0;
    for (id, info) in map {
        set(id, info)?;
        migrated += 1;
    }
    fs::rename(&legacy, paths.data_dir.join("metadata.json.pre-v2"))?;
    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn automatic_captions_are_stripped_but_everything_else_survives() {
        // La regola che conta; l'I/O è coperto dal test end-to-end.
        let info = json!({
            "id": "x", "title": "T",
            "automatic_captions": { "it": ["…"], "en": ["…"] },
            "formats": [1, 2, 3], "chapters": [{ "title": "Intro" }]
        });
        let mut trimmed = info.clone();
        trimmed.as_object_mut().unwrap().remove("automatic_captions");
        assert!(trimmed.get("automatic_captions").is_none());
        assert_eq!(trimmed["formats"], info["formats"]);
        assert_eq!(trimmed["chapters"], info["chapters"]);
    }
}
