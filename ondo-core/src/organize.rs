use std::path::Path;

use crate::error::{Error, Result};

/// Un nome di file che Windows accetti e che una persona riesca a leggere.
/// I caratteri vietati (`< > : " / \ | ? *`) e i controlli diventano `-`; punti e
/// spazi finali vengono via (Windows li rifiuta in coda a un nome); la lunghezza
/// è tagliata a 120 caratteri per non sfondare il limite di percorso.
pub fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => out.push('-'),
            c if (c as u32) < 0x20 => out.push('-'),
            c => out.push(c),
        }
    }
    let out = out.trim().trim_end_matches(['.', ' ']).to_string();
    let out: String = out.chars().take(120).collect();
    let out = out.trim_end().to_string();
    if out.is_empty() {
        "senza-nome".to_string()
    } else {
        out
    }
}

/// `<Autore>/<Titolo> [<id>].<ext>` — relativo alla **cartella dei video**, non
/// alla radice: è ciò che permette di spostare l'archivio cambiando una riga di
/// config.
///
/// L'id è **sempre** nel nome, non solo in caso di collisione: due video con lo
/// stesso titolo nello stesso canale esistono davvero, e così il problema non si
/// pone mai.
pub fn video_rel_path(author: &str, title: &str, id: &str, ext: &str) -> String {
    let ext = if ext.is_empty() { "mp4" } else { ext };
    format!("{}/{} [{}].{}", sanitize(author), sanitize(title), id, ext)
}

/// Sposta un file creando le cartelle che servono. `rename` è istantaneo sullo
/// stesso volume; se staging e archivio stanno su volumi diversi il rename non è
/// permesso, e allora si copia e si cancella l'originale.
pub fn move_file(from: &Path, to: &Path) -> Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to)
                .map_err(|e| Error::new(format!("copia {} → {}: {e}", from.display(), to.display())))?;
            let _ = std::fs::remove_file(from);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_what_windows_refuses() {
        assert_eq!(sanitize("a/b:c?d"), "a-b-c-d");
        assert_eq!(sanitize("  spazi  "), "spazi");
        assert_eq!(sanitize("finisce con punto..."), "finisce con punto");
        assert_eq!(sanitize(""), "senza-nome");
        assert_eq!(sanitize("..."), "senza-nome");
    }

    #[test]
    fn keeps_readable_characters() {
        assert_eq!(sanitize("Perché però — sì! 🎧"), "Perché però — sì! 🎧");
    }

    #[test]
    fn builds_the_canonical_path() {
        assert_eq!(
            video_rel_path("Rick Astley", "Never Gonna Give You Up", "dQw4w9WgXcQ", "mp4"),
            "Rick Astley/Never Gonna Give You Up [dQw4w9WgXcQ].mp4"
        );
        assert_eq!(
            video_rel_path("A/B", "Ti: cerco", "x1", ""),
            "A-B/Ti- cerco [x1].mp4",
            "senza estensione si assume mp4, che è il formato di fusione"
        );
    }

    #[test]
    fn long_titles_do_not_blow_the_path_limit() {
        let long = "a".repeat(300);
        assert_eq!(sanitize(&long).chars().count(), 120);
    }
}
