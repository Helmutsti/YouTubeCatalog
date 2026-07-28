//! Viste di sola lettura sullo stato: filtri, autori, ricerca.
//!
//! Sono funzioni **pure** su uno [`State`] già caricato: nessuna I/O, nessun lock.
//! È la superficie che la CLI consuma per costruire i suoi elenchi — così le regole
//! di derivazione (categoria, raggruppamento, ordinamento) vivono qui e non nei menu.

use super::schema::{download_state, presence, Author, Video, VideoCategory};
use super::state::State;

/// Filtro sui flag ortogonali: ogni criterio passato deve combaciare (AND).
/// `None` su un asse = non filtrare su quell'asse.
#[derive(Debug, Clone, Default)]
pub struct Filter<'a> {
    pub presence: Option<&'a str>,
    pub download: Option<&'a str>,
    pub hidden: Option<bool>,
    pub favorite: Option<bool>,
    pub category: Option<VideoCategory>,
    pub author_key: Option<&'a str>,
    pub source_id: Option<&'a str>,
}

impl<'a> Filter<'a> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn category(mut self, c: VideoCategory) -> Self {
        self.category = Some(c);
        self
    }
    pub fn favorite(mut self, v: bool) -> Self {
        self.favorite = Some(v);
        self
    }
    pub fn hidden(mut self, v: bool) -> Self {
        self.hidden = Some(v);
        self
    }
    pub fn download(mut self, v: &'a str) -> Self {
        self.download = Some(v);
        self
    }
    pub fn author(mut self, key: &'a str) -> Self {
        self.author_key = Some(key);
        self
    }
    pub fn source(mut self, id: &'a str) -> Self {
        self.source_id = Some(id);
        self
    }

    fn matches(&self, v: &Video) -> bool {
        if let Some(p) = self.presence {
            if v.presence() != p {
                return false;
            }
        }
        if let Some(d) = self.download {
            if v.download() != d {
                return false;
            }
        }
        if let Some(h) = self.hidden {
            if v.hidden() != h {
                return false;
            }
        }
        if let Some(f) = self.favorite {
            if v.favorite() != f {
                return false;
            }
        }
        if let Some(c) = self.category {
            if v.category() != c {
                return false;
            }
        }
        if let Some(a) = self.author_key {
            if v.author_key().as_deref() != Some(a) {
                return false;
            }
        }
        if let Some(s) = self.source_id {
            if !v.source_ids().contains(&s) {
                return false;
            }
        }
        true
    }
}

/// Video filtrati, **dal più recente** (`addedAt` discendente). I timestamp sono
/// ISO-8601 UTC a lunghezza fissa, quindi l'ordine lessicografico coincide con
/// quello cronologico e un confronto di stringhe basta.
pub fn videos<'s>(state: &'s State, filter: &Filter<'_>) -> Vec<&'s Video> {
    let mut out: Vec<&Video> = state.videos.values().filter(|v| filter.matches(v)).collect();
    out.sort_by(|a, b| b.added_at().cmp(a.added_at()));
    out
}

/// "Da scaricare": presenti su YouTube, non ancora scaricati, non archiviati.
pub fn to_download<'s>(state: &'s State) -> Vec<&'s Video> {
    videos(
        state,
        &Filter { presence: Some(presence::PRESENT), download: Some(download_state::NONE), hidden: Some(false), ..Default::default() },
    )
}

#[derive(Debug, Clone)]
pub struct AuthorView<'s> {
    pub author: &'s Author,
    pub total: usize,
    pub downloaded: usize,
    /// `addedAt` del video più recente: serve a ordinare gli autori per attività.
    pub latest_added_at: String,
}

/// Autori con i conteggi derivati. `only_with_downloads` serve al flusso "guarda":
/// non ha senso proporre un creator di cui non si possiede alcun file.
pub fn authors<'s>(state: &'s State, only_with_downloads: bool) -> Vec<AuthorView<'s>> {
    let mut out: Vec<AuthorView<'s>> = state
        .authors
        .values()
        .map(|author| {
            let mine: Vec<&Video> = state
                .videos
                .values()
                .filter(|v| v.author_key().as_deref() == Some(author.key()))
                .collect();
            AuthorView {
                total: mine.len(),
                downloaded: mine.iter().filter(|v| v.is_downloaded()).count(),
                latest_added_at: mine.iter().map(|v| v.added_at()).max().unwrap_or("").to_string(),
                author,
            }
        })
        .filter(|a| !only_with_downloads || a.downloaded > 0)
        .collect();

    // Ordine alfabetico sul nome mostrato: è come li cerca l'utente.
    out.sort_by(|a, b| {
        a.author
            .display_name()
            .to_lowercase()
            .cmp(&b.author.display_name().to_lowercase())
    });
    out
}

