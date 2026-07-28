//! Interrogazioni sul catalogo — porting di `core/src/services/videoService.js`
//! e della parte "asse hidden/favorite" di `decisionService.js`.

use serde_json::Value;

use crate::error::{OndoError, Result};
use crate::schema::{download_state, presence, Video};
use crate::store::{read_catalog, update_catalog, videos_of};

/// Filtro sui flag ortogonali (M25): ogni criterio passato deve combaciare (AND).
/// `None` su un asse = non filtrare su quell'asse.
#[derive(Debug, Clone, Default)]
pub struct VideoFilter<'a> {
    pub presence: Option<&'a str>,
    pub download: Option<&'a str>,
    pub hidden: Option<bool>,
    pub favorite: Option<bool>,
}

impl<'a> VideoFilter<'a> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn presence(mut self, v: &'a str) -> Self {
        self.presence = Some(v);
        self
    }
    pub fn download(mut self, v: &'a str) -> Self {
        self.download = Some(v);
        self
    }
    pub fn hidden(mut self, v: bool) -> Self {
        self.hidden = Some(v);
        self
    }
    pub fn favorite(mut self, v: bool) -> Self {
        self.favorite = Some(v);
        self
    }

    fn matches(&self, video: &Video) -> bool {
        if let Some(p) = self.presence {
            if video.presence() != p {
                return false;
            }
        }
        if let Some(d) = self.download {
            if video.download() != d {
                return false;
            }
        }
        if let Some(h) = self.hidden {
            if video.hidden() != h {
                return false;
            }
        }
        if let Some(f) = self.favorite {
            if video.favorite() != f {
                return false;
            }
        }
        true
    }
}

/// Ordinati per `addedAt` **discendente** (i più recenti prima), come il JS:
/// `(b.addedAt || '').localeCompare(a.addedAt || '')`. I timestamp sono ISO-8601
/// UTC a lunghezza fissa, quindi l'ordine lessicografico coincide con quello
/// cronologico e un confronto di stringhe è sufficiente.
pub fn list_videos_in(catalog: &Value, filter: &VideoFilter<'_>) -> Vec<Video> {
    let mut videos: Vec<Video> = videos_of(catalog)
        .into_iter()
        .filter(|v| filter.matches(v))
        .collect();
    videos.sort_by(|a, b| b.added_at().cmp(a.added_at()));
    videos
}

pub fn list_videos(filter: &VideoFilter<'_>) -> Result<Vec<Video>> {
    Ok(list_videos_in(&read_catalog()?, filter))
}

pub fn get_video_in(catalog: &Value, id: &str) -> Result<Video> {
    catalog
        .get("videos")
        .and_then(|v| v.get(id))
        .and_then(|v| Video::from_value(v.clone()))
        .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))
}

pub fn get_video(id: &str) -> Result<Video> {
    get_video_in(&read_catalog()?, id)
}

/// "Disponibili": presenti su YouTube, non ancora scaricati, non nascosti — i
/// video su cui ha senso proporre il download. Sostituisce l'ex `listNew()`.
pub fn list_available_in(catalog: &Value) -> Vec<Video> {
    list_videos_in(
        catalog,
        &VideoFilter::new()
            .presence(presence::PRESENT)
            .download(download_state::NONE)
            .hidden(false),
    )
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub key: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub count: usize,
}

/// Default: **tutti** i creator (qualunque stato di download), così un creator
/// appena aggiunto compare subito anche senza video scaricati. I contesti "solo
/// scaricati" (il menu Guarda) passano esplicitamente `download`.
pub fn list_channels_in(catalog: &Value, download: Option<&str>) -> Vec<Channel> {
    let mut filter = VideoFilter::new();
    if let Some(d) = download {
        filter = filter.download(d);
    }

    // Mappa che preserva l'ordine di inserimento, come la `Map` del JS: conta
    // prima, ordina dopo, così il risultato è deterministico a pari nome.
    let mut order: Vec<String> = Vec::new();
    let mut channels: std::collections::HashMap<String, Channel> = std::collections::HashMap::new();

    for video in list_videos_in(catalog, &filter) {
        let Some(key) = video.channel_key() else { continue };
        let key = key.to_string();
        channels
            .entry(key.clone())
            .and_modify(|c| c.count += 1)
            .or_insert_with(|| {
                order.push(key.clone());
                Channel {
                    key: key.clone(),
                    id: video.channel_id().map(str::to_string),
                    name: video.channel_name().map(str::to_string),
                    count: 1,
                }
            });
    }

    let mut result: Vec<Channel> = order
        .into_iter()
        .filter_map(|k| channels.remove(&k))
        .collect();
    // `localeCompare` sul nome, come il JS. Confronto lessicografico semplice:
    // `Intl` non è disponibile e per i nomi dei canali reali l'ordine coincide.
    result.sort_by(|a, b| {
        a.name
            .as_deref()
            .unwrap_or("")
            .cmp(b.name.as_deref().unwrap_or(""))
    });
    result
}

