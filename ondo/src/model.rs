use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Un video in libreria. I percorsi (`file`, `cover`, `metadata`) sono **relativi
/// alla radice**: spostare l'archivio non richiede di riscrivere `library.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub author: String,
    pub author_id: Option<String>,
    /// URL della pagina reale, qualunque sito sia: è da qui che si riscarica.
    pub url: String,
    /// Estrattore usato da yt-dlp (`youtube`, `rumble`, …).
    pub extractor: String,
    pub description: String,
    pub duration_seconds: Option<f64>,
    /// `YYYY-MM-DD`, quando yt-dlp la conosce.
    pub upload_date: Option<String>,
    pub tags: Vec<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub fps: Option<f64>,

    pub file: String,
    pub size_bytes: u64,
    pub cover: Option<String>,
    pub metadata: Option<String>,
    /// Secondi dall'epoch: una data senza dipendenze e ordinabile.
    pub added_at: u64,
}

impl Video {
    /// Costruisce il record dai metadati grezzi di yt-dlp. I campi che dipendono
    /// dal file su disco (`file`, `size_bytes`, `cover`, `metadata`) li riempie
    /// chi organizza, non questa funzione.
    pub fn from_metadata(meta: &Value) -> Video {
        Video {
            id: string(meta, "id"),
            title: {
                let t = string(meta, "title");
                if t.is_empty() {
                    string(meta, "id")
                } else {
                    t
                }
            },
            author: author_of(meta),
            author_id: opt_string(meta, "channel_id").or_else(|| opt_string(meta, "uploader_id")),
            url: opt_string(meta, "webpage_url")
                .or_else(|| opt_string(meta, "original_url"))
                .unwrap_or_default(),
            extractor: opt_string(meta, "extractor_key")
                .or_else(|| opt_string(meta, "extractor"))
                .unwrap_or_default(),
            description: string(meta, "description"),
            duration_seconds: meta.get("duration").and_then(Value::as_f64),
            upload_date: opt_string(meta, "upload_date").and_then(|d| dashed_date(&d)),
            tags: meta
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            width: meta.get("width").and_then(Value::as_u64),
            height: meta.get("height").and_then(Value::as_u64),
            fps: meta.get("fps").and_then(Value::as_f64),
            ..Video::default()
        }
    }

    /// Durata in `h:mm:ss` (o `m:ss`), per chi deve solo mostrarla.
    pub fn duration_label(&self) -> String {
        let Some(total) = self.duration_seconds.map(|d| d.max(0.0) as u64) else {
            return "–".into();
        };
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
        if h > 0 {
            format!("{h}:{m:02}:{s:02}")
        } else {
            format!("{m}:{s:02}")
        }
    }
}

/// L'autore secondo yt-dlp, con i ripieghi nell'ordine in cui hanno senso:
/// `channel` è il nome mostrato, `uploader` esiste anche fuori da YouTube.
pub fn author_of(meta: &Value) -> String {
    for key in ["channel", "uploader", "playlist_uploader", "creator", "artist"] {
        let v = string(meta, key);
        if !v.is_empty() {
            return v;
        }
    }
    "Sconosciuto".into()
}

/// `20091025` → `2009-10-25`. Qualunque altra forma resta com'è.
fn dashed_date(raw: &str) -> Option<String> {
    if raw.len() == 8 && raw.bytes().all(|b| b.is_ascii_digit()) {
        Some(format!("{}-{}-{}", &raw[0..4], &raw[4..6], &raw[6..8]))
    } else if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn string(meta: &Value, key: &str) -> String {
    meta.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt_string(meta: &Value, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_the_fields_that_matter() {
        let meta = json!({
            "id": "abc123",
            "title": "Un titolo",
            "channel": "Il Canale",
            "channel_id": "UC42",
            "webpage_url": "https://www.youtube.com/watch?v=abc123",
            "extractor_key": "Youtube",
            "duration": 212.0,
            "upload_date": "20091025",
            "tags": ["uno", "due"],
            "width": 1920, "height": 1080, "fps": 25.0
        });
        let v = Video::from_metadata(&meta);
        assert_eq!(v.id, "abc123");
        assert_eq!(v.author, "Il Canale");
        assert_eq!(v.upload_date.as_deref(), Some("2009-10-25"));
        assert_eq!(v.tags, vec!["uno", "due"]);
        assert_eq!(v.duration_label(), "3:32");
    }

    #[test]
    fn survives_metadata_that_says_almost_nothing() {
        let v = Video::from_metadata(&json!({ "id": "solo-id" }));
        assert_eq!(v.title, "solo-id", "senza titolo si ricade sull'id");
        assert_eq!(v.author, "Sconosciuto");
        assert_eq!(v.duration_label(), "–");
        assert!(v.upload_date.is_none());
    }
}
