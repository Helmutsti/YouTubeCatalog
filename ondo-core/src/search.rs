//! Ricerca: deliberatamente semplice e prevedibile.
//!
//! Semantica **AND**: ogni parola della query deve trovarsi da qualche parte,
//! altrimenti il video non è un risultato. Il punteggio dice solo *quanto vicino
//! al centro* è il campo che ha risposto (titolo prima di tutto, descrizione per
//! ultima). Niente tolleranza agli errori di battitura: era la parte che, su
//! descrizioni lunghe, restituiva risultati quasi casuali.

use crate::model::Video;

const TITLE: u32 = 8;
const AUTHOR: u32 = 5;
const TAG: u32 = 3;
const DESCRIPTION: u32 = 1;

/// Divide la query in parole confrontabili. Vuota = nessuna ricerca.
pub fn terms(query: &str) -> Vec<String> {
    query.split_whitespace().map(|w| w.to_lowercase()).filter(|w| !w.is_empty()).collect()
}

/// `None` se anche una sola parola non trova posto.
pub fn score(video: &Video, terms: &[String]) -> Option<u32> {
    if terms.is_empty() {
        return None;
    }
    let title = video.title.to_lowercase();
    let author = video.author.to_lowercase();
    let tags: Vec<String> = video.tags.iter().map(|t| t.to_lowercase()).collect();
    let description = video.description.to_lowercase();

    let mut total = 0;
    for term in terms {
        let mut best = 0;
        if title.contains(term) {
            best = best.max(TITLE);
        }
        if author.contains(term) {
            best = best.max(AUTHOR);
        }
        if tags.iter().any(|t| t.contains(term)) {
            best = best.max(TAG);
        }
        if description.contains(term) {
            best = best.max(DESCRIPTION);
        }
        if best == 0 {
            return None;
        }
        total += best;
    }
    // Un titolo che comincia con la query è quasi sempre quello cercato.
    if title.starts_with(&terms.join(" ")) {
        total += TITLE;
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(title: &str, author: &str, description: &str, tags: &[&str]) -> Video {
        Video {
            title: title.into(),
            author: author.into(),
            description: description.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            ..Video::default()
        }
    }

    #[test]
    fn every_word_must_land_somewhere() {
        let v = video("Come Study With Me", "Sampurna ASMR", "una sessione tranquilla", &["asmr"]);
        assert!(score(&v, &terms("study sampurna")).is_some(), "parole su campi diversi");
        assert!(score(&v, &terms("study bicicletta")).is_none(), "una parola fuori posto esclude");
        assert!(score(&v, &terms("")).is_none());
    }

    #[test]
    fn the_title_wins_over_the_description() {
        let on_title = video("grammatica", "x", "", &[]);
        let on_description = video("x", "y", "una lezione di grammatica", &[]);
        let t = terms("grammatica");
        assert!(score(&on_title, &t) > score(&on_description, &t));
    }

    #[test]
    fn case_and_accents_do_not_matter_for_case() {
        let v = video("Perché Sì", "Autore", "", &[]);
        assert!(score(&v, &terms("PERCHÉ")).is_some());
    }
}
