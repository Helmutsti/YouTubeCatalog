//! Schema dello stato: **autori**, **video**, **sorgenti**.
//!
//! ## Modello di stato a flag ORTOGONALI
//!
//! Un `status` lineare non sa esprimere stati che coesistono: un video può essere
//! insieme *rimosso da YouTube* e *scaricato sul disco* — ed è esattamente il caso
//! che dà senso al progetto. Ogni dimensione vive quindi su un asse separato, e i
//! flag utente-visibili sono tutti **derivati** (vedi [`video_category`]).
//!
//! ## Gli autori sono entità, ma lo snapshot resta nel video
//!
//! Prima gli autori erano *derivati* raggruppando i video: il nome duplicato in
//! ogni entry, gli avatar in una mappa a parte, e un autore non poteva esistere con
//! zero video. Ora `authors` è una tabella.
//!
//! **`video.channel` resta comunque**, e non è ridondanza. È uno *snapshot*, come
//! `statsAtDownload`: se un canale viene rinominato o terminato, il video conserva
//! il nome che aveva quando l'abbiamo salvato. La tabella `authors` dice *com'è
//! adesso*, lo snapshot dice *com'era* — e preservare la seconda informazione è il
//! motivo per cui questo progetto esiste. Il collegamento è `video.authorKey`.
//!
//! ## Perché `Video` e `Author` avvolgono una mappa JSON
//!
//! Scelta deliberata. Una struct tipizzata scarterebbe silenziosamente i campi che
//! non ha modellato (il catalogo reale ne ha decine) e riordinerebbe le chiavi in
//! scrittura, rendendo illeggibile qualunque diff. Avvolgendo una `serde_json::Map`
//! (compilata con `preserve_order`) la fedeltà è garantita: si legge, si tocca solo
//! ciò che serve, si riscrive uguale.

use serde_json::{json, Map, Value};

use crate::time::now_iso8601;

/// Versione del formato su disco. 1 = vecchio `catalog.json` monolitico;
/// 2 = `sources.json` + `library.json` + `metadata/<id>.json`.
pub const STATE_VERSION: u64 = 2;

// ── Assi ortogonali ─────────────────────────────────────────────────────────

pub mod presence {
    pub const PRESENT: &str = "present";
    pub const REMOVED: &str = "removed";
}

pub mod download_state {
    pub const NONE: &str = "none";
    pub const DOWNLOADING: &str = "downloading";
    pub const DOWNLOADED: &str = "downloaded";
    pub const FAILED: &str = "failed";
}

/// Categoria derivata a UNA dimensione, per le viste che mostrano un solo
/// indicatore. È l'**unico** punto in cui gli assi vengono collassati, così la CLI
/// non reimplementa la regola. L'ordine di priorità è una decisione: `Hidden` batte
/// `Downloaded`, così un archiviato resta archiviato anche se ha il file su disco.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCategory {
    Removed,
    Downloading,
    Failed,
    Hidden,
    Downloaded,
    Available,
}

impl VideoCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoCategory::Removed => "removed",
            VideoCategory::Downloading => "downloading",
            VideoCategory::Failed => "failed",
            VideoCategory::Hidden => "hidden",
            VideoCategory::Downloaded => "downloaded",
            VideoCategory::Available => "available",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VideoCategory::Removed => "✖ rimosso",
            VideoCategory::Downloading => "⬇ in corso",
            VideoCategory::Failed => "⚠ fallito",
            VideoCategory::Hidden => "◌ archiviato",
            VideoCategory::Downloaded => "✔ scaricato",
            VideoCategory::Available => "· da scaricare",
        }
    }
}

pub fn video_category(video: &Video) -> VideoCategory {
    if video.presence() == presence::REMOVED {
        return VideoCategory::Removed;
    }
    if video.download() == download_state::DOWNLOADING {
        return VideoCategory::Downloading;
    }
    if video.download() == download_state::FAILED {
        return VideoCategory::Failed;
    }
    if video.hidden() {
        return VideoCategory::Hidden;
    }
    if video.download() == download_state::DOWNLOADED {
        return VideoCategory::Downloaded;
    }
    VideoCategory::Available
}

// ── Video ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Video(pub Map<String, Value>);

