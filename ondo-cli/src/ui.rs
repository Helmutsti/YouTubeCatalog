//! Le briciole comuni a tutti i menu: pulire lo schermo, un messaggio che
//! sopravvive a un ridisegno, e come si scrive una riga di video.

use console::{style, Term};
use dialoguer::{theme::ColorfulTheme, Select};
use ondo::{Quality, State, Video};

pub type R<T> = Result<T, Box<dyn std::error::Error>>;

/// I livelli offerti nelle impostazioni, «Chiedi ogni volta» compreso.
pub const LIVELLI: [Quality; 8] = [
    Quality::Best,
    Quality::Ask,
    Quality::Height(2160),
    Quality::Height(1440),
    Quality::Height(1080),
    Quality::Height(720),
    Quality::Height(480),
    Quality::Height(360),
];

/// Gli stessi livelli senza «Chiedi ogni volta»: qui la domanda è già stata fatta.
pub const PER_DOWNLOAD: [Quality; 7] = [
    Quality::Best,
    Quality::Height(2160),
    Quality::Height(1440),
    Quality::Height(1080),
    Quality::Height(720),
    Quality::Height(480),
    Quality::Height(360),
];

/// Chiede la risoluzione con un menu a frecce.
///
/// `Ok(None)` = l'utente ha annullato; `Ok(Some(tetto))` = scelto (`None` dentro =
/// la migliore disponibile).
pub fn ask_quality(prompt: &str) -> R<Option<Option<u32>>> {
    let voci: Vec<String> = PER_DOWNLOAD.iter().map(|q| q.label()).collect();
    println!("{}\n", style(prompt).dim());
    match Select::with_theme(&theme()).items(&voci).default(0).interact_opt()? {
        Some(i) => Ok(Some(PER_DOWNLOAD[i].max_height())),
        None => Ok(None),
    }
}

/// Il tetto da usare per un download che parte adesso: se la config dice «chiedi»,
/// si chiede; altrimenti si usa quello che dice. `None` esterno = annullato.
pub fn resolve_quality(quality: Quality, prompt: &str) -> R<Option<Option<u32>>> {
    if quality == Quality::Ask {
        ask_quality(prompt)
    } else {
        Ok(Some(quality.max_height()))
    }
}

pub fn theme() -> ColorfulTheme {
    ColorfulTheme::default()
}

/// Pulisce e ristampa l'intestazione, più l'eventuale messaggio in sospeso.
///
/// I menu vivono in cicli: senza questo, ogni versione precedente di un elenco
/// resta stampata sopra la nuova e dopo pochi giri lo schermo è illeggibile.
pub fn screen(title: &str, message: &mut Option<String>) {
    let term = Term::stdout();
    if term.is_term() {
        let _ = term.clear_screen();
    }
    println!("{}", style(format!("── {title} ")).bold().dim());
    if let Some(msg) = message.take() {
        println!("{msg}\n");
    }
}

/// Un messaggio che va letto: comparirà dopo il prossimo `screen`, e una volta sola.
pub fn ok(message: &mut Option<String>, text: impl std::fmt::Display) {
    *message = Some(format!("{} {text}", style("✓").green()));
}

pub fn err(message: &mut Option<String>, text: impl std::fmt::Display) {
    *message = Some(format!("{} {text}", style("✗").red()));
}

/// Il simbolo dello stato: si riconosce a colpo d'occhio in un elenco lungo.
pub fn glyph(v: &Video) -> String {
    let s = match v.state {
        State::Downloaded => style("●").green(),
        State::Downloading => style("↓").cyan(),
        State::Pending => style("○").yellow(),
        State::Failed => style("✗").red(),
    };
    let fav = if v.favorite { style(" ★").yellow().to_string() } else { String::new() };
    let arch = if v.archived { style(" ▤").dim().to_string() } else { String::new() };
    let rem = if v.removed { style(" ⚑").red().to_string() } else { String::new() };
    format!("{s}{fav}{arch}{rem}")
}

/// Una riga d'elenco: stato, durata, autore, titolo.
pub fn video_line(v: &Video) -> String {
    format!(
        "{} {:>7}  {:<22.22}  {}",
        glyph(v),
        v.duration_label(),
        v.author,
        v.title
    )
}

/// Come [`video_line`], ma con un'etichetta in coda: serve dove lo stato va detto
/// a parole e non basta il simbolo (per esempio «In download» fra gli in attesa).
pub fn video_line_tagged(v: &Video, tag: &str) -> String {
    format!("{}  {}", video_line(v), style(tag).cyan())
}

pub fn size_label(bytes: u64) -> String {
    let mb = bytes as f64 / 1_048_576.0;
    if mb >= 1024.0 {
        format!("{:.2} GB", mb / 1024.0)
    } else {
        format!("{mb:.1} MB")
    }
}

/// La barra di avanzamento del Download rapido.
pub fn bar(percent: f64, width: usize) -> String {
    let filled = ((percent.clamp(0.0, 100.0) / 100.0) * width as f64).round() as usize;
    format!("{}{}", "█".repeat(filled), "░".repeat(width.saturating_sub(filled)))
}

/// Il tetto scelto per un download, in breve: `1080p`, o niente se è la massima.
pub fn cap_label(max_height: Option<u32>) -> String {
    max_height.map(|h| format!("{h}p")).unwrap_or_default()
}