pub fn list_channels(download: Option<&str>) -> Result<Vec<Channel>> {
    Ok(list_channels_in(&read_catalog()?, download))
}

pub fn list_videos_by_channel_in(
    catalog: &Value,
    channel_key: &str,
    download: Option<&str>,
) -> Vec<Video> {
    let mut filter = VideoFilter::new();
    if let Some(d) = download {
        filter = filter.download(d);
    }
    list_videos_in(catalog, &filter)
        .into_iter()
        .filter(|v| v.channel_key() == Some(channel_key))
        .collect()
}

pub fn list_videos_by_channel(channel_key: &str, download: Option<&str>) -> Result<Vec<Video>> {
    Ok(list_videos_by_channel_in(&read_catalog()?, channel_key, download))
}

// ── Mutazioni sugli assi hidden/favorite (decisionService.js) ────────────────

fn mutate_video<F>(id: &str, apply: F) -> Result<Video>
where
    F: FnOnce(&mut Video),
{
    update_catalog(|catalog| {
        let videos = catalog
            .get_mut("videos")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| OndoError::not_found("Catalogo senza video."))?;
        let raw = videos
            .get_mut(id)
            .ok_or_else(|| OndoError::not_found(format!("Video non trovato nel catalogo: {id}")))?;
        let map = match raw {
            Value::Object(m) => m,
            _ => return Err(OndoError::not_found(format!("Video malformato: {id}"))),
        };
        let mut video = Video(std::mem::take(map));
        apply(&mut video);
        *map = video.0.clone();
        Ok(video)
    })
}

/// Nascondi/mostra un video (asse `hidden`, ex `excluded`).
pub fn set_video_hidden(id: &str, hidden: bool) -> Result<Video> {
    mutate_video(id, |v| v.set_hidden(hidden))
}

/// Preferito (M43): asse indipendente da tutti gli altri.
pub fn set_video_favorite(id: &str, favorite: bool) -> Result<Video> {
    mutate_video(id, |v| v.set_favorite(favorite))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cat() -> Value {
        json!({
            "version": 1,
            "videos": {
                "a": {"id":"a","presence":"present","download":"downloaded","hidden":false,
                       "favorite":true,"addedAt":"2026-01-01T00:00:00.000Z",
                       "channel":{"id":"UC1","name":"Bravo"}},
                "b": {"id":"b","presence":"present","download":"none","hidden":true,
                       "favorite":false,"addedAt":"2026-03-01T00:00:00.000Z",
                       "channel":{"id":"UC2","name":"Alfa"}},
                "c": {"id":"c","presence":"removed","download":"downloaded","hidden":false,
                       "favorite":false,"addedAt":"2026-02-01T00:00:00.000Z",
                       "channel":{"id":"UC1","name":"Bravo"}}
            },
            "sources": {}, "meta": {}
        })
    }

    #[test]
    fn sorted_by_added_at_descending() {
        let ids: Vec<_> = list_videos_in(&cat(), &VideoFilter::new())
            .iter()
            .map(|v| v.id().to_string())
            .collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn filters_are_and_combined() {
        let f = VideoFilter::new().presence(presence::PRESENT).download(download_state::DOWNLOADED);
        let ids: Vec<_> = list_videos_in(&cat(), &f).iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["a"], "'c' è downloaded ma removed");

        let f = VideoFilter::new().hidden(true);
        assert_eq!(list_videos_in(&cat(), &f).len(), 1);

        let f = VideoFilter::new().favorite(true);
        assert_eq!(list_videos_in(&cat(), &f).len(), 1);
    }

    #[test]
    fn available_excludes_hidden_removed_and_downloaded() {
        // 'b' è l'unico non scaricato e presente, ma è nascosto → nessuno.
        assert!(list_available_in(&cat()).is_empty());
    }

    #[test]
    fn channels_are_grouped_counted_and_sorted_by_name() {
        let channels = list_channels_in(&cat(), None);
        let pairs: Vec<_> = channels
            .iter()
            .map(|c| (c.name.clone().unwrap_or_default(), c.count))
            .collect();
        assert_eq!(pairs, vec![("Alfa".to_string(), 1), ("Bravo".to_string(), 2)]);

        // Con filtro "solo scaricati": Bravo ha 2 video scaricati, Alfa nessuno.
        let only_downloaded = list_channels_in(&cat(), Some(download_state::DOWNLOADED));
        assert_eq!(only_downloaded.len(), 1);
        assert_eq!(only_downloaded[0].count, 2);
    }

    #[test]
    fn videos_by_channel_uses_the_same_key_as_list_channels() {
        let ids: Vec<_> = list_videos_by_channel_in(&cat(), "UC1", None)
            .iter()
            .map(|v| v.id().to_string())
            .collect();
        assert_eq!(ids, vec!["c", "a"]);
    }

    #[test]
    fn get_video_not_found_has_the_javascript_message() {
        let err = get_video_in(&cat(), "zzz").unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::NotFound);
        assert_eq!(err.message, "Video non trovato nel catalogo: zzz");
    }
}