impl Video {
    pub fn from_value(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Video(map)),
            _ => None,
        }
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    fn s(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn id(&self) -> &str {
        self.s("id").unwrap_or("")
    }
    pub fn title(&self) -> Option<&str> {
        self.s("title").filter(|t| !t.is_empty())
    }
    pub fn presence(&self) -> &str {
        self.s("presence").unwrap_or(presence::PRESENT)
    }
    pub fn download(&self) -> &str {
        self.s("download").unwrap_or(download_state::NONE)
    }
    pub fn hidden(&self) -> bool {
        self.0.get("hidden").and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn favorite(&self) -> bool {
        self.0.get("favorite").and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn added_at(&self) -> &str {
        self.s("addedAt").unwrap_or("")
    }
    pub fn duration_seconds(&self) -> Option<f64> {
        self.0.get("durationSeconds").and_then(Value::as_f64)
    }
    pub fn webpage_url(&self) -> Option<&str> {
        self.s("webpageUrl")
    }
    pub fn description(&self) -> Option<&str> {
        self.s("description")
    }
    pub fn size_bytes(&self) -> Option<u64> {
        self.0.get("video")?.get("sizeBytes")?.as_u64()
    }
    pub fn local_path(&self) -> Option<&str> {
        self.0.get("video")?.get("localPath")?.as_str()
    }
    pub fn quality_note(&self) -> Option<&Value> {
        self.0.get("video")?.get("qualityNote").filter(|v| !v.is_null())
    }
    pub fn error_message(&self) -> Option<&str> {
        self.0.get("error")?.get("message")?.as_str()
    }

    /// Snapshot del canale al momento del salvataggio (vedi la nota in testa).
    pub fn channel_name(&self) -> Option<&str> {
        self.0.get("channel")?.get("name")?.as_str()
    }
    pub fn channel_id(&self) -> Option<&str> {
        self.0.get("channel")?.get("id")?.as_str()
    }

    /// Collegamento alla tabella `authors`. Se assente si ricalcola dallo snapshot,
    /// così un catalogo non ancora migrato resta leggibile.
    pub fn author_key(&self) -> Option<String> {
        if let Some(k) = self.s("authorKey") {
            if !k.is_empty() {
                return Some(k.to_string());
            }
        }
        author_key_from(self.channel_id(), self.channel_name())
    }

    pub fn tags(&self) -> Vec<&str> {
        self.0
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }

    pub fn source_ids(&self) -> Vec<&str> {
        self.0
            .get("sources")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.get("sourceId").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn is_downloaded(&self) -> bool {
        self.download() == download_state::DOWNLOADED
    }

    pub fn category(&self) -> VideoCategory {
        video_category(self)
    }

    /// Titolo da mostrare: quello vero se c'è, altrimenti dedotto dal nome file già
    /// scelto da yt-dlp (`<Titolo> [<id>].<ext>`), altrimenti l'id nudo.
    pub fn display_title(&self) -> String {
        if let Some(t) = self.title() {
            return t.to_string();
        }
        if let Some(local) = self.local_path() {
            let base = local.rsplit(['/', '\\']).next().unwrap_or(local);
            let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
            let suffix = format!(" [{}]", self.id());
            let derived = stem.strip_suffix(&suffix).unwrap_or(stem).trim();
            if !derived.is_empty() {
                return derived.to_string();
            }
        }
        self.id().to_string()
    }

    // -- mutazioni: scrivono sulla chiave esistente, quindi l'ordine del JSON non cambia --

    pub fn set(&mut self, key: &str, value: Value) {
        self.0.insert(key.to_string(), value);
    }
    pub fn set_hidden(&mut self, v: bool) {
        self.set("hidden", Value::Bool(v));
        self.touch();
    }
    pub fn set_favorite(&mut self, v: bool) {
        self.set("favorite", Value::Bool(v));
        self.touch();
    }
    pub fn touch(&mut self) {
        self.set("updatedAt", json!(now_iso8601()));
    }
}

/// Chiave stabile di un autore: l'id del canale se noto, altrimenti il nome.
/// L'id manca sui video non ancora arricchiti, e in quel caso il nome è tutto ciò
/// che abbiamo — meglio un raggruppamento per nome che nessun raggruppamento.
pub fn author_key_from(channel_id: Option<&str>, channel_name: Option<&str>) -> Option<String> {
    channel_id
        .filter(|s| !s.is_empty())
        .or(channel_name.filter(|s| !s.is_empty()))
        .map(str::to_string)
}

// ── Autore ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Author(pub Map<String, Value>);

impl Author {
    pub fn from_value(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Author(map)),
            _ => None,
        }
    }
    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    fn s(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn key(&self) -> &str {
        self.s("key").unwrap_or("")
    }
    pub fn id(&self) -> Option<&str> {
        self.s("id")
    }
    pub fn name(&self) -> Option<&str> {
        self.s("name").filter(|n| !n.is_empty())
    }
    pub fn url(&self) -> Option<&str> {
        self.s("url")
    }
    pub fn display_name(&self) -> String {
        self.name().unwrap_or_else(|| self.key()).to_string()
    }
    pub fn avatar_local_path(&self) -> Option<&str> {
        self.0.get("avatar")?.get("localPath")?.as_str()
    }
    pub fn avatar_source_url(&self) -> Option<&str> {
        self.0.get("avatar")?.get("sourceUrl")?.as_str()
    }

    pub fn new(key: &str, id: Option<&str>, name: Option<&str>, url: Option<&str>) -> Self {
        let now = now_iso8601();
        Author::from_value(json!({
            "key": key,
            "id": id,
            "name": name,
            "url": url,
            "uploaderId": Value::Null,
            "subscriberCount": Value::Null,
            "avatar": { "sourceUrl": Value::Null, "localPath": Value::Null, "updatedAt": Value::Null },
            "addedAt": now,
            "updatedAt": now
        }))
        .expect("json! costruisce un oggetto")
    }

    /// Aggiorna i campi "attuali" senza mai svuotarli con un valore assente: un
    /// arricchimento che non riporta l'url non deve cancellare quello che c'era.
    pub fn refresh(&mut self, name: Option<&str>, url: Option<&str>, subscriber_count: Option<u64>) {
        let mut changed = false;
        if let Some(n) = name.filter(|s| !s.is_empty()) {
            if self.name() != Some(n) {
                self.0.insert("name".into(), json!(n));
                changed = true;
            }
        }
        if let Some(u) = url.filter(|s| !s.is_empty()) {
            if self.url() != Some(u) {
                self.0.insert("url".into(), json!(u));
                changed = true;
            }
        }
        if let Some(c) = subscriber_count {
            self.0.insert("subscriberCount".into(), json!(c));
            changed = true;
        }
        if changed {
            self.0.insert("updatedAt".into(), json!(now_iso8601()));
        }
    }

    pub fn set_avatar(&mut self, source_url: Option<&str>, local_path: Option<&str>) {
        self.0.insert(
            "avatar".into(),
            json!({
                "sourceUrl": source_url,
                "localPath": local_path,
                "updatedAt": now_iso8601()
            }),
        );
        self.0.insert("updatedAt".into(), json!(now_iso8601()));
    }
}

// ── Sorgente ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Source(pub Map<String, Value>);

impl Source {
    pub fn from_value(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Source(map)),
            _ => None,
        }
    }
    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }
    pub fn id(&self) -> &str {
        self.0.get("id").and_then(Value::as_str).unwrap_or("")
    }
    pub fn name(&self) -> Option<&str> {
        self.0.get("name").and_then(Value::as_str).filter(|n| !n.is_empty())
    }
    pub fn url(&self) -> Option<&str> {
        self.0.get("url").and_then(Value::as_str)
    }
    pub fn last_checked_at(&self) -> Option<&str> {
        self.0.get("lastCheckedAt").and_then(Value::as_str)
    }
    pub fn display_name(&self) -> String {
        self.name().unwrap_or_else(|| self.id()).to_string()
    }

    pub fn new_playlist(id: &str, name: &str, url: &str) -> Self {
        Source::from_value(json!({
            "type": "playlist",
            "id": id,
            "name": name,
            "url": url,
            "lastCheckedAt": Value::Null
        }))
        .expect("json! costruisce un oggetto")
    }
}

