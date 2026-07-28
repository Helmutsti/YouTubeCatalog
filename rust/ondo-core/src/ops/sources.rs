//! Gestione delle sorgenti e "download rapido".
//!
//! ## Download rapido ≠ sorgente
//!
//! Un download rapido **non registra una sorgente**: i video nascono con
//! `sources: []`, che è lo stato normale di un video senza etichette, e nessuna sync
//! li enumererà mai. È coerente col fatto che *Sorgenti* e *Download rapido* siano
//! due menu distinti: il primo serve a tenere traccia nel tempo, il secondo a
//! prendere qualcosa e finirla lì.
//!
//! **Conseguenza da conoscere**: quei video non verranno mai marcati "rimossi" quando
//! spariranno da YouTube — nessuno li sta guardando. Se un giorno servisse il
//! contrario, la strada è chiedere "tenere traccia di questa playlist?" e in caso
//! affermativo passare da [`add_source`].

use serde_json::json;

use crate::config::get_paths;
use crate::downloader::{get_playlist_entries, resolve_video_info, FormatsSummary};
use crate::error::{OndoError, Result};
use crate::library::schema::{download_state, new_video, NewVideo, Source};
use crate::library::state::{read, transaction};
use crate::ops::sync::{extract_playlist_id, ingest, SyncReport};
use crate::time::now_iso8601;

#[derive(Debug, Clone)]
pub struct AddSourceOutcome {
    pub already_exists: bool,
    pub source_id: String,
    pub name: String,
    pub report: Option<SyncReport>,
}

/// Registra una playlist e ne ingerisce subito gli entry: i video compaiono
/// **immediatamente** con titolo, durata e canale. Metadati completi e copertine
/// arrivano dopo, con l'arricchimento — è l'ingest a due fasi.
pub fn add_source(url: &str) -> Result<AddSourceOutcome> {
    let playlist_id = extract_playlist_id(url).ok_or_else(|| {
        OndoError::invalid(
            "Serve il link di una playlist: l'URL deve contenere un parametro \"list=\" \
             (es. https://www.youtube.com/playlist?list=...)",
        )
    })?;
    let canonical = format!("https://www.youtube.com/playlist?list={playlist_id}");

    // Controllo fuori dal lock: evita una chiamata di rete inutile. Ricontrollato
    // dentro la transazione, dove conta.
    if let Some(existing) = read()?.sources.get(&playlist_id) {
        return Ok(AddSourceOutcome {
            already_exists: true,
            source_id: playlist_id,
            name: existing.display_name(),
            report: None,
        });
    }

    let listing = get_playlist_entries(&canonical)?;
    let paths = get_paths()?;
    let name = listing
        .title
        .clone()
        .unwrap_or_else(|| format!("Playlist {playlist_id}"));

    transaction(|st| {
        if let Some(existing) = st.sources.get(&playlist_id) {
            return Ok(AddSourceOutcome {
                already_exists: true,
                source_id: playlist_id.clone(),
                name: existing.display_name(),
                report: None,
            });
        }
        st.sources.insert(
            playlist_id.clone(),
            Source::new_playlist(&playlist_id, &name, &canonical),
        );
        if let Some(s) = st.sources.get_mut(&playlist_id) {
            s.0.insert("lastCheckedAt".into(), json!(now_iso8601()));
        }

        let mut report = ingest(st, &playlist_id, Some(&name), &listing.entries, &paths);
        report.declared_count = listing.declared_count;

        Ok(AddSourceOutcome {
            already_exists: false,
            source_id: playlist_id.clone(),
            name: name.clone(),
            report: Some(report),
        })
    })
}

/// Rimuove una sorgente. I video che portavano la sua etichetta **restano** in
/// libreria: un video non appartiene alla sorgente, la porta. L'etichetta orfana
/// viene ripulita (nel JS restava, e compariva come etichetta senza nome).
pub fn remove_source(source_id: &str) -> Result<usize> {
    transaction(|st| {
        if st.sources.remove(source_id).is_none() {
            return Err(OndoError::not_found(format!("Sorgente non trovata: \"{source_id}\"")));
        }
        let mut cleaned = 0;
        for video in st.videos.values_mut() {
            let Some(arr) = video.0.get_mut("sources").and_then(serde_json::Value::as_array_mut) else { continue };
            let before = arr.len();
            arr.retain(|s| s.get("sourceId").and_then(serde_json::Value::as_str) != Some(source_id));
            if arr.len() != before {
                cleaned += 1;
            }
        }
        Ok(cleaned)
    })
}

