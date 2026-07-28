//! Layout dell'archivio — porting della parte "nomi e percorsi" di
//! `core/src/services/libraryService.js`.
//!
//! ⚠️ **Il modulo a più alto rischio di tutta la migrazione** (docs/rust-core.md
//! §8). I 274 video reali sono già su disco con nomi generati dalla versione JS:
//! se `sanitize_name` qui produce anche un solo carattere diverso, il percorso
//! calcolato non combacia più con il file esistente e il video diventa
//! irraggiungibile. Per questo la funzione è un porting carattere per carattere,
//! con i test che coprono ogni ramo — non una reimplementazione "equivalente".
//!
//! Nota già valida per il JS e conservata qui: questa sanitizzazione **non** deve
//! coincidere con quella di yt-dlp (che per esempio trasforma `|` in `｜`, pipe a
//! tutta larghezza, invece dello spazio scelto qui). I lookup dei file avvengono
//! per marker `[<id>]`, non per nome: basta che il nome sia valido e leggibile.

use std::path::PathBuf;

use crate::config::get_paths;
use crate::error::{OndoError, Result};
use crate::schema::Video;

/// Titolo troppo lungo → path oltre il limite di Windows. Il suffisso ` [<id>]`
/// e l'estensione restano **sempre** interi (servono per il lookup per id): si
/// taglia solo la parte di titolo.
const MAX_TITLE_LEN: usize = 150;

/// Nomi riservati da Windows: un file chiamato `CON` o `NUL` non è creabile.
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Caratteri non ammessi nei nomi file Windows (`< > : " / \ | ? *`) più i
/// caratteri di controllo. Elenco esplicito, come nel JS, per evitare ambiguità
/// di escaping.
fn is_invalid_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) <= 0x1f
}

/// Rende una stringa sicura come singolo segmento di path.
///
/// Porting di `sanitizeName()`. Ordine delle trasformazioni (identico al JS,
/// e l'ordine **conta**):
///   1. ogni carattere non ammesso → spazio singolo;
///   2. sequenze di spazi bianchi → uno spazio;
///   3. trim;
///   4. rimozione di spazi e punti **finali** (Windows li scarta silenziosamente);
///   5. se resta vuoto → fallback;
///   6. se è un nome riservato → prefisso `_`.
pub fn sanitize_name(name: Option<&str>, fallback: &str) -> String {
    let Some(name) = name else {
        return fallback.to_string();
    };

    // (1) sostituzione dei caratteri invalidi
    let replaced: String = name
        .chars()
        .map(|c| if is_invalid_char(c) { ' ' } else { c })
        .collect();

    // (2) collasso degli spazi bianchi + (3) trim.
    // `\s+` di JavaScript comprende spazio, tab, newline, form feed, vertical
    // tab, NBSP e gli spazi Unicode: `char::is_whitespace` copre lo stesso
    // insieme per i casi che interessano qui.
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");

    // (4) niente spazi/punti finali
    let trimmed = collapsed.trim_end_matches(['.', ' ']);

    // (5) vuoto → fallback
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    // (6) nome riservato → prefisso
    if WINDOWS_RESERVED.contains(&trimmed.to_uppercase().as_str()) {
        return format!("_{trimmed}");
    }
    trimmed.to_string()
}

fn ext_from_video(video: &Video) -> String {
    if let Some(container) = video.0.get("video").and_then(|v| v.get("container")).and_then(|v| v.as_str()) {
        if !container.is_empty() {
            return container.to_string();
        }
    }
    if let Some(local) = video.local_path() {
        if let Some((_, ext)) = local.rsplit_once('.') {
            if !ext.is_empty() && !ext.contains(['/', '\\']) {
                return ext.to_string();
            }
        }
    }
    "mp4".to_string()
}

/// Percorso canonico (relativo a `videosDir`, separatori `/`) di un video:
/// `<Creator>/<Titolo> [<id>].<ext>`. L'id finale è **sempre** presente: risolve
/// da sé le collisioni di titoli identici nello stesso canale (caso reale: due
/// video "[ASMR] Come Study With Me" con id diversi) senza logica dedicata.
pub fn target_rel_path(video: &Video) -> String {
    let creator = sanitize_name(video.channel_name(), "Sconosciuto");
    let id = video.id().to_string();
    let mut title = sanitize_name(video.title(), &id);

    // Il JS taglia con `slice(0, MAX)` su unità UTF-16 e poi fa `trim()`. Qui si
    // taglia su confini di carattere per non produrre stringhe non valide;
    // per i titoli reali (ben sotto i 150 caratteri) i due comportamenti
    // coincidono, e oltre resta un troncamento sicuro.
    if title.chars().count() > MAX_TITLE_LEN {
        title = title.chars().take(MAX_TITLE_LEN).collect::<String>().trim().to_string();
    }

    format!("{creator}/{title} [{id}].{}", ext_from_video(video))
}

