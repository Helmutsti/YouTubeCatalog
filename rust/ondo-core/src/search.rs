//! Ricerca fuzzy multi-campo — porting di `core/src/services/searchService.js`.
//!
//! Porting **fedele**, non "migliorato": i punteggi devono coincidere con quelli
//! dell'implementazione JS, altrimenti il test differenziale (docs/rust-core.md
//! §7) non può distinguere un bug di porting da un cambio voluto. L'ottimizzazione
//! algoritmica annotata in `PIANO.md` → "Forse" (indice n-gram, bail-out
//! anticipato) va fatta **dopo** che questo porting è verificato, non durante.
//!
//! ## Perché si lavora su UTF-16 e non su `char`
//!
//! JavaScript misura `String.length` e taglia `slice()` in **unità UTF-16**. Rust
//! ragiona in scalari Unicode (`char`) o byte UTF-8. Per un titolo ASCII le tre
//! cose coincidono; per un titolo con **emoji** no — un emoji è 1 `char`, 2 unità
//! UTF-16 e 4 byte UTF-8. Il catalogo reale ha emoji e accenti nei titoli e nei
//! nomi dei creator (è il rischio numero uno segnalato in docs/rust-core.md §8),
//! quindi le soglie di distanza e le finestre scorrevoli qui operano su
//! `Vec<u16>`: è l'unico modo di ottenere gli **stessi** punteggi del JS.
//!
//! Resta una differenza teorica: `toLowerCase()` in JS e `to_lowercase()` in Rust
//! implementano entrambi il case-folding Unicode ma con tabelle di versioni
//! diverse. Nessun effetto atteso sul corpus reale (latino + emoji).

use serde_json::Value;

use crate::error::Result;
use crate::schema::Video;
use crate::store::{read_catalog, videos_of};

/// Campi cercati fuzzy (tollerano piccoli errori di battitura): restano brevi e
/// specifici, quindi la corrispondenza a finestra scorrevole è economica e
/// significativa.
const FUZZY_FIELDS: [(Field, i64); 3] =
    [(Field::Title, 4), (Field::Channel, 3), (Field::Tags, 2)];

/// La descrizione, spesso lunga centinaia/migliaia di caratteri, è cercata solo
/// per **sottostringa esatta**: una ricerca fuzzy su un testo così lungo
/// troverebbe corrispondenze "sparse" quasi ovunque, senza reale senso. (Fu un
/// bug vero, trovato in fase di test in M7: una query di 2 parole tornava 20
/// risultati quasi casuali.)
const EXACT_ONLY_FIELDS: [(Field, i64); 1] = [(Field::Description, 1)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Title,
    Channel,
    Tags,
    Description,
}

fn field_text(video: &Video, field: Field) -> String {
    match field {
        Field::Title => video.title().unwrap_or("").to_string(),
        Field::Channel => video.channel_name().unwrap_or("").to_string(),
        Field::Tags => video.tags().join(" "),
        Field::Description => video.description().unwrap_or("").to_string(),
    }
}

fn to_utf16_lower(s: &str) -> Vec<u16> {
    s.to_lowercase().encode_utf16().collect()
}

/// Distanza di Levenshtein classica, iterativa a due righe invece di una matrice
/// completa: sufficiente per stringhe corte come titoli/tag, nessuna dipendenza.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let (m, n) = (a.len(), b.len());
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];

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
fn max_edit_distance_for(word_len: usize) -> usize {
    if word_len <= 3 {
        0
    } else if word_len <= 6 {
        1
    } else {
        2
    }
}

fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Cerca la miglior corrispondenza scorrendo finestre di testo di lunghezza
/// vicina a quella della parola, invece di una sottosequenza libera su tutto il
/// testo — più corretto semanticamente ("vicino per distanza di modifica a un
/// tratto di testo", non "lettere sparse ovunque in ordine").
fn fuzzy_word_score(word: &[u16], text: &[u16]) -> i64 {
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
                let dist = edit_distance(word, &text[start..start + len]);
                if dist < best {
                    best = dist;
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

fn exact_word_score(word: &[u16], text: &[u16]) -> i64 {
    if contains(text, word) {
        word.len() as i64
    } else {
        0
    }
}

/// Punteggio di un singolo video per una query già tokenizzata. Semantica **AND**:
/// ogni parola deve trovare corrispondenza da qualche parte, altrimenti il video
/// non è un risultato.
fn score_video(video: &Video, words: &[Vec<u16>]) -> i64 {
    // I testi dei campi si calcolano una volta per video, non una per parola.
    let fuzzy: Vec<(Vec<u16>, i64)> = FUZZY_FIELDS
        .iter()
        .map(|&(f, w)| (to_utf16_lower(&field_text(video, f)), w))
        .collect();
    let exact: Vec<(Vec<u16>, i64)> = EXACT_ONLY_FIELDS
        .iter()
        .map(|&(f, w)| (to_utf16_lower(&field_text(video, f)), w))
        .collect();

    let mut total = 0i64;
    for word in words {
        let mut best_for_word = 0i64;
        for (text, weight) in &fuzzy {
            let score = fuzzy_word_score(word, text) * weight;
            if score > best_for_word {
                best_for_word = score;
            }
        }
        for (text, weight) in &exact {
            let score = exact_word_score(word, text) * weight;
            if score > best_for_word {
                best_for_word = score;
            }
        }
        if best_for_word == 0 {
            return 0; // questa parola non matcha in nessun campo
        }
        total += best_for_word;
    }
    total
}

pub const DEFAULT_LIMIT: usize = 20;

/// Ricerca su tutto il catalogo, qualunque stato del video — un solo posto per
/// trovare qualsiasi video, non solo quelli scaricati.
pub fn search_videos(query: &str, limit: Option<usize>) -> Result<Vec<Video>> {
    let catalog = read_catalog()?;
    Ok(search_in(&catalog, query, limit))
}

/// Variante che opera su un catalogo già in memoria: la usa il test differenziale
/// (e permette di cercare senza rileggere il file a ogni tasto premuto nel CLI).
pub fn search_in(catalog: &Value, query: &str, limit: Option<usize>) -> Vec<Video> {
    let words: Vec<Vec<u16>> = query
        .to_lowercase()
        .split_whitespace()
        .map(|w| w.encode_utf16().collect())
        .collect();
    if words.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(Video, i64)> = videos_of(catalog)
        .into_iter()
        .filter_map(|v| {
            let score = score_video(&v, &words);
            (score > 0).then_some((v, score))
        })
        .collect();

    // `sort_by` è stabile, come `Array.prototype.sort` da ES2019: a pari
    // punteggio l'ordine resta quello di inserimento nel catalogo, identico al JS.
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored
        .into_iter()
        .take(limit.unwrap_or(DEFAULT_LIMIT))
        .map(|(v, _)| v)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog_with(videos: Vec<Value>) -> Value {
        let mut map = serde_json::Map::new();
        for v in videos {
            map.insert(v["id"].as_str().unwrap().to_string(), v);
        }
        json!({ "version": 1, "videos": Value::Object(map), "sources": {}, "meta": {} })
    }

    #[test]
    fn edit_distance_basics() {
        let d = |a: &str, b: &str| {
            edit_distance(&a.encode_utf16().collect::<Vec<_>>(), &b.encode_utf16().collect::<Vec<_>>())
        };
        assert_eq!(d("", ""), 0);
        assert_eq!(d("abc", "abc"), 0);
        assert_eq!(d("abc", "abd"), 1);
        assert_eq!(d("kitten", "sitting"), 3);
        assert_eq!(d("", "abc"), 3);
    }

    #[test]
    fn exact_substring_scores_three_times_the_length() {
        let w: Vec<u16> = "asmr".encode_utf16().collect();
        let t: Vec<u16> = "relaxing asmr sounds".encode_utf16().collect();
        assert_eq!(fuzzy_word_score(&w, &t), 12); // 4 * 3
    }

    #[test]
    fn short_words_do_not_tolerate_typos() {
        // maxDist = 0 per parole <= 3 caratteri: "abc" non deve trovare "abd".
        let w: Vec<u16> = "abc".encode_utf16().collect();
        let t: Vec<u16> = "abd".encode_utf16().collect();
        assert_eq!(fuzzy_word_score(&w, &t), 0);
    }

    #[test]
    fn typo_in_a_long_word_is_tolerated() {
        // "sampuma" (7 caratteri, maxDist 2) deve trovare "sampurna".
        let w: Vec<u16> = "sampuma".encode_utf16().collect();
        let t: Vec<u16> = "sampurna asmr".encode_utf16().collect();
        assert!(fuzzy_word_score(&w, &t) > 0);
    }

    #[test]
    fn and_semantics_across_words() {
        let cat = catalog_with(vec![
            json!({"id":"a","title":"asmr sleep triggers","channel":{"name":"X"},"tags":[],"description":""}),
            json!({"id":"b","title":"asmr only","channel":{"name":"X"},"tags":[],"description":""}),
        ]);
        let hits = search_in(&cat, "asmr sleep", None);
        let ids: Vec<_> = hits.iter().map(|v| v.id().to_string()).collect();
        assert_eq!(ids, vec!["a"], "'b' non contiene 'sleep': la semantica AND lo esclude");
    }

    #[test]
    fn description_is_exact_only_not_fuzzy() {
        // Il bug reale corretto in M7: una descrizione lunga non deve matchare
        // per sottosequenza sparsa.
        let cat = catalog_with(vec![json!({
            "id":"a","title":"niente","channel":{"name":"niente"},"tags":[],
            "description":"questa e una descrizione lunga con molte parole dentro"
        })]);
        assert_eq!(search_in(&cat, "descrizione", None).len(), 1, "sottostringa esatta: trovata");
        assert_eq!(search_in(&cat, "dscrizione", None).len(), 0, "typo nella descrizione: NON trovata");
    }

    #[test]
    fn empty_query_returns_nothing() {
        let cat = catalog_with(vec![json!({"id":"a","title":"asmr"})]);
        assert!(search_in(&cat, "", None).is_empty());
        assert!(search_in(&cat, "   ", None).is_empty());
    }

    #[test]
    fn emoji_titles_do_not_break_the_windowing() {
        // Il rischio Unicode di docs/rust-core.md §8, in forma di test: un titolo
        // con emoji (coppie surrogate in UTF-16) non deve né panicare né impedire
        // il match del testo circostante.
        let cat = catalog_with(vec![json!({
            "id":"a","title":"🎧 relaxing asmr 💤 sleep","channel":{"name":"Créatôr ASMR"},
            "tags":[],"description":""
        })]);
        assert_eq!(search_in(&cat, "relaxing", None).len(), 1);
        assert_eq!(search_in(&cat, "creatôr", None).len(), 1);
    }

    #[test]
    fn limit_is_respected() {
        let videos: Vec<Value> = (0..30)
            .map(|i| json!({"id": format!("v{i}"), "title": "asmr", "channel":{"name":""},"tags":[],"description":""}))
            .collect();
        let cat = catalog_with(videos);
        assert_eq!(search_in(&cat, "asmr", None).len(), DEFAULT_LIMIT);
        assert_eq!(search_in(&cat, "asmr", Some(5)).len(), 5);
    }
}
