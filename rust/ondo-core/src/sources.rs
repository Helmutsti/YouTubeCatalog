//! Gestione delle fonti (playlist) — porting di
//! `core/src/services/sourceService.js`, e del download one-off di
//! `singleVideoService.js`.

use serde_json::{json, Value};

use crate::config::get_paths;
use crate::error::{OndoError, Result};
use crate::schema::{create_new_video_stub, download_state, NewVideoStub, Video};
use crate::store::{read_catalog, update_catalog, videos_of};
use crate::sync::{extract_playlist_id, ingest_playlist_entries, IngestReport};
use crate::time::now_iso8601;
use crate::ytdlp::{get_playlist_entries, resolve_video_info, FormatsSummary};

#[derive(Debug, Clone)]
pub struct Source {
    pub id: String,
    pub name: Option<String>,
    pub url: Option<String>,
    pub last_checked_at: Option<String>,
    pub video_count: usize,
}

/// Le fonti con il conteggio dei video **che portano quell'etichetta**. Un video
/// può contarne più di una: `sources` è un array, non un vincolo di appartenenza.
pub fn list_sources() -> Result<Vec<Source>> {
    let catalog = read_catalog()?;
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for video in videos_of(&catalog) {
        if let Some(arr) = video.0.get("sources").and_then(Value::as_array) {
            for s in arr {
                if let Some(id) = s.get("sourceId").and_then(Value::as_str) {
                    *counts.entry(id.to_string()).or_insert(0) += 1;
                }
            }
        }
    }

    let mut sources: Vec<Source> = catalog
        .get("sources")
        .and_then(Value::as_object)
        .map(|m| {
            m.values()
                .filter_map(|s| {
                    let id = s.get("id").and_then(Value::as_str)?.to_string();
                    Some(Source {
                        video_count: counts.get(&id).copied().unwrap_or(0),
                        name: s.get("name").and_then(Value::as_str).map(str::to_string),
                        url: s.get("url").and_then(Value::as_str).map(str::to_string),
                        last_checked_at: s
                            .get("lastCheckedAt")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    sources.sort_by(|a, b| {
        a.name
            .as_deref()
            .unwrap_or("")
            .cmp(b.name.as_deref().unwrap_or(""))
    });
    Ok(sources)
}

#[derive(Debug, Clone)]
pub struct AddSourceOutcome {
    pub already_exists: bool,
    pub source_id: String,
    pub name: Option<String>,
    pub report: Option<IngestReport>,
}

/// Registra una playlist e ne ingerisce subito gli entry, così i video compaiono
/// **immediatamente** con titolo/durata/canale (fase 1 dell'ingest a due fasi;
/// la fase 2 — metadati completi e copertine — è `enrich_pending`).
pub fn add_source(url: &str) -> Result<AddSourceOutcome> {
    let playlist_id = extract_playlist_id(url).ok_or_else(|| {
        OndoError::invalid(
            "Solo playlist sono supportate per ora: l'URL deve contenere un parametro \
             \"list=\" (es. https://www.youtube.com/playlist?list=...)",
        )
    })?;
    let canonical_url = format!("https://www.youtube.com/playlist?list={playlist_id}");

    // Controllo preliminare fuori dal lock: evita una chiamata di rete inutile se
    // la fonte c'è già. Ricontrollato comunque dentro la transazione.
    let existing = read_catalog()?;
    if let Some(s) = existing.get("sources").and_then(|s| s.get(&playlist_id)) {
        return Ok(AddSourceOutcome {
            already_exists: true,
            source_id: playlist_id,
            name: s.get("name").and_then(Value::as_str).map(str::to_string),
            report: None,
        });
    }

    let listing = get_playlist_entries(&canonical_url)?;
    let paths = get_paths()?;
    let name = listing
        .title
        .clone()
        .unwrap_or_else(|| format!("Playlist {playlist_id}"));

    update_catalog(|catalog| {
        let sources = catalog
            .get_mut("sources")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| OndoError::invalid("Catalogo senza sezione sources."))?;

        if let Some(s) = sources.get(&playlist_id) {
            return Ok(AddSourceOutcome {
                already_exists: true,
                source_id: playlist_id.clone(),
                name: s.get("name").and_then(Value::as_str).map(str::to_string),
                report: None,
            });
        }

        sources.insert(
            playlist_id.clone(),
            json!({
                "type": "playlist",
                "id": playlist_id,
                "name": name,
                "url": canonical_url,
                "lastCheckedAt": now_iso8601()
            }),
        );

        let mut report = ingest_playlist_entries(
            catalog,
            &playlist_id,
            Some(&name),
            &listing.entries,
            &paths,
        );
        report.declared_count = listing.declared_count;

        Ok(AddSourceOutcome {
            already_exists: false,
            source_id: playlist_id.clone(),
            name: Some(name.clone()),
            report: Some(report),
        })
    })
}

/// Rimuove la fonte dall'elenco. I video che portano la sua etichetta **restano**
/// nel catalogo: un video non dipende dalla fonte, la porta come etichetta.
/// L'etichetta orfana viene ripulita, così l'elenco resta coerente.
pub fn remove_source(source_id: &str) -> Result<()> {
    update_catalog(|catalog| {
        let sources = catalog
            .get_mut("sources")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| OndoError::not_found(format!("Fonte non trovata: \"{source_id}\"")))?;
        if sources.remove(source_id).is_none() {
            return Err(OndoError::not_found(format!(
                "Fonte non trovata: \"{source_id}\""
            )));
        }

        // Pulizia dell'etichetta: il JS lasciava riferimenti a fonti inesistenti in
        // `video.sources`, che poi comparivano come etichette senza nome.
        if let Some(videos) = catalog.get_mut("videos").and_then(Value::as_object_mut) {
            for (_, raw) in videos.iter_mut() {
                let Some(arr) = raw.get_mut("sources").and_then(Value::as_array_mut) else { continue };
                arr.retain(|s| s.get("sourceId").and_then(Value::as_str) != Some(source_id));
            }
        }
        Ok(())
    })
}

// ── Download one-off di un singolo video ────────────────────────────────────

#[derive(Debug, Clone)]
pub enum SinglePrepared {
    /// Già in archivio: nessuna azione.
    AlreadyDownloaded { id: String, title: Option<String> },
    /// Pronto da scaricare: lo stub è stato creato (o esisteva già).
    Ready {
        id: String,
        title: Option<String>,
        webpage_url: String,
        formats: FormatsSummary,
    },
}

/// Normalizza l'input a un URL. Un id YouTube nudo di 11 caratteri viene espanso —
/// è il solo caso in cui l'URL si può costruire senza ambiguità. Qualunque altro
/// input deve già essere un URL `http(s)`.
fn normalize_input(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(OndoError::invalid("Nessun link inserito."));
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    let looks_like_id = trimmed.len() == 11
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if looks_like_id {
        return Ok(format!("https://www.youtube.com/watch?v={trimmed}"));
    }
    Err(OndoError::invalid(
        "Input non riconosciuto: incolla un URL completo (http/https) o un id YouTube di 11 caratteri.",
    ))
}

/// Prepara il download one-off di un singolo video da un link incollato, senza
/// passare da una fonte. Il video finisce regolarmente in catalogo, ma con
/// `sources: []` — che è lo stato normale di un video senza etichette, non un
/// caso "orfano" speciale: nessuna sync lo enumererà mai.
///
/// Funziona con **qualunque sito supportato da yt-dlp** (YouTube, Rumble, …):
/// il riconoscimento lo fa yt-dlp tramite `resolve_video_info`, non una lista di
/// pattern URL da mantenere.
pub fn prepare_single_video(input: &str) -> Result<SinglePrepared> {
    let url = normalize_input(input)?;
    let resolved = resolve_video_info(&url)?;

    let catalog = read_catalog()?;
    if let Some(existing) = catalog
        .get("videos")
        .and_then(|v| v.get(&resolved.id))
        .and_then(|v| Video::from_value(v.clone()))
    {
        if existing.download() == download_state::DOWNLOADED {
            return Ok(SinglePrepared::AlreadyDownloaded {
                id: resolved.id,
                title: existing.title().map(str::to_string),
            });
        }
        // A differenza del JS non si rifiuta più un video già tracciato da una
        // fonte: senza la web GUI non esiste più una "Rivedi novità" a cui
        // rimandare l'utente, e scaricare ciò che ha appena chiesto è il
        // comportamento atteso. L'etichetta della fonte resta intatta.
        return Ok(SinglePrepared::Ready {
            id: resolved.id,
            title: resolved.title,
            webpage_url: resolved.webpage_url,
            formats: resolved.formats,
        });
    }

    let id = resolved.id.clone();
    let title = resolved.title.clone();
    let webpage_url = resolved.webpage_url.clone();
    update_catalog(|catalog| {
        let videos = catalog
            .get_mut("videos")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| OndoError::invalid("Catalogo senza sezione videos."))?;
        if !videos.contains_key(&id) {
            let stub = create_new_video_stub(NewVideoStub {
                id: &id,
                title: title.as_deref(),
                channel_name: resolved.channel_name.as_deref(),
                duration_seconds: resolved.duration_seconds,
                playlist_index: None,
                playlist_id: None,
                playlist_title: None,
                source_id: None,
                webpage_url: Some(&webpage_url),
                original_url: None,
                extractor: resolved.extractor.as_deref(),
            });
            videos.insert(id.clone(), stub.into_value());
        }
        Ok(())
    })?;

    Ok(SinglePrepared::Ready {
        id: resolved.id,
        title: resolved.title,
        webpage_url: resolved.webpage_url,
        formats: resolved.formats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_youtube_ids_are_expanded_urls_are_left_alone() {
        assert_eq!(
            normalize_input("dQw4w9WgXcQ").unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        assert_eq!(
            normalize_input("  https://rumble.com/v123-x.html  ").unwrap(),
            "https://rumble.com/v123-x.html"
        );
        // 10 caratteri: non è un id YouTube, e non è un URL.
        assert!(normalize_input("troppocort").is_err());
        assert!(normalize_input("").is_err());
        assert!(normalize_input("solo del testo libero").is_err());
    }
}
