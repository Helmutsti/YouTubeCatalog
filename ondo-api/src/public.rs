//! La forma con cui le cose escono dall'API.
//!
//! Non si spediscono i record grezzi: si aggiunge quello che serve a un client HTTP
//! e che lui non può calcolare — gli URL dei file e la **categoria** derivata, che è
//! l'unica cosa che il frontend guarda per decidere colore ed etichetta.

use ondo::{JobStatus, Library, State, Video};
use serde_json::{json, Value};

/// La categoria in una parola, come la aspetta il frontend.
///
/// L'ordine di precedenza è "quanto richiede attenzione adesso": un video che sta
/// scaricando lo dice, anche se è archiviato. `available` era, nell'API originale,
/// "presente su YouTube e non scaricato": qui è semplicemente *da scaricare*,
/// perché senza le sorgenti non esiste nessuno che verifichi la presenza.
pub fn category(v: &Video) -> &'static str {
    match () {
        _ if v.state == State::Downloading => "downloading",
        _ if v.state == State::Failed => "failed",
        _ if v.removed => "removed",
        _ if v.archived => "hidden",
        _ if v.state == State::Downloaded => "downloaded",
        _ => "available",
    }
}

/// Percent-encoding di un segmento di percorso.
///
/// Serve perché i nomi canonici contengono spazi, accenti ed emoji: `Rick Astley/Mai
/// più [id].mp4` non è un URL valido. Si codifica **segmento per segmento**, così le
/// barre restano separatori.
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn url_relativo(base: &str, rel: &str) -> String {
    let percorso: Vec<String> = rel
        .split(['/', '\\'])
        .filter(|p| !p.is_empty())
        .map(encode_segment)
        .collect();
    format!("{base}/{}", percorso.join("/"))
}

/// Un video come lo vede un client: i campi del record, più categoria e URL.
pub fn video(lib: &Library, v: &Video) -> Value {
    let mut out = serde_json::to_value(v).unwrap_or_else(|_| json!({}));
    let obj = out.as_object_mut().expect("un Video è un oggetto");

    obj.insert("category".into(), json!(category(v)));
    obj.insert("durationLabel".into(), json!(v.duration_label()));

    if v.state == State::Downloaded && !v.file.is_empty() {
        obj.insert("videoUrl".into(), json!(url_relativo("/media/videos", &v.file)));
        obj.insert("fileExists".into(), json!(lib.file_path(v).is_file()));
    } else {
        obj.insert("videoUrl".into(), Value::Null);
        obj.insert("fileExists".into(), json!(false));
    }

    match &v.cover {
        Some(c) => {
            let url = url_relativo("/media/covers", c);
            // `thumbnailUrl` è un alias di compatibilità: l'API originale chiamava
            // così la copertina, e il frontend non deve cambiare per un nome.
            obj.insert("coverUrl".into(), json!(url.clone()));
            obj.insert("thumbnailUrl".into(), json!(url));
        }
        None => {
            obj.insert("coverUrl".into(), Value::Null);
            obj.insert("thumbnailUrl".into(), Value::Null);
        }
    }
    out
}

/// Un job del pool come lo vede un client.
pub fn job(s: &JobStatus) -> Value {
    json!({
        "job": s.job,
        "url": s.url,
        "id": s.id,
        "title": s.title,
        "phase": s.phase.map(|p| p.label()),
        "percent": s.percent,
        "started": s.started,
        "done": s.done,
        "error": s.error,
        "maxHeight": s.max_height,
        "active": s.active(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_what_a_url_cannot_carry() {
        assert_eq!(encode_segment("Rick Astley"), "Rick%20Astley");
        assert_eq!(encode_segment("Perché"), "Perch%C3%A9");
        assert_eq!(encode_segment("a-b_c.d~e"), "a-b_c.d~e", "gli inoffensivi restano");
        assert_eq!(encode_segment("q?#&="), "q%3F%23%26%3D");
    }

    #[test]
    fn the_separators_survive_but_the_names_are_encoded() {
        assert_eq!(
            url_relativo("/media/videos", "Rick Astley/Mai più [x].mp4"),
            "/media/videos/Rick%20Astley/Mai%20pi%C3%B9%20%5Bx%5D.mp4"
        );
        // Il layout su Windows arriva con le barre rovesce: sono separatori anche loro.
        assert_eq!(url_relativo("/media/videos", "A\\b.mp4"), "/media/videos/A/b.mp4");
    }

    #[test]
    fn the_category_says_what_needs_attention_first() {
        let scaricando = Video { state: State::Downloading, archived: true, ..Video::default() };
        assert_eq!(category(&scaricando), "downloading", "batte l'archiviazione");
        let fallito = Video { state: State::Failed, removed: true, ..Video::default() };
        assert_eq!(category(&fallito), "failed");
        let archiviato = Video { state: State::Downloaded, archived: true, ..Video::default() };
        assert_eq!(category(&archiviato), "hidden");
        assert_eq!(category(&Video { state: State::Downloaded, ..Video::default() }), "downloaded");
        assert_eq!(category(&Video::default()), "available", "pending = da scaricare");
    }
}