/// Percorso assoluto del file video di un'entry già scaricata.
pub fn resolve_video_path(video: &Video) -> Result<PathBuf> {
    let rel = video.local_path().ok_or_else(|| {
        OndoError::conflict(format!(
            "Il video \"{}\" non ha un file locale registrato.",
            video.id()
        ))
    })?;
    let paths = get_paths()?;
    let abs = paths.videos_dir.join(rel);
    if !abs.is_file() {
        return Err(OndoError::not_found(format!(
            "File non trovato su disco: {}",
            abs.display()
        )));
    }
    Ok(abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn invalid_characters_become_single_spaces() {
        assert_eq!(sanitize_name(Some("a<b>c:d\"e/f\\g|h?i*j"), "X"), "a b c d e f g h i j");
    }

    #[test]
    fn whitespace_is_collapsed_and_trimmed() {
        assert_eq!(sanitize_name(Some("  molti   spazi\t\tqui  "), "X"), "molti spazi qui");
    }

    #[test]
    fn trailing_dots_and_spaces_are_removed() {
        // Windows li scarta silenziosamente: un file "nome." diventa "nome".
        assert_eq!(sanitize_name(Some("nome..."), "X"), "nome");
        assert_eq!(sanitize_name(Some("nome . . "), "X"), "nome");
    }

    #[test]
    fn empty_and_missing_fall_back() {
        assert_eq!(sanitize_name(None, "Sconosciuto"), "Sconosciuto");
        assert_eq!(sanitize_name(Some(""), "Sconosciuto"), "Sconosciuto");
        assert_eq!(sanitize_name(Some("///"), "Sconosciuto"), "Sconosciuto");
        assert_eq!(sanitize_name(Some("..."), "Sconosciuto"), "Sconosciuto");
    }

    #[test]
    fn windows_reserved_names_get_a_prefix() {
        assert_eq!(sanitize_name(Some("CON"), "X"), "_CON");
        assert_eq!(sanitize_name(Some("con"), "X"), "_con");
        assert_eq!(sanitize_name(Some("COM1"), "X"), "_COM1");
        assert_eq!(sanitize_name(Some("CONSOLE"), "X"), "CONSOLE", "solo il nome esatto è riservato");
    }

    #[test]
    fn accents_and_emoji_are_preserved() {
        // Sono validi nei nomi file: non vanno toccati. È il caso reale del
        // catalogo dell'utente (cartelle creator con accenti ed emoji).
        assert_eq!(sanitize_name(Some("Créatôr 🎧 ASMR"), "X"), "Créatôr 🎧 ASMR");
    }

    #[test]
    fn canonical_path_always_contains_the_id() {
        let v = Video::from_value(json!({
            "id": "dQw4w9WgXcQ",
            "title": "Never Gonna Give You Up",
            "channel": { "name": "Rick Astley" },
            "video": { "container": "mp4", "localPath": Value::Null }
        }))
        .unwrap();
        assert_eq!(
            target_rel_path(&v),
            "Rick Astley/Never Gonna Give You Up [dQw4w9WgXcQ].mp4"
        );
    }

    #[test]
    fn missing_channel_and_title_use_fallbacks() {
        let v = Video::from_value(json!({ "id": "abc123" })).unwrap();
        assert_eq!(target_rel_path(&v), "Sconosciuto/abc123 [abc123].mp4");
    }

    #[test]
    fn extension_comes_from_container_then_local_path_then_mp4() {
        let mkv = Video::from_value(json!({
            "id": "x", "title": "T", "channel": {"name":"C"},
            "video": { "container": "mkv" }
        }))
        .unwrap();
        assert!(target_rel_path(&mkv).ends_with(".mkv"));

        let from_path = Video::from_value(json!({
            "id": "x", "title": "T", "channel": {"name":"C"},
            "video": { "localPath": "C/T [x].webm" }
        }))
        .unwrap();
        assert!(target_rel_path(&from_path).ends_with(".webm"));

        let neither = Video::from_value(json!({"id":"x","title":"T","channel":{"name":"C"}})).unwrap();
        assert!(target_rel_path(&neither).ends_with(".mp4"));
    }

    #[test]
    fn very_long_titles_are_truncated_but_id_survives() {
        let long_title = "a".repeat(400);
        let v = Video::from_value(json!({
            "id": "ID1", "title": long_title, "channel": { "name": "C" },
            "video": { "container": "mp4" }
        }))
        .unwrap();
        let rel = target_rel_path(&v);
        assert!(rel.ends_with(" [ID1].mp4"), "il suffisso con l'id non va mai tagliato");
        let title_part = rel.strip_prefix("C/").unwrap().strip_suffix(" [ID1].mp4").unwrap();
        assert_eq!(title_part.chars().count(), MAX_TITLE_LEN);
    }

    use serde_json::Value;
}
