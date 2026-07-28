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

use std::path::{Path, PathBuf};

use serde_json::Value;

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

// ── Archivio di dedup di yt-dlp ─────────────────────────────────────────────

/// yt-dlp non ricontrolla mai se un file esiste ancora: `--download-archive` resta
/// valorizzato per sempre una volta scritto. Se si cancella il file locale senza
/// togliere la riga, un ri-download viene **saltato** — yt-dlp esce con successo
/// senza scrivere nulla, e il video finisce `failed` pur avendo (o non avendo) un
/// file. Bug reale riscontrato su `pEhoILkfG8w`. Righe nel formato
/// `<extractor> <id>`.
pub fn remove_from_download_archive(paths: &crate::config::Paths, video_id: &str) -> Result<()> {
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

// ── Localizzazione e riorganizzazione ───────────────────────────────────────

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
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

fn is_video_file(name: &str) -> bool {
    let l = name.to_lowercase();
    l.ends_with(".mp4") || l.ends_with(".mkv") || l.ends_with(".webm")
}

fn to_rel(paths: &crate::config::Paths, abs: &Path) -> Option<String> {
    abs.strip_prefix(&paths.videos_dir)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

/// Trova il file video attuale di un'entry, ovunque si trovi dentro `videosDir`:
/// prima il `localPath` registrato; se manca o non esiste, cerca ricorsivamente un
/// file video il cui basename è `<id>.<ext>` (vecchio layout piatto) oppure
/// contiene `[<id>]` (già nel nuovo layout).
fn locate_current_file(paths: &crate::config::Paths, video: &Video) -> Option<(PathBuf, String)> {
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
            .map(|base| is_video_file(base) && (base.starts_with(&format!("{id}.")) || base.contains(&format!("[{id}]"))))
            .unwrap_or(false)
    })?;
    let rel = to_rel(paths, &found)?;
    Some((found, rel))
}

/// Un file è "già organizzato" se sta in una sottocartella **e** il nome contiene
/// il marker `[<id>]`. Non serve che coincida carattere per carattere con
/// `target_rel_path()`: yt-dlp sanifica i titoli a modo suo (per esempio `|`
/// diventa `｜`, pipe a tutta larghezza, non lo spazio scelto da `sanitize_name`)
/// e quel nome, già assegnato al momento del download, **resta buono per sempre**.
/// Non va "corretto" solo per farlo combaciare col nostro sanitizzatore.
fn is_already_organized(rel: &str, video_id: &str) -> bool {
    let has_subfolder = rel.contains('/');
    let basename = rel.rsplit('/').next().unwrap_or(rel);
    has_subfolder && basename.contains(&format!("[{video_id}]"))
}

fn prune_empty_dirs(dir: &Path, root: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            prune_empty_dirs(&path, root);
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

#[derive(Debug, Clone)]
pub struct PlannedMove {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default)]
pub struct ReorganizeReport {
    pub dry_run: bool,
    pub moved: usize,
    pub planned: Vec<PlannedMove>,
    pub already_ok: usize,
    pub missing: Vec<String>,
}

/// Riorganizza l'archivio nel layout canonico per creator. **Idempotente**: i
/// video già al posto giusto vengono saltati. Con `dry_run` non tocca nulla e
/// restituisce solo il piano.
pub fn reorganize_library(dry_run: bool) -> Result<ReorganizeReport> {
    let paths = get_paths()?;
    let catalog = crate::store::read_catalog()?;

    let mut report = ReorganizeReport { dry_run, ..Default::default() };
    let mut moves: Vec<(PlannedMove, PathBuf, PathBuf)> = Vec::new();
    let mut realign: Vec<(String, String)> = Vec::new();

    for video in crate::store::videos_of(&catalog) {
        if !video.is_downloaded() {
            continue;
        }
        let Some((abs, rel)) = locate_current_file(&paths, &video) else {
            report.missing.push(video.id().to_string());
            continue;
        };
        if is_already_organized(&rel, video.id()) {
            // Già in un posto valido: si allinea il localPath se differiva (es.
            // separatori diversi), ma il file non viene mai rinominato.
            if video.local_path() != Some(rel.as_str()) {
                realign.push((video.id().to_string(), rel));
            }
            report.already_ok += 1;
            continue;
        }
        let to_rel_path = target_rel_path(&video);
        let to_abs = paths.videos_dir.join(&to_rel_path);
        moves.push((
            PlannedMove { id: video.id().to_string(), from: rel, to: to_rel_path },
            abs,
            to_abs,
        ));
    }

    if dry_run {
        report.planned = moves.into_iter().map(|(p, _, _)| p).collect();
        return Ok(report);
    }

    // Un solo passaggio di scrittura sul catalogo per tutti gli spostamenti,
    // invece di uno per video come fa il JS: meno I/O e, soprattutto, nessuna
    // finestra in cui il catalogo descrive metà spostamento.
    for (plan, from_abs, to_abs) in &moves {
        if let Some(parent) = to_abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // L'id univoco nel nome rende impossibile in pratica una collisione con un
        // file DIVERSO; se il target esiste già (rerun interrotto) lo si considera
        // a posto e si aggiorna solo il catalogo.
        if !to_abs.exists() {
            std::fs::rename(from_abs, to_abs)?;
        }
        realign.push((plan.id.clone(), plan.to.clone()));
    }

    if !realign.is_empty() {
        crate::store::update_catalog(|catalog| {
            for (id, rel) in &realign {
                if let Some(v) = catalog
                    .get_mut("videos")
                    .and_then(|vs| vs.get_mut(id))
                    .and_then(|v| v.get_mut("video"))
                    .and_then(Value::as_object_mut)
                {
                    v.insert("localPath".into(), Value::String(rel.clone()));
                }
            }
            Ok(())
        })?;
    }

    report.moved = moves.len();
    report.planned = moves.into_iter().map(|(p, _, _)| p).collect();
    prune_empty_dirs(&paths.videos_dir, &paths.videos_dir);
    Ok(report)
}