// ── Costruzione di un nuovo video ───────────────────────────────────────────

pub struct NewVideo<'a> {
    pub id: &'a str,
    pub title: Option<&'a str>,
    pub channel_name: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub duration_seconds: Option<f64>,
    pub playlist_index: Option<u64>,
    pub playlist_id: Option<&'a str>,
    pub playlist_title: Option<&'a str>,
    pub source_id: Option<&'a str>,
    /// Le playlist sono YouTube-only, da cui i default. Il download one-off
    /// (qualunque sito supportato da yt-dlp) passa questi tre esplicitamente,
    /// risolti da yt-dlp stesso.
    pub webpage_url: Option<&'a str>,
    pub original_url: Option<&'a str>,
    pub extractor: Option<&'a str>,
}

pub fn new_video(args: NewVideo<'_>) -> Video {
    let now = now_iso8601();
    let author_key = author_key_from(args.channel_id, args.channel_name);
    let value = json!({
        "id": args.id,
        "title": args.title,
        "description": Value::Null,
        "webpageUrl": args.webpage_url
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", args.id)),
        "originalUrl": args.original_url,
        "extractor": args.extractor.unwrap_or("youtube"),
        // Collegamento alla tabella authors…
        "authorKey": author_key,
        // …e snapshot di com'era il canale quando l'abbiamo visto.
        "channel": {
            "id": args.channel_id,
            "name": args.channel_name,
            "url": Value::Null,
            "uploaderId": Value::Null,
            "uploaderUrl": Value::Null,
            "subscriberCountAtDownload": Value::Null
        },
        "uploadDate": Value::Null,
        "releaseTimestamp": Value::Null,
        "durationSeconds": args.duration_seconds,
        "categories": [],
        "tags": [],
        "language": Value::Null,
        "ageLimit": Value::Null,
        "availability": Value::Null,
        "license": Value::Null,
        "isLive": false,
        "wasLive": false,
        "statsAtDownload": {
            "viewCount": Value::Null, "likeCount": Value::Null,
            "commentCount": Value::Null, "averageRating": Value::Null
        },
        "resolution": { "width": Value::Null, "height": Value::Null, "fps": Value::Null, "dynamicRange": Value::Null },
        "thumbnails": [],
        "thumbnail": { "sourceUrl": Value::Null, "localPath": Value::Null },
        "chapters": [],
        "subtitleLanguagesAvailable": [],
        "playlistContext": {
            "playlistId": args.playlist_id,
            "playlistTitle": args.playlist_title,
            "playlistIndex": args.playlist_index
        },
        "video": {
            "localPath": Value::Null, "formatId": Value::Null, "container": Value::Null,
            "videoCodec": Value::Null, "audioCodec": Value::Null, "bitrateKbps": Value::Null,
            "sizeBytes": Value::Null, "sha256": Value::Null, "downloadedAt": Value::Null,
            "ytdlpVersion": Value::Null, "qualityNote": Value::Null
        },
        "presence": presence::PRESENT,
        "removedAt": Value::Null,
        // Sync consecutive in cui il video non è stato trovato: si marca "rimosso"
        // solo dopo alcune assenze di fila, per non etichettare per un glitch.
        "missCount": 0,
        "download": download_state::NONE,
        "hidden": false,
        // Asse indipendente da tutti gli altri: un video può essere rimosso,
        // archiviato E preferito insieme. Per questo resta fuori da video_category.
        "favorite": false,
        // Metadati completi + copertina già estratti? null finché l'arricchimento
        // non li recupera (i nuovi nascono coi soli campi leggeri dell'enumerazione).
        "enrichedAt": Value::Null,
        // Le fonti sono ETICHETTE portate dal video, non un vincolo di appartenenza:
        // un video esiste a sé e può portarne zero, una o più. Array vuoto = stato
        // normale e completo, non un "orfano".
        "sources": match args.source_id {
            Some(sid) => json!([{ "sourceId": sid, "name": args.playlist_title }]),
            None => json!([]),
        },
        "addedAt": now,
        "updatedAt": now,
        "attempts": 0,
        "error": Value::Null
    });
    Video::from_value(value).expect("json! costruisce un oggetto")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: Value) -> Video {
        Video::from_value(json).unwrap()
    }

    #[test]
    fn category_priority_is_the_documented_order() {
        assert_eq!(
            v(json!({"presence":"removed","download":"downloaded"})).category(),
            VideoCategory::Removed,
            "un rimosso resta rimosso anche se scaricato"
        );
        assert_eq!(
            v(json!({"presence":"present","download":"downloaded","hidden":true})).category(),
            VideoCategory::Hidden,
            "archiviato batte scaricato"
        );
        assert_eq!(v(json!({"download":"downloading","hidden":true})).category(), VideoCategory::Downloading);
        assert_eq!(v(json!({"download":"failed"})).category(), VideoCategory::Failed);
        assert_eq!(v(json!({"download":"downloaded"})).category(), VideoCategory::Downloaded);
        assert_eq!(v(json!({})).category(), VideoCategory::Available);
    }

    #[test]
    fn author_key_prefers_the_id_then_falls_back_to_the_name() {
        assert_eq!(author_key_from(Some("UC1"), Some("Nome")).as_deref(), Some("UC1"));
        assert_eq!(author_key_from(None, Some("Nome")).as_deref(), Some("Nome"));
        assert_eq!(author_key_from(Some(""), Some("Nome")).as_deref(), Some("Nome"));
        assert!(author_key_from(None, None).is_none());
        assert!(author_key_from(Some(""), Some("")).is_none());
    }

    #[test]
    fn author_key_is_recomputed_when_the_field_is_missing() {
        // Così un catalogo non ancora migrato resta leggibile.
        let video = v(json!({ "id": "a", "channel": { "id": "UC9", "name": "X" } }));
        assert_eq!(video.author_key().as_deref(), Some("UC9"));
    }

    #[test]
    fn the_video_keeps_its_channel_snapshot_alongside_the_author_link() {
        let video = new_video(NewVideo {
            id: "abc", title: Some("T"), channel_name: Some("Creator Vecchio Nome"),
            channel_id: Some("UC1"), duration_seconds: None, playlist_index: None,
            playlist_id: None, playlist_title: None, source_id: None,
            webpage_url: None, original_url: None, extractor: None,
        });
        assert_eq!(video.author_key().as_deref(), Some("UC1"));
        assert_eq!(
            video.channel_name(),
            Some("Creator Vecchio Nome"),
            "lo snapshot è il motivo per cui il progetto esiste: non va normalizzato via"
        );
    }

    #[test]
    fn refresh_never_erases_what_is_already_there() {
        let mut a = Author::new("UC1", Some("UC1"), Some("Nome"), Some("https://x"));
        a.refresh(None, None, None);
        assert_eq!(a.name(), Some("Nome"));
        assert_eq!(a.url(), Some("https://x"));
        a.refresh(Some(""), Some(""), None);
        assert_eq!(a.name(), Some("Nome"), "una stringa vuota non è un aggiornamento");
        a.refresh(Some("Nuovo"), None, Some(42));
        assert_eq!(a.name(), Some("Nuovo"));
        assert_eq!(a.url(), Some("https://x"));
    }

    #[test]
    fn unknown_fields_and_key_order_survive_a_round_trip() {
        let original = json!({
            "id": "abc", "presence": "present", "download": "none",
            "campoSconosciutoDelFuturo": { "annidato": [1, 2, 3] }
        });
        let mut video = v(original.clone());
        video.set_favorite(true);
        let out = video.into_value();
        assert_eq!(out.get("campoSconosciutoDelFuturo"), original.get("campoSconosciutoDelFuturo"));
        let keys: Vec<_> = out.as_object().unwrap().keys().take(3).collect();
        assert_eq!(keys, vec!["id", "presence", "download"]);
    }

    #[test]
    fn display_title_falls_back_to_filename_then_id() {
        assert_eq!(v(json!({"id":"a","title":"Vero"})).display_title(), "Vero");
        assert_eq!(
            v(json!({"id":"a","video":{"localPath":"C/Dedotto [a].mp4"}})).display_title(),
            "Dedotto"
        );
        assert_eq!(v(json!({"id":"a"})).display_title(), "a");
    }
}
