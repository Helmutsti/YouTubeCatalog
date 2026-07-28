//! Ricerca fuzzy multi-campo su titolo, canale, tag e descrizione.
//!
//! ## Perché su UTF-16 e non su `char`
//!
//! Porting fedele dell'algoritmo JavaScript, e per restare fedele bisogna misurare
//! nella stessa unità: JS conta `String.length` e taglia `slice()` in **unità
//! UTF-16**. Per un titolo ASCII coincide con tutto; per un titolo con **emoji** no
//! — un emoji è 1 `char`, 2 unità UTF-16, 4 byte UTF-8. Il catalogo reale ha emoji e
//! accenti nei titoli e nei nomi dei creator, quindi soglie e finestre scorrevoli
//! lavorano su `Vec<u16>`: è l'unico modo di ottenere gli stessi punteggi.
//!
//! ## Perché la descrizione è cercata solo per sottostringa esatta
//!
//! Bug reale: con una ricerca fuzzy su testi di migliaia di caratteri quasi ogni
//! parola breve trova una corrispondenza sparsa priva di senso — una query di due
//! parole restituiva venti risultati quasi casuali. La tolleranza agli errori di
//! battitura resta sui campi **brevi**, dove è economica e semanticamente sensata.

use super::schema::Video;
use super::state::State;

const W_TITLE: i64 = 4;
const W_CHANNEL: i64 = 3;
const W_TAGS: i64 = 2;
const W_DESCRIPTION: i64 = 1;

pub const DEFAULT_LIMIT: usize = 20;

fn utf16_lower(s: &str) -> Vec<u16> {
    s.to_lowercase().encode_utf16().collect()
}

/// Levenshtein classica, iterativa a due righe invece di una matrice completa:
/// sufficiente per stringhe corte come titoli e tag.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let (m, n) = (a.len(), b.len());
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

/// Parole molto corte: solo corrispondenza esatta, altrimenti troppo rumore.
fn max_edit_distance_for(len: usize) -> usize {
    if len <= 3 {
        0
    } else if len <= 6 {
        1
    } else {
        2
    }
}

fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    if needle.is_empty() {
        return true;
    }
    needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Miglior corrispondenza scorrendo finestre di lunghezza vicina a quella della
/// parola — "vicino per distanza di modifica a un tratto di testo", non "lettere
/// sparse ovunque in ordine".
fn fuzzy_score(word: &[u16], text: &[u16]) -> i64 {
    if word.is_empty() || text.is_empty() {
        return 0;
    }
    if contains(text, word) {
        return word.len() as i64 * 3;
    }
    let max_dist = max_edit_distance_for(word.len());
    if max_dist == 0 {
        return 0;
    }

    let mut best = usize::MAX;
    let min_len = 1.max(word.len().saturating_sub(max_dist));
    let max_len = word.len() + max_dist;

    let mut len = min_len;
    while len <= max_len && best > 0 {
        if len <= text.len() {
            for start in 0..=(text.len() - len) {
                let d = edit_distance(word, &text[start..start + len]);
                if d < best {
                    best = d;
                }
                if best == 0 {
                    break;
                }
            }
        }
        len += 1;
    }

    if best <= max_dist {
        (word.len() - best) as i64 * 2
    } else {
        0
    }
}

fn exact_score(word: &[u16], text: &[u16]) -> i64 {
    if contains(text, word) {
        word.len() as i64
    } else {
        0
    }
}

/// Semantica **AND**: ogni parola deve trovare corrispondenza da qualche parte,
/// altrimenti il video non è un risultato.
fn score(video: &Video, words: &[Vec<u16>]) -> i64 {
    let fuzzy = [
        (utf16_lower(video.title().unwrap_or("")), W_TITLE),
        (utf16_lower(video.channel_name().unwrap_or("")), W_CHANNEL),
        (utf16_lower(&video.tags().join(" ")), W_TAGS),
    ];
    let description = utf16_lower(video.description().unwrap_or(""));

    let mut total = 0;
    for word in words {
        let mut best = 0;
        for (text, weight) in &fuzzy {
            best = best.max(fuzzy_score(word, text) * weight);
        }
        best = best.max(exact_score(word, &description) * W_DESCRIPTION);
        if best == 0 {
            return 0;
        }
        total += best;
    }
    total
}