// ── Cancellazioni ───────────────────────────────────────────────────────────

fn remove_file_and_empty_parent(paths: &crate::config::Paths, rel: &str) {
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

/// Cancella **solo** il file video dal disco, riportando il video a
/// `download: 'none'`. NON cancella la entry di catalogo, i metadati grezzi né la
/// copertina: il video resta in libreria, ri-scaricabile — coerente con "i record
/// non si perdono mai". È il ramo "No, non tenere il file" della domanda "Vuoi
/// tenere il video?".
pub fn delete_video_file(id: &str) -> Result<()> {
    let paths = get_paths()?;
    crate::store::update_catalog(|catalog| {
        let video_val = catalog
            .get_mut("videos")
            .and_then(|vs| vs.get_mut(id))
            .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))?;
        let map = video_val
            .as_object_mut()
            .ok_or_else(|| OndoError::not_found(format!("Video malformato: {id}")))?;
        let mut video = Video(std::mem::take(map));

        if !video.is_downloaded() {
            *map = video.0;
            return Err(OndoError::conflict(format!(
                "Il video \"{id}\" non ha un file scaricato da cancellare (stato download: \"{}\")",
                Video(map.clone()).download()
            )));
        }

        if let Some(rel) = video.local_path().map(str::to_string) {
            remove_file_and_empty_parent(&paths, &rel);
        }
        remove_from_download_archive(&paths, id)?;

        // Reset dei soli campi legati al file fisico; metadati curati, thumbnail e
        // grezzo restano intatti. `qualityNote` va azzerata: era del download vecchio.
        video.0.insert("download".into(), Value::String(crate::schema::download_state::NONE.into()));
        video.0.insert(
            "video".into(),
            serde_json::json!({
                "localPath": Value::Null, "formatId": Value::Null, "container": Value::Null,
                "videoCodec": Value::Null, "audioCodec": Value::Null, "bitrateKbps": Value::Null,
                "sizeBytes": Value::Null, "sha256": Value::Null, "downloadedAt": Value::Null,
                "ytdlpVersion": Value::Null, "qualityNote": Value::Null
            }),
        );
        video.touch();
        *map = video.0;
        Ok(())
    })
}

/// Cancellazione **totale e irreversibile**: file video + copertina + entry di
/// catalogo + metadati grezzi. Richiedibile SOLO su un video già archiviato — un
/// gate a due passi deliberato (prima archivia, poi eventualmente cancella per
/// sempre).
///
/// Non è una blocklist: se il video appartiene ancora a una fonte attiva su
/// YouTube, la prossima sync lo ricrea da zero. È "come se non l'avessimo mai
/// catalogato".
pub fn delete_video_completely(id: &str) -> Result<()> {
    let paths = get_paths()?;
    crate::store::update_catalog(|catalog| {
        let videos = catalog
            .get_mut("videos")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| OndoError::not_found("Catalogo senza video."))?;
        let video = videos
            .get(id)
            .and_then(|v| Video::from_value(v.clone()))
            .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))?;

        if !video.hidden() {
            return Err(OndoError::conflict(format!(
                "Il video \"{id}\" va prima archiviato prima di poterlo cancellare definitivamente."
            )));
        }

        if let Some(rel) = video.local_path() {
            remove_file_and_empty_parent(&paths, rel);
        }
        if let Some(thumb) = video.0.get("thumbnail").and_then(|t| t.get("localPath")).and_then(Value::as_str) {
            let _ = std::fs::remove_file(paths.thumbnails_dir.join(thumb));
        }
        remove_from_download_archive(&paths, id)?;
        videos.remove(id);
        Ok(())
    })?;
    // Fuori dal lock del catalogo: metadata.json ha un lock proprio, prenderli
    // entrambi annidati sarebbe un invito al deadlock.
    crate::metadata::delete_metadata(id)
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
