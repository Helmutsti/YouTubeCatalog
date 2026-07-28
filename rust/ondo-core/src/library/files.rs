//! Layout dei file su disco: nomi, percorsi canonici, localizzazione, pulizia.
//!
//! Solo operazioni **di basso livello** sui file. Chi le combina con mutazioni dello
//! stato (cancellare un video, riorganizzare l'archivio) sta in [`crate::ops`]:
//! qui non si scrive mai un json.
//!
//! ⚠️ **Il modulo a più alto rischio del porting.** I video reali sono già su disco
//! con nomi generati dalla versione JavaScript: se `sanitize_name` produce anche un
//! solo carattere diverso, il percorso calcolato non combacia più col file esistente
//! e il video diventa irraggiungibile. Per questo è un porting carattere per
//! carattere, non una reimplementazione "equivalente".

use std::path::{Path, PathBuf};

use crate::config::{get_paths, Paths};
use crate::error::{OndoError, Result};
use crate::library::schema::Video;

/// Titolo troppo lungo → path oltre il limite di Windows. Il suffisso ` [<id>]` e
/// l'estensione restano **sempre** interi (servono per il lookup per id): si taglia
/// solo la parte di titolo.
const MAX_TITLE_LEN: usize = 150;

/// Nomi riservati da Windows: un file chiamato `CON` o `NUL` non è creabile.
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_invalid_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) <= 0x1f
}