// ── Download rapido ─────────────────────────────────────────────────────────

/// Cosa c'è dietro un link incollato.
#[derive(Debug, Clone)]
pub enum QuickTarget {
    /// Già scaricato: niente da fare.
    AlreadyDownloaded { id: String, title: String },
    /// Un singolo video, pronto da scaricare (lo stub è stato creato).
    Video {
        id: String,
        title: String,
        formats: FormatsSummary,
    },
    /// Una playlist: si scaricano N video, **senza** registrare una sorgente.
    Playlist {
        title: String,
        ids: Vec<String>,
        already_downloaded: usize,
    },
}

/// Divide un input che può contenere **più link** in singoli elementi.
///
/// Separatori accettati: virgola, punto e virgola e qualunque spazio bianco (a capo
/// compresi). Nessuno di questi può comparire dentro un URL o dentro un id YouTube,
/// quindi la divisione è sempre sicura — ed è comoda: si incolla una lista da un file
/// di testo, da un foglio, o si scrivono i link separati da virgola a mano.
///
/// I duplicati vengono tolti **conservando l'ordine**: incollare due volte lo stesso
/// link non deve provocare due download dello stesso video.
pub fn split_links(input: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in input.split([',', ';', ' ', '\t', '\n', '\r']) {
        // Le virgolette compaiono quando si incolla da certi editor o dal copia-percorso
        // di Windows; le parentesi angolari quando si copia da una mail o da Markdown.
        let clean = piece.trim().trim_matches(['"', '\'', '<', '>']);
        if clean.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x == clean) {
            out.push(clean.to_string());
        }
    }
    out
}

/// Normalizza l'input. Un id YouTube nudo di 11 caratteri viene espanso — è il solo
/// caso in cui l'URL si può costruire senza ambiguità; qualunque altra cosa deve già
/// essere un URL `http(s)`.
fn normalize(input: &str) -> Result<String> {
    let t = input.trim();
    if t.is_empty() {
        return Err(OndoError::invalid("Nessun link inserito."));
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        return Ok(t.to_string());
    }
    if t.len() == 11 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Ok(format!("https://www.youtube.com/watch?v={t}"));
    }
    Err(OndoError::invalid(
        "Non riconosciuto: incolla un URL completo (http/https) oppure un id YouTube di 11 caratteri.",
    ))
}

