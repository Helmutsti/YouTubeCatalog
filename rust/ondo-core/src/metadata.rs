//! Metadati grezzi di yt-dlp — porting di `core/src/catalog/metadataStore.js`.
//!
//! `data/metadata.json` è una mappa `{ [id]: metadatoGrezzo }` con l'intero
//! oggetto estratto da yt-dlp, **tranne** `automatic_captions`: quell'elenco
//! contiene gli URL dei sottotitoli auto-tradotti in 150+ lingue, gonfia ogni
//! voce di centinaia di KB e non è quasi mai utile. Viene rimosso qui, unico
//! punto di scrittura, così ogni chiamante ne beneficia senza doverci pensare.
//!
//! Come `store.rs`, non tiene una cache per processo: rilegge sotto lock.

use std::fs;

use serde_json::{Map, Value};

use crate::config::get_paths;
use crate::error::Result;
use crate::lock::FileLock;

fn read_all() -> Result<Map<String, Value>> {
    let paths = get_paths()?;
    if !paths.metadata_path.is_file() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(&paths.metadata_path)?;
    match serde_json::from_str::<Value>(&text)? {
        Value::Object(map) => Ok(map),
        _ => Ok(Map::new()),
    }
}

fn persist(store: &Map<String, Value>) -> Result<()> {
    let paths = get_paths()?;
    let text = serde_json::to_string_pretty(&Value::Object(store.clone()))?;
    let tmp = paths.metadata_path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &paths.metadata_path)?;
    Ok(())
}

fn lock() -> Result<FileLock> {
    FileLock::acquire(get_paths()?.data_dir.join("metadata.lock"))
}

pub fn get_metadata(id: &str) -> Result<Option<Value>> {
    Ok(read_all()?.get(id).cloned())
}

pub fn set_metadata(id: &str, info: &Value) -> Result<()> {
    let _guard = lock()?;
    let mut store = read_all()?;
    let mut trimmed = info.clone();
    if let Some(obj) = trimmed.as_object_mut() {
        obj.remove("automatic_captions");
    }
    store.insert(id.to_string(), trimmed);
    persist(&store)
}

/// A differenza di `set_metadata` non fallisce se l'id non c'è: la usa la
/// cancellazione totale di un video.
pub fn delete_metadata(id: &str) -> Result<()> {
    let _guard = lock()?;
    let mut store = read_all()?;
    if store.remove(id).is_some() {
        persist(&store)?;
    }
    Ok(())
}

/// Quanti video hanno metadati grezzi salvati, per le viste di stato.
pub fn count() -> Result<usize> {
    Ok(read_all()?.len())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn automatic_captions_are_stripped_before_saving() {
        // Verifica della sola trasformazione, senza toccare il disco: è la regola
        // che conta (il resto è I/O già coperto da store.rs).
        let info = json!({ "id": "x", "title": "T", "automatic_captions": { "it": ["…"] }, "formats": [1, 2] });
        let mut trimmed = info.clone();
        trimmed.as_object_mut().unwrap().remove("automatic_captions");
        assert!(trimmed.get("automatic_captions").is_none());
        assert_eq!(trimmed.get("formats"), info.get("formats"), "tutto il resto resta integrale");
    }
}