/// Conteggi per categoria, per le etichette dei menu. Un solo passaggio invece di
/// uno per filtro.
#[derive(Debug, Clone, Default)]
pub struct Counts {
    pub total: usize,
    pub available: usize,
    pub downloaded: usize,
    pub failed: usize,
    pub removed: usize,
    pub hidden: usize,
    pub downloading: usize,
    pub favorite: usize,
    pub bytes: u64,
}

pub fn counts(state: &State) -> Counts {
    let mut c = Counts { total: state.videos.len(), ..Default::default() };
    for v in state.videos.values() {
        match v.category() {
            VideoCategory::Available => c.available += 1,
            VideoCategory::Downloaded => c.downloaded += 1,
            VideoCategory::Failed => c.failed += 1,
            VideoCategory::Removed => c.removed += 1,
            VideoCategory::Hidden => c.hidden += 1,
            VideoCategory::Downloading => c.downloading += 1,
        }
        if v.favorite() {
            c.favorite += 1;
        }
        c.bytes += v.size_bytes().unwrap_or(0);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::schema::{new_video, NewVideo};
    use serde_json::json;

    fn state_with(videos: Vec<Video>) -> State {
        let mut s = State::default();
        for v in videos {
            s.upsert_author_from_video(&v);
            s.videos.insert(v.id().to_string(), v);
        }
        s
    }

    fn make(id: &str, added: &str, author: &str, tweak: impl Fn(&mut Video)) -> Video {
        let mut v = new_video(NewVideo {
            id, title: Some(id), channel_name: Some(author), channel_id: Some(author),
            duration_seconds: None, playlist_index: None, playlist_id: None,
            playlist_title: None, source_id: None, webpage_url: None,
            original_url: None, extractor: None,
        });
        v.set("addedAt", json!(added));
        tweak(&mut v);
        v
    }

    #[test]
    fn videos_come_out_newest_first() {
        let s = state_with(vec![
            make("a", "2026-01-01T00:00:00.000Z", "X", |_| {}),
            make("c", "2026-03-01T00:00:00.000Z", "X", |_| {}),
            make("b", "2026-02-01T00:00:00.000Z", "X", |_| {}),
        ]);
        let ids: Vec<_> = videos(&s, &Filter::new()).iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["c", "b", "a"]);
    }

    #[test]
    fn to_download_excludes_hidden_removed_and_downloaded() {
        let s = state_with(vec![
            make("ok", "2026-01-01T00:00:00.000Z", "X", |_| {}),
            make("giu", "2026-01-02T00:00:00.000Z", "X", |v| v.set("download", json!("downloaded"))),
            make("nas", "2026-01-03T00:00:00.000Z", "X", |v| v.set("hidden", json!(true))),
            make("rim", "2026-01-04T00:00:00.000Z", "X", |v| v.set("presence", json!("removed"))),
        ]);
        let ids: Vec<_> = to_download(&s).iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["ok"]);
    }

    #[test]
    fn authors_carry_counts_and_can_be_limited_to_those_with_files() {
        let s = state_with(vec![
            make("a", "2026-01-01T00:00:00.000Z", "Bravo", |v| v.set("download", json!("downloaded"))),
            make("b", "2026-01-02T00:00:00.000Z", "Bravo", |_| {}),
            make("c", "2026-01-03T00:00:00.000Z", "Alfa", |_| {}),
        ]);

        let all = authors(&s, false);
        let pairs: Vec<_> = all.iter().map(|a| (a.author.display_name(), a.total, a.downloaded)).collect();
        assert_eq!(pairs, vec![("Alfa".into(), 1, 0), ("Bravo".into(), 2, 1)]);

        let with_files = authors(&s, true);
        assert_eq!(with_files.len(), 1);
        assert_eq!(with_files[0].author.display_name(), "Bravo");
    }

    #[test]
    fn counts_cover_every_category_in_one_pass() {
        let s = state_with(vec![
            make("a", "2026-01-01T00:00:00.000Z", "X", |v| { v.set("download", json!("downloaded")); v.set("favorite", json!(true)); }),
            make("b", "2026-01-02T00:00:00.000Z", "X", |v| v.set("download", json!("failed"))),
            make("c", "2026-01-03T00:00:00.000Z", "X", |v| v.set("presence", json!("removed"))),
            make("d", "2026-01-04T00:00:00.000Z", "X", |v| v.set("hidden", json!(true))),
            make("e", "2026-01-05T00:00:00.000Z", "X", |_| {}),
        ]);
        let c = counts(&s);
        assert_eq!((c.total, c.downloaded, c.failed, c.removed, c.hidden, c.available, c.favorite), (5, 1, 1, 1, 1, 1, 1));
    }

    #[test]
    fn filtering_by_author_uses_the_same_key_as_the_authors_view() {
        let s = state_with(vec![
            make("a", "2026-01-01T00:00:00.000Z", "UC1", |_| {}),
            make("b", "2026-01-02T00:00:00.000Z", "UC2", |_| {}),
        ]);
        let ids: Vec<_> = videos(&s, &Filter::new().author("UC1")).iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["a"]);
    }
}