/// Risolve un link — video singolo di **qualunque sito supportato da yt-dlp**
/// (YouTube, Rumble, …) oppure playlist YouTube — e prepara gli stub necessari.
///
/// Il riconoscimento del sito lo fa yt-dlp, non una lista di pattern URL da
/// mantenere: è così che il download singolo funziona ovunque senza manutenzione.
pub fn quick_download_target(input: &str) -> Result<QuickTarget> {
    let url = normalize(input)?;
    let paths = get_paths()?;

    // Una playlist si riconosce dal parametro `list=`, ma solo se il link NON punta
    // anche a un video preciso (`v=`): in quel caso l'intento è il singolo video.
    let is_playlist = extract_playlist_id(&url).is_some() && !url.contains("v=");
    if is_playlist {
        let listing = get_playlist_entries(&url)?;
        let title = listing.title.clone().unwrap_or_else(|| "Playlist".to_string());
        let st = read()?;
        let already = listing
            .entries
            .iter()
            .filter(|e| {
                st.videos
                    .get(&e.id)
                    .map(|v| v.download() == download_state::DOWNLOADED)
                    .unwrap_or(false)
            })
            .count();

        // Gli stub si creano senza sourceId: nessuna etichetta, nessuna sync futura.
        let ids = transaction(|st| {
            let mut ids = Vec::new();
            for entry in &listing.entries {
                if !st.videos.contains_key(&entry.id) {
                    let video = new_video(NewVideo {
                        id: &entry.id,
                        title: entry.title.as_deref(),
                        channel_name: entry.channel_name.as_deref(),
                        channel_id: None,
                        duration_seconds: entry.duration_seconds,
                        playlist_index: Some(entry.playlist_index),
                        playlist_id: None,
                        playlist_title: None,
                        source_id: None,
                        webpage_url: None,
                        original_url: None,
                        extractor: None,
                    });
                    st.upsert_author_from_video(&video);
                    st.videos.insert(entry.id.clone(), video);
                }
                if st
                    .videos
                    .get(&entry.id)
                    .map(|v| v.download() != download_state::DOWNLOADED)
                    .unwrap_or(false)
                {
                    ids.push(entry.id.clone());
                }
            }
            Ok(ids)
        })?;

        let _ = paths; // (i percorsi servono solo al ramo video)
        return Ok(QuickTarget::Playlist { title, ids, already_downloaded: already });
    }

    let resolved = resolve_video_info(&url)?;
    let st = read()?;
    if let Some(existing) = st.videos.get(&resolved.id) {
        if existing.download() == download_state::DOWNLOADED {
            return Ok(QuickTarget::AlreadyDownloaded {
                title: existing.display_title(),
                id: resolved.id,
            });
        }
    }

    let id = resolved.id.clone();
    let title = resolved.title.clone();
    let webpage_url = resolved.webpage_url.clone();
    let channel = resolved.channel_name.clone();
    let extractor = resolved.extractor.clone();
    let duration = resolved.duration_seconds;

    transaction(|st| {
        if !st.videos.contains_key(&id) {
            let video = new_video(NewVideo {
                id: &id,
                title: title.as_deref(),
                channel_name: channel.as_deref(),
                channel_id: None,
                duration_seconds: duration,
                playlist_index: None,
                playlist_id: None,
                playlist_title: None,
                source_id: None,
                webpage_url: Some(&webpage_url),
                original_url: None,
                extractor: extractor.as_deref(),
            });
            st.upsert_author_from_video(&video);
            st.videos.insert(id.clone(), video);
        }
        Ok(())
    })?;

    Ok(QuickTarget::Video {
        title: resolved.title.clone().unwrap_or_else(|| resolved.id.clone()),
        id: resolved.id,
        formats: resolved.formats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiple_links_are_split_on_commas_semicolons_and_whitespace() {
        let uno = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
        let due = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
        let tre = "ccccccccccc";

        for input in [
            format!("{uno},{due},{tre}"),
            format!("{uno}; {due} ;{tre}"),
            format!("{uno} {due} {tre}"),
            format!("{uno}\n{due}\r\n{tre}"),
            // Il caso vero: una lista incollata, con separatori misti e spazi a caso.
            format!("  {uno} ,\n  {due};;{tre}  \n\n"),
        ] {
            assert_eq!(split_links(&input), vec![uno, due, tre], "input: {input:?}");
        }
    }

    #[test]
    fn duplicates_are_removed_keeping_the_order() {
        let a = "https://y/watch?v=aaaaaaaaaaa";
        let b = "https://y/watch?v=bbbbbbbbbbb";
        assert_eq!(split_links(&format!("{b},{a},{b},{a}")), vec![b, a]);
    }

    #[test]
    fn quotes_and_angle_brackets_from_pasting_are_stripped() {
        let u = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
        assert_eq!(split_links(&format!("\"{u}\"")), vec![u]);
        assert_eq!(split_links(&format!("<{u}>")), vec![u]);
        assert_eq!(split_links(&format!("'{u}'")), vec![u]);
    }

    #[test]
    fn an_empty_or_separator_only_input_yields_nothing() {
        assert!(split_links("").is_empty());
        assert!(split_links("   ").is_empty());
        assert!(split_links(",,;; \n ;").is_empty());
    }

    #[test]
    fn a_single_link_still_comes_out_as_one() {
        // Il caso normale non deve regredire.
        let u = "https://www.youtube.com/playlist?list=PLabc";
        assert_eq!(split_links(u), vec![u]);
        assert_eq!(split_links("  dQw4w9WgXcQ  "), vec!["dQw4w9WgXcQ"]);
    }

    #[test]
    fn bare_ids_expand_urls_pass_through_garbage_is_refused() {
        assert_eq!(normalize("dQw4w9WgXcQ").unwrap(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(normalize("  https://rumble.com/v1-x.html  ").unwrap(), "https://rumble.com/v1-x.html");
        assert!(normalize("troppocort").is_err());
        assert!(normalize("").is_err());
        assert!(normalize("del testo libero").is_err());
    }

    #[test]
    fn a_link_with_both_v_and_list_is_treated_as_a_single_video() {
        // Caso reale: si copia l'URL dalla barra mentre si guarda un video dentro una
        // playlist. L'intento è quel video, non tutta la playlist.
        let mixed = "https://www.youtube.com/watch?v=abc12345678&list=PLxyz";
        assert!(extract_playlist_id(mixed).is_some());
        assert!(mixed.contains("v="), "il ramo playlist va escluso");

        let pure = "https://www.youtube.com/playlist?list=PLxyz";
        assert!(extract_playlist_id(pure).is_some() && !pure.contains("v="));
    }
}
