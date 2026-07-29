//! La forma con cui le cose escono dall'API.
//!
//! **È deliberatamente la forma dell'API originale**, non quella del record: il
//! frontend React è arrivato da `main` con ~100 punti che leggono
//! `video.channel.name`, `video.download`, `video.resolution.height`,
//! `video.hidden`… Tradurre qui costa sessanta righe in un file; tradurre là
//! sarebbe stato riscrivere cento punti in quindici file, con cento occasioni di
//! sbagliare. Un'API serve anche a questo.
//!
//! La corrispondenza campo per campo sta in `DIFFERENZE.md`.

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

/// L'asse `download` dell'API originale.
fn download_axis(v: &Video) -> &'static str {
    match v.state {
        State::Pending => "none",
        State::Downloading => "downloading",
        State::Downloaded => "downloaded",
        State::Failed => "failed",
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

/// Secondi dall'epoch → `1970-01-01T00:00:00Z`.
///
/// Il frontend fa `new Date(addedAt)`, quindi vuole una stringa ISO; noi teniamo un
/// numero. L'algoritmo (giorni civili da giorni dall'epoch) è quello di Howard
/// Hinnant: sessanta righe di dipendenza in meno.
pub fn iso_utc(secs: u64) -> String {
    let giorni = (secs / 86_400) as i64;
    let resto = secs % 86_400;
    let (h, m, s) = (resto / 3600, (resto % 3600) / 60, resto % 60);

    // Si sposta l'inizio dell'anno a marzo: così il 29 febbraio cade in fondo e
    // gli anni bisestili non hanno bisogno di casi particolari.
    let z = giorni + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // giorno dell'era, 0..=146096
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let anno = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // giorno dell'anno da marzo
    let mp = (5 * doy + 2) / 153; // mese spostato, 0 = marzo
    let giorno = doy - (153 * mp + 2) / 5 + 1;
    let mese = if mp < 10 { mp + 3 } else { mp - 9 };
    let anno = if mese <= 2 { anno + 1 } else { anno };

    format!("{anno:04}-{mese:02}-{giorno:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Un video nella forma dell'API originale.
pub fn video(lib: &Library, v: &Video) -> Value {
    let scaricato = v.state == State::Downloaded && !v.file.is_empty();
    let estensione = v.file.rsplit('.').next().filter(|e| !e.is_empty() && e.len() <= 5);

    json!({
        "id": v.id,
        "title": v.title,
        "description": v.description,
        "tags": v.tags,
        "uploadDate": v.upload_date,
        "durationSeconds": v.duration_seconds,
        "webpageUrl": v.url,
        "extractor": v.extractor,
        "addedAt": iso_utc(v.added_at),

        // L'API originale annidava l'autore in un canale. Il core parla di autori e
        // non ha avatar: `avatarUrl` resta null, e il frontend mostra l'iniziale.
        "channel": {
            "id": v.author_id,
            "name": v.author,
            "avatarUrl": Value::Null,
        },
        "resolution": {
            "width": v.width,
            "height": v.height,
            "fps": v.fps,
        },
        // I codec, il bitrate e la versione di yt-dlp non li registriamo: le righe
        // corrispondenti nella scheda restano vuote invece di mentire.
        "video": if scaricato {
            json!({
                "sizeBytes": v.size_bytes,
                "container": estensione,
                "videoCodec": Value::Null,
                "audioCodec": Value::Null,
                "bitrateKbps": Value::Null,
                "ytdlpVersion": Value::Null,
                "qualityNote": Value::Null,
            })
        } else {
            Value::Null
        },

        // I tre assi del modello a flag, come li leggeva il frontend.
        "presence": if v.removed { "removed" } else { "present" },
        "download": download_axis(v),
        "hidden": v.archived,
        "favorite": v.favorite,
        "removedAt": Value::Null,
        "error": v.error,
        "attempts": v.attempts,
        "enrichedAt": Value::Null,
        // Le fonti non esistono: un elenco vuoto è la verità, e il frontend lo
        // gestisce già (un video puo' non appartenere a nessuna fonte).
        "sources": Vec::<Value>::new(),

        "category": category(v),
        "videoUrl": if scaricato { json!(url_relativo("/media/videos", &v.file)) } else { Value::Null },
        "thumbnailUrl": v.cover.as_ref().map(|c| url_relativo("/media/covers", c)),
        "fileExists": scaricato && lib.file_path(v).is_file(),
    })
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

    /// I valori di riferimento vengono da `new Date(s*1000).toISOString()`, cioè da
    /// quello che il frontend farà con questa stringa.
    #[test]
    fn epoch_becomes_the_iso_string_javascript_expects() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1), "1970-01-01T00:00:01Z");
        // Un 29 febbraio, che è dove gli algoritmi scritti a mano si rompono.
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_785_322_318), "2026-07-29T10:51:58Z");
        assert_eq!(iso_utc(4_102_444_800), "2100-01-01T00:00:00Z");
    }
}