/// Cerca su **tutto** lo stato, qualunque categoria: un solo posto per trovare un
/// video, non solo quelli scaricati.
pub fn search<'s>(state: &'s State, query: &str, limit: Option<usize>) -> Vec<&'s Video> {
    let words: Vec<Vec<u16>> = query
        .to_lowercase()
        .split_whitespace()
        .map(|w| w.encode_utf16().collect())
        .collect();
    if words.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(&Video, i64)> = state
        .videos
        .values()
        .filter_map(|v| {
            let s = score(v, &words);
            (s > 0).then_some((v, s))
        })
        .collect();

    // Stabile: a pari punteggio l'ordine resta quello delle chiavi, quindi
    // deterministico fra esecuzioni.
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.into_iter().take(limit.unwrap_or(DEFAULT_LIMIT)).map(|(v, _)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::schema::Video;
    use serde_json::json;

    fn state_with(videos: Vec<serde_json::Value>) -> State {
        let mut s = State::default();
        for v in videos {
            let video = Video::from_value(v).unwrap();
            s.videos.insert(video.id().to_string(), video);
        }
        s
    }

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn edit_distance_basics() {
        assert_eq!(edit_distance(&u(""), &u("")), 0);
        assert_eq!(edit_distance(&u("abc"), &u("abc")), 0);
        assert_eq!(edit_distance(&u("abc"), &u("abd")), 1);
        assert_eq!(edit_distance(&u("kitten"), &u("sitting")), 3);
    }

    #[test]
    fn exact_substring_scores_three_times_the_length() {
        assert_eq!(fuzzy_score(&u("asmr"), &u("relaxing asmr sounds")), 12);
    }

    #[test]
    fn short_words_do_not_tolerate_typos_long_ones_do() {
        assert_eq!(fuzzy_score(&u("abc"), &u("abd")), 0, "≤3 caratteri: solo esatto");
        assert!(fuzzy_score(&u("sampuma"), &u("sampurna asmr")) > 0, "typo su parola lunga: tollerato");
    }

    #[test]
    fn and_semantics_across_words() {
        let s = state_with(vec![
            json!({"id":"a","title":"asmr sleep triggers","channel":{"name":"X"},"tags":[],"description":""}),
            json!({"id":"b","title":"asmr only","channel":{"name":"X"},"tags":[],"description":""}),
        ]);
        let ids: Vec<_> = search(&s, "asmr sleep", None).iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[test]
    fn description_matches_only_exactly() {
        let s = state_with(vec![json!({
            "id":"a","title":"niente","channel":{"name":"niente"},"tags":[],
            "description":"questa e una descrizione lunga con molte parole dentro"
        })]);
        assert_eq!(search(&s, "descrizione", None).len(), 1);
        assert_eq!(search(&s, "dscrizione", None).len(), 0, "nessun fuzzy sulla descrizione");
    }

    #[test]
    fn emoji_and_accents_do_not_break_anything() {
        let s = state_with(vec![json!({
            "id":"a","title":"🎧 relaxing asmr 💤 sleep","channel":{"name":"Créatôr ASMR"},
            "tags":[],"description":""
        })]);
        assert_eq!(search(&s, "relaxing", None).len(), 1);
        assert_eq!(search(&s, "creatôr", None).len(), 1);
    }

    #[test]
    fn empty_query_returns_nothing_and_limit_is_respected() {
        let videos: Vec<_> = (0..30)
            .map(|i| json!({"id": format!("v{i}"), "title": "asmr", "channel":{"name":""},"tags":[],"description":""}))
            .collect();
        let s = state_with(videos);
        assert!(search(&s, "   ", None).is_empty());
        assert_eq!(search(&s, "asmr", None).len(), DEFAULT_LIMIT);
        assert_eq!(search(&s, "asmr", Some(5)).len(), 5);
    }
}