/// Rende una stringa sicura come singolo segmento di path. L'ordine delle
/// trasformazioni **conta**: (1) caratteri non ammessi → spazio; (2) spazi bianchi
/// collassati; (3) trim; (4) via spazi e punti **finali** (Windows li scarta
/// silenziosamente); (5) vuoto → fallback; (6) nome riservato → prefisso `_`.
///
/// Non deve coincidere con la sanitizzazione di yt-dlp — che per esempio trasforma
/// `|` in `｜`, pipe a tutta larghezza, invece dello spazio scelto qui. I lookup dei
/// file avvengono per marker `[<id>]`, non per nome: basta che sia valida e leggibile.
pub fn sanitize_name(name: Option<&str>, fallback: &str) -> String {
    let Some(name) = name else {
        return fallback.to_string();
    };
    let replaced: String = name
        .chars()
        .map(|c| if is_invalid_char(c) { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    if WINDOWS_RESERVED.contains(&trimmed.to_uppercase().as_str()) {
        return format!("_{trimmed}");
    }
    trimmed.to_string()
}

fn ext_from_video(video: &Video) -> String {
    if let Some(c) = video
        .0
        .get("video")
        .and_then(|v| v.get("container"))
        .and_then(|v| v.as_str())
        .filter(|c| !c.is_empty())
    {
        return c.to_string();
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

/// Percorso canonico relativo alla cartella dei video, separatori `/`:
/// `<Autore>/<Titolo> [<id>].<ext>`.
///
/// L'id è **sempre** nel nome: risolve da sé le collisioni di titoli identici nello
/// stesso canale — caso reale, due video "[ASMR] Come Study With Me" con id diversi
/// — senza logica di deduplica dedicata.
pub fn target_rel_path(video: &Video) -> String {
    let creator = sanitize_name(video.channel_name(), "Sconosciuto");
    let id = video.id().to_string();
    let mut title = sanitize_name(video.title(), &id);
    if title.chars().count() > MAX_TITLE_LEN {
        title = title.chars().take(MAX_TITLE_LEN).collect::<String>().trim().to_string();
    }
    format!("{creator}/{title} [{id}].{}", ext_from_video(video))
}

/// Percorso assoluto del file di un video già scaricato.
pub fn resolve_video_path(video: &Video) -> Result<PathBuf> {
    let rel = video.local_path().ok_or_else(|| {
        OndoError::conflict(format!("Il video \"{}\" non ha un file locale registrato.", video.id()))
    })?;
    let abs = get_paths()?.videos_dir.join(rel);
    if !abs.is_file() {
        return Err(OndoError::not_found(format!("File non trovato su disco: {}", abs.display())));
    }
    Ok(abs)
}

// ── Archivio di dedup di yt-dlp ─────────────────────────────────────────────

/// yt-dlp non ricontrolla mai se un file esiste ancora: `--download-archive` resta
/// valorizzato per sempre una volta scritto. Se si cancella il file locale senza
/// togliere la riga, un ri-download viene **saltato** — yt-dlp esce con successo
/// senza scrivere nulla, e il video finisce `failed` pur avendo un file. Bug reale.
/// Righe nel formato `<extractor> <id>`.
pub fn remove_from_download_archive(paths: &Paths, video_id: &str) -> Result<()> {
    let file = &paths.download_archive_path;
    if !file.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(file)?;
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| line.split_whitespace().nth(1) != Some(video_id))
        .collect();
    if kept.len() != content.lines().count() {
        std::fs::write(file, kept.join("\n"))?;
    }
    Ok(())
}

// ── Localizzazione ──────────────────────────────────────────────────────────

pub fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

pub fn is_video_file(name: &str) -> bool {
    let l = name.to_lowercase();
    l.ends_with(".mp4") || l.ends_with(".mkv") || l.ends_with(".webm")
}

pub fn to_rel(paths: &Paths, abs: &Path) -> Option<String> {
    abs.strip_prefix(&paths.videos_dir)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

/// Trova il file di un video ovunque si trovi dentro la cartella dei video: prima il
/// `localPath` registrato, poi ricorsivamente un file il cui basename è `<id>.<ext>`
/// (vecchio layout piatto) o contiene `[<id>]` (nuovo layout).
pub fn locate_current_file(paths: &Paths, video: &Video) -> Option<(PathBuf, String)> {
    if let Some(rel) = video.local_path() {
        let abs = paths.videos_dir.join(rel);
        if abs.is_file() {
            return Some((abs, rel.to_string()));
        }
    }
    let id = video.id();
    let mut all = Vec::new();
    walk_files(&paths.videos_dir, &mut all);
    let found = all.into_iter().find(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|b| is_video_file(b) && (b.starts_with(&format!("{id}.")) || b.contains(&format!("[{id}]"))))
            .unwrap_or(false)
    })?;
    let rel = to_rel(paths, &found)?;
    Some((found, rel))
}

/// Un file è "già organizzato" se sta in una sottocartella **e** il nome contiene il
/// marker `[<id>]`. Non serve che coincida carattere per carattere con
/// `target_rel_path()`: il nome che yt-dlp ha assegnato al download **resta buono per
/// sempre** e non va "corretto" solo per farlo combaciare col nostro sanitizzatore.
pub fn is_already_organized(rel: &str, video_id: &str) -> bool {
    let basename = rel.rsplit('/').next().unwrap_or(rel);
    rel.contains('/') && basename.contains(&format!("[{video_id}]"))
}

pub fn prune_empty_dirs(dir: &Path, root: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            prune_empty_dirs(&p, root);
        }
    }
    if dir != root {
        if let Ok(mut it) = std::fs::read_dir(dir) {
            if it.next().is_none() {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }
}

/// Cancella un file e, se la sua cartella (creator) resta vuota, anche quella —
/// mai la radice dei video.
pub fn remove_file_and_empty_parent(paths: &Paths, rel: &str) {
    let abs = paths.videos_dir.join(rel);
    let _ = std::fs::remove_file(&abs);
    if let Some(dir) = abs.parent() {
        if dir != paths.videos_dir {
            if let Ok(mut it) = std::fs::read_dir(dir) {
                if it.next().is_none() {
                    let _ = std::fs::remove_dir(dir);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn invalid_characters_become_single_spaces() {
        assert_eq!(sanitize_name(Some("a<b>c:d\"e/f\\g|h?i*j"), "X"), "a b c d e f g h i j");
    }

    #[test]
    fn whitespace_collapses_and_trailing_dots_go_away() {
        assert_eq!(sanitize_name(Some("  molti   spazi\t\tqui  "), "X"), "molti spazi qui");
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
    fn windows_reserved_names_get_a_prefix_but_only_when_exact() {
        assert_eq!(sanitize_name(Some("CON"), "X"), "_CON");
        assert_eq!(sanitize_name(Some("con"), "X"), "_con");
        assert_eq!(sanitize_name(Some("COM1"), "X"), "_COM1");
        assert_eq!(sanitize_name(Some("CONSOLE"), "X"), "CONSOLE");
    }

    #[test]
    fn accents_and_emoji_are_preserved() {
        assert_eq!(sanitize_name(Some("Créatôr 🎧 ASMR"), "X"), "Créatôr 🎧 ASMR");
    }

    fn video(v: Value) -> Video {
        Video::from_value(v).unwrap()
    }

    #[test]
    fn canonical_path_always_contains_the_id() {
        let v = video(json!({
            "id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up",
            "channel": { "name": "Rick Astley" }, "video": { "container": "mp4" }
        }));
        assert_eq!(target_rel_path(&v), "Rick Astley/Never Gonna Give You Up [dQw4w9WgXcQ].mp4");
    }

    #[test]
    fn missing_channel_and_title_use_fallbacks() {
        assert_eq!(target_rel_path(&video(json!({ "id": "abc123" }))), "Sconosciuto/abc123 [abc123].mp4");
    }

    #[test]
    fn extension_comes_from_container_then_path_then_mp4() {
        assert!(target_rel_path(&video(json!({"id":"x","title":"T","channel":{"name":"C"},"video":{"container":"mkv"}}))).ends_with(".mkv"));
        assert!(target_rel_path(&video(json!({"id":"x","title":"T","channel":{"name":"C"},"video":{"localPath":"C/T [x].webm"}}))).ends_with(".webm"));
        assert!(target_rel_path(&video(json!({"id":"x","title":"T","channel":{"name":"C"}}))).ends_with(".mp4"));
    }

    #[test]
    fn very_long_titles_are_truncated_but_the_id_survives() {
        let v = video(json!({
            "id": "ID1", "title": "a".repeat(400), "channel": { "name": "C" },
            "video": { "container": "mp4" }
        }));
        let rel = target_rel_path(&v);
        assert!(rel.ends_with(" [ID1].mp4"), "il suffisso con l'id non va mai tagliato");
        let title = rel.strip_prefix("C/").unwrap().strip_suffix(" [ID1].mp4").unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_LEN);
    }

    #[test]
    fn already_organized_requires_both_a_subfolder_and_the_marker() {
        assert!(is_already_organized("Creator/T [abc].mp4", "abc"));
        assert!(!is_already_organized("abc.mp4", "abc"), "vecchio layout piatto");
        assert!(!is_already_organized("Creator/T.mp4", "abc"), "senza marker");
    }
}
