//! Catalogo su disco — porting di `core/src/catalog/catalogStore.js`.
//!
//! Conserva le due proprietà del JS: **mutex** attorno a ogni mutazione e
//! **scrittura atomica** (tmp + rename, atomico su NTFS e POSIX).
//!
//! ## Una differenza voluta: niente cache-per-processo
//!
//! `catalogStore.js` tiene il catalogo in una variabile di modulo e non lo
//! rilegge mai da disco. È la causa del funzionamento controintuitivo numero uno
//! del progetto, documentato in `documentazione.md`: *«se uno script esterno
//! modifica catalog.json mentre un server/CLI gira, quel processo va riavviato,
//! altrimenti la sua cache sovrascrive le modifiche»*. È anche ciò che ha
//! distrutto lo stato di 83 video (vedi `storico.md`, 2026-07-25).
//!
//! Qui il catalogo si **rilegge a ogni operazione**, sotto lock. M66 ha misurato
//! che `JSON.parse` del catalogo reale costa 1,4ms in JavaScript: il costo di
//! rileggere è irrilevante, il costo di sbagliare no. Il `Mutex` serializza le
//! mutazioni all'interno del processo esattamente come faceva la `writeQueue`.
//!
//! Resta vero che **due processi** che scrivono insieme possono perdere dati:
//! quella garanzia richiederebbe un lockfile su disco, che il JS non ha e che
//! non viene introdotto qui per non cambiare comportamento durante la migrazione.

use std::fs;
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::config::get_paths;
use crate::error::{OndoError, Result};
use crate::schema::{
    create_empty_catalog, download_state, migrate_video_to_flags, migrate_video_to_sources, Video,
};
use crate::time::now_iso8601;

/// Serializza le mutazioni nel processo corrente (l'equivalente della
/// `writeQueue` asincrona del JS).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn read_from_disk() -> Result<Value> {
    let paths = get_paths()?;
    if !paths.catalog_path.is_file() {
        return Ok(create_empty_catalog());
    }
    let text = fs::read_to_string(&paths.catalog_path)?;
    let value: Value = serde_json::from_str(&text)?;
    if !value.is_object() {
        return Err(OndoError::new(
            crate::error::ErrorKind::Parse,
            "catalog.json non contiene un oggetto JSON.",
        ));
    }
    Ok(value)
}

/// Migrazioni una tantum + reconciliation all'avvio. Ritorna `true` se ha
/// modificato qualcosa (e quindi va riscritto). Porting di `reconcileOnLoad()`.
fn reconcile(catalog: &mut Value) -> bool {
    let mut changed = false;

    // `sources` va letto prima del prestito mutabile dei video: serve a
    // migrate_video_to_sources per risolvere il nome dal vecchio sourceId.
    let sources_snapshot = catalog.get("sources").cloned();

    if let Some(videos) = catalog.get_mut("videos").and_then(Value::as_object_mut) {
        for (_, raw) in videos.iter_mut() {
            let map = match raw {
                Value::Object(m) => m,
                _ => continue,
            };
            // Si lavora su una Video presa in prestito dalla mappa esistente.
            let mut video = Video(std::mem::take(map));

            if migrate_video_to_flags(&mut video) {
                changed = true;
            }
            if migrate_video_to_sources(&mut video, sources_snapshot.as_ref()) {
                changed = true;
            }
            // Un download interrotto a metà (processo morto durante il download)
            // va riportato a "none" e rifatto da zero al prossimo trigger.
            if video.download() == download_state::DOWNLOADING {
                video.0.insert("download".into(), Value::String(download_state::NONE.into()));
                video.0.insert("updatedAt".into(), Value::String(now_iso8601()));
                changed = true;
            }

            *map = video.0;
        }
    }

    // Cataloghi scritti prima delle foto profilo dei canali (M14) non hanno il campo.
    if let Some(obj) = catalog.as_object_mut() {
        if !obj.contains_key("channelAvatars") {
            obj.insert("channelAvatars".into(), Value::Object(Map::new()));
            changed = true;
        }
    }

    changed
}

fn persist(catalog: &mut Value) -> Result<()> {
    let paths = get_paths()?;
    if let Some(meta) = catalog.get_mut("meta").and_then(Value::as_object_mut) {
        meta.insert("lastUpdated".into(), Value::String(now_iso8601()));
    }
    // Indentazione a 2 spazi come `JSON.stringify(cat, null, 2)`.
    let text = serde_json::to_string_pretty(catalog)?;
    let tmp = paths.catalog_path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &paths.catalog_path)?;
    Ok(())
}

/// Legge il catalogo applicando migrazioni e reconciliation, riscrivendolo se
/// qualcosa è cambiato — come `readCatalog()`.
pub fn read_catalog() -> Result<Value> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut catalog = read_from_disk()?;
    if reconcile(&mut catalog) {
        persist(&mut catalog)?;
    }
    Ok(catalog)
}

/// Muta il catalogo sotto lock e lo riscrive atomicamente. Se il mutator
/// restituisce `Err`, **niente viene scritto** — il catalogo su disco resta
/// intatto. (Il JS invece persisteva solo in assenza di eccezione, stesso esito.)
pub fn update_catalog<T, F>(mutator: F) -> Result<T>
where
    F: FnOnce(&mut Value) -> Result<T>,
{
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut catalog = read_from_disk()?;
    reconcile(&mut catalog);
    let result = mutator(&mut catalog)?;
    persist(&mut catalog)?;
    Ok(result)
}

/// Tutti i video del catalogo, come `Video`.
pub fn videos_of(catalog: &Value) -> Vec<Video> {
    catalog
        .get("videos")
        .and_then(Value::as_object)
        .map(|m| {
            m.values()
                .filter_map(|v| Video::from_value(v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reconcile_migrates_and_resets_interrupted_downloads() {
        let mut catalog = json!({
            "version": 1,
            "sources": { "PL1": { "name": "Playlist" } },
            "videos": {
                "a": { "id": "a", "status": "downloaded", "source": { "sourceId": "PL1" } },
                "b": { "id": "b", "presence": "present", "download": "downloading", "sources": [] }
            },
            "meta": { "lastUpdated": "2026-01-01T00:00:00.000Z" }
        });

        assert!(reconcile(&mut catalog));

        let a = &catalog["videos"]["a"];
        assert_eq!(a["download"], "downloaded");
        assert_eq!(a["presence"], "present");
        assert!(a.get("status").is_none());
        assert_eq!(a["sources"], json!([{ "sourceId": "PL1", "name": "Playlist" }]));

        // downloading interrotto → none
        assert_eq!(catalog["videos"]["b"]["download"], "none");

        // channelAvatars aggiunto (M14)
        assert!(catalog["channelAvatars"].is_object());

        // Idempotente: una seconda passata non cambia più nulla.
        assert!(!reconcile(&mut catalog));
    }

    #[test]
    fn reconcile_preserves_unknown_fields_and_key_order() {
        let mut catalog = json!({
            "version": 1,
            "videos": { "a": {
                "id": "a", "presence": "present", "download": "none",
                "sources": [], "campoFuturo": 42
            }},
            "channelAvatars": {},
            "meta": {}
        });
        reconcile(&mut catalog);
        assert_eq!(catalog["videos"]["a"]["campoFuturo"], 42);
        let keys: Vec<_> = catalog["videos"]["a"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["id", "presence", "download", "sources", "campoFuturo"]);
    }
}
