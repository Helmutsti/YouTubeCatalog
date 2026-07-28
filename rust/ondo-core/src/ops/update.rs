//! Aggiornamento completo della libreria: **un comando invece di tre**.
//!
//! ## Perché l'ordine non è arbitrario
//!
//! ```text
//! 1. sync      interroga le sorgenti     → scopre i video nuovi (stub leggeri)
//!                                          e marca quelli spariti da YouTube
//! 2. enrich    metadati + copertine      → e QUI arriva l'URL vero del canale
//! 3. avatar    foto dei creator          → che senza il passo 2 non sarebbe interrogabile
//! ```
//!
//! Ogni passo abilita il successivo. Facendoli a mano in ordine sbagliato — cosa
//! possibile finché erano tre voci di menu separate — si ottiene meno di quel che si
//! potrebbe: gli avatar dei creator appena comparsi restano indietro di un giro.
//!
//! Il passo 3 non compare qui perché è già dentro `enrich`, dove l'informazione che
//! gli serve è appena stata recuperata.
//!
//! ## Dove si ferma
//!
//! **Non scarica.** Alla fine dice quanti video sono pronti da scaricare e lascia
//! decidere: un aggiornamento deve essere veloce e prevedibile, mentre scaricare può
//! voler dire ore e decine di GB che nessuno ha chiesto in quel momento.

use serde_json::json;

use crate::downloader::Reporter;
use crate::error::Result;
use crate::library::{query, state};
use crate::ops::{download, runs, sync};
use crate::time::now_iso8601;

#[derive(Debug, Clone, Default)]
pub struct UpdateReport {
    pub sync: sync::SyncReport,
    pub enrich: download::EnrichReport,
    /// Quanti video risultano pronti da scaricare **dopo** l'aggiornamento.
    pub pending: usize,
    pub seconds: u64,
}

impl UpdateReport {
    /// Riepilogo in una riga sola, per il messaggio finale.
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        if self.sync.new_count > 0 {
            parts.push(format!("{} nuovi", self.sync.new_count));
        }
        if self.sync.removed_count > 0 {
            parts.push(format!("{} rimossi da YouTube", self.sync.removed_count));
        }
        if self.sync.restored_count > 0 {
            parts.push(format!("{} tornati disponibili", self.sync.restored_count));
        }
        if self.sync.reclaimed_count > 0 {
            parts.push(format!("{} file ritrovati su disco", self.sync.reclaimed_count));
        }
        if self.sync.healed_count > 0 {
            parts.push(format!("{} da ri-scaricare", self.sync.healed_count));
        }
        if self.enrich.enriched > 0 {
            parts.push(format!("{} schede completate", self.enrich.enriched));
        }
        if self.enrich.avatars.saved > 0 {
            parts.push(format!("{} foto creator", self.enrich.avatars.saved));
        }
        if parts.is_empty() {
            "Nessuna novità.".to_string()
        } else {
            parts.join(", ")
        }
    }

    /// Cose che vale la pena mettere davanti agli occhi dell'utente, non sepolte fra
    /// i conteggi.
    pub fn warnings(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.sync.healing_skipped {
            out.push(
                "La cartella dei video risulta vuota o irraggiungibile: il controllo dei file \
                 è stato SALTATO per non azzerare lo stato. Verifica che il disco sia collegato."
                    .to_string(),
            );
        }
        let missing = self.sync.missing_count();
        if missing > 0 {
            out.push(format!(
                "{missing} video dichiarati da YouTube non erano visibili in questa estrazione \
                 (privati, o rimossi di recente)."
            ));
        }
        if self.enrich.failed > 0 {
            out.push(format!(
                "{} schede non completate: riprova più tardi, spesso è temporaneo.",
                self.enrich.failed
            ));
        }
        for e in &self.sync.errors {
            out.push(format!("Sorgente non sincronizzata — {e}"));
        }
        out
    }
}

/// Sincronizza le sorgenti, completa le schede mancanti e recupera le foto dei
/// creator. Non scarica alcun video.
pub fn update_library(reporter: &dyn Reporter) -> Result<UpdateReport> {
    let started_at = now_iso8601();
    let clock = std::time::Instant::now();
    let mut report = UpdateReport::default();

    let sources = state::read()?.sources.len();
    if sources == 0 {
        reporter.log("Nessuna sorgente configurata: niente da sincronizzare.");
    } else {
        reporter.log(&format!("① Sincronizzo {sources} sorgenti…"));
        report.sync = sync::sync_all()?;
        reporter.log(&format!(
            "   {} nuovi, {} rimossi, {} ripristinati.",
            report.sync.new_count, report.sync.removed_count, report.sync.restored_count
        ));
    }

    if reporter.cancelled() {
        reporter.log("Interrotto dall'utente.");
        return Ok(report);
    }

    // Il passo 2 vale anche senza sorgenti: possono esserci schede incomplete arrivate
    // da download rapidi, o rimaste indietro da un arricchimento interrotto.
    reporter.log("② Completo le schede (metadati e copertine)…");
    report.enrich = download::enrich(None, reporter)?;

    let st = state::read()?;
    report.pending = query::to_download(&st).len();
    report.seconds = clock.elapsed().as_secs();

    runs::record(
        "update",
        json!({}),
        report.sync.errors.is_empty(),
        json!({
            "new": report.sync.new_count,
            "removed": report.sync.removed_count,
            "restored": report.sync.restored_count,
            "enriched": report.enrich.enriched,
            "avatars": report.enrich.avatars.saved,
            "pending": report.pending
        }),
        &started_at,
        None,
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_stays_quiet_when_there_is_nothing_to_say() {
        assert_eq!(UpdateReport::default().summary(), "Nessuna novità.");
    }

    #[test]
    fn the_summary_only_mentions_what_actually_happened() {
        let mut r = UpdateReport::default();
        r.sync.new_count = 3;
        r.enrich.enriched = 3;
        let s = r.summary();
        assert!(s.contains("3 nuovi") && s.contains("3 schede completate"));
        assert!(!s.contains("rimossi"), "non si elencano gli zeri: {s}");
    }

    #[test]
    fn a_disconnected_disk_is_a_warning_not_a_number_buried_in_the_summary() {
        // È il caso che ha già distrutto lo stato una volta: deve saltare all'occhio.
        let mut r = UpdateReport::default();
        r.sync.healing_skipped = true;
        let w = r.warnings();
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("disco"), "{}", w[0]);
    }

    #[test]
    fn coverage_and_failures_become_warnings() {
        let mut r = UpdateReport::default();
        r.sync.declared_count = Some(100);
        r.sync.enumerated_count = 96;
        r.enrich.failed = 2;
        r.sync.errors.push("PL1: rete assente".into());
        let w = r.warnings();
        assert_eq!(w.len(), 3);
        assert!(w.iter().any(|x| x.contains('4')), "4 video non visibili: {w:?}");
    }
}
