//! Download rapido: l'unica schermata che prende il terminale in mano.
//!
//! Il prompt resta attivo mentre i download vanno, e le righe sopra si aggiornano
//! da sole. Perché funzioni servono due cose: leggere i tasti **con un timeout**
//! (`event::poll`, così fra un tasto e l'altro si può ridisegnare) e non lasciare
//! nessun thread bloccato sullo stdin — è così che una console del genere finisce
//! per mangiarsi i tasti del menu in cui si torna dopo.
//!
//! Questa schermata **non ha stato proprio**: a ogni ridisegno rilegge i sentinel
//! dal pool (`Downloader::statuses`). Uscire e rientrare quindi non perde niente,
//! perché non c'era niente da perdere.

use std::io::{self, Write};
use std::time::Duration;

use crossterm::event::{self, Event as CEvent, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{cursor, queue, terminal};
use ondo::{JobStatus, Phase, Quality};

use crate::ui::{self, R};
use crate::App;

/// Ripristina il terminale qualunque cosa accada: senza, un'uscita per errore
/// lascia il terminale in raw mode e la shell inutilizzabile.
struct RawMode;

impl RawMode {
    fn enter() -> io::Result<RawMode> {
        terminal::enable_raw_mode()?;
        Ok(RawMode)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

/// Cosa sta aspettando la schermata.
///
/// La scelta della risoluzione è disegnata da noi e non da `dialoguer`: qui il
/// terminale è in raw mode e i tasti li leggiamo noi, quindi un menu esterno che
/// vuole lo stdin per sé non può entrarci in mezzo.
enum Focus {
    /// Si scrive un link.
    Prompt,
    /// Si sceglie la risoluzione per il link appena incollato.
    Quality { url: String, sel: usize },
}

/// Come si scrive una riga: i cinque passi che l'utente vede.
fn label(s: &JobStatus) -> String {
    let chi = if s.title.is_empty() { s.url.clone() } else { format!("«{}»", s.title) };
    if let Some(e) = &s.error {
        return format!("✗  {chi} — {e}");
    }
    if s.done {
        return format!("✓  fatto, in libreria — {chi}");
    }
    match s.phase {
        None => format!("…  in coda — {chi}"),
        Some(Phase::Resolve) => format!("…  risolvendo {}", s.url),
        Some(Phase::Metadata) => format!("…  recupero metadati — {chi}"),
        Some(Phase::Video) => match s.percent {
            Some(p) => format!("{} {p:>5.1}%  {chi}", ui::bar(p, 24)),
            None => format!("…  scarico — {chi}"),
        },
    }
}

pub fn open(app: &mut App) -> R<()> {
    let mut input = String::new();
    let mut focus = Focus::Prompt;
    let mut stdout = io::stdout();

    let _raw = RawMode::enter()?;
    queue!(stdout, Clear(ClearType::All))?;

    loop {
        // Qui si pompa in continuazione: è la differenza fra questa schermata e un
        // menu, dove nessuno legge il canale mentre si aspetta un tasto. Serve a
        // tenere aggiornata la **libreria**; per disegnare si rileggono i sentinel.
        app.pump(|_| {});
        let rows = app.dl.statuses();
        draw(&mut stdout, app, &rows, &input, &focus)?;

        if !event::poll(Duration::from_millis(120))? {
            continue;
        }
        let CEvent::Key(key) = event::read()? else { continue };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c' | 'd')) {
            break;
        }

        match &mut focus {
            Focus::Prompt => match key.code {
                KeyCode::Esc => break,
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => input.clear(),
                KeyCode::Char(c) => input.push(c),
                KeyCode::Backspace => {
                    input.pop();
                }
                KeyCode::Enter => {
                    let url = input.trim().to_string();
                    input.clear();
                    if url.is_empty() {
                        continue;
                    }
                    if app.lib.config().quality == Quality::Ask {
                        // Il download è "lanciato", ma prima si decide con che
                        // risoluzione: è questa la scelta di «chiedi ogni volta».
                        focus = Focus::Quality { url, sel: 0 };
                    } else {
                        // Niente da aggiungere a mano: il job compare da sé al
                        // prossimo ridisegno, perché il pool sa già che esiste.
                        app.enqueue(&url);
                    }
                }
                _ => {}
            },
            Focus::Quality { url, sel } => match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    *sel = sel.checked_sub(1).unwrap_or(ui::PER_DOWNLOAD.len() - 1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    *sel = (*sel + 1) % ui::PER_DOWNLOAD.len();
                }
                KeyCode::Enter => {
                    let cap = ui::PER_DOWNLOAD[*sel].max_height();
                    let url = url.clone();
                    focus = Focus::Prompt;
                    app.enqueue_with(&url, cap);
                }
                // Annullare rimette il link nel prompt: si è già preso la briga di
                // incollarlo, non gli si fa ricominciare da capo.
                KeyCode::Esc => {
                    input = url.clone();
                    focus = Focus::Prompt;
                }
                _ => {}
            },
        }
    }

    queue!(stdout, Clear(ClearType::All), cursor::MoveTo(0, 0), cursor::Show)?;
    stdout.flush()?;
    Ok(())
}

fn draw(out: &mut io::Stdout, app: &App, rows: &[JobStatus], input: &str, focus: &Focus) -> R<()> {
    let (cols, altezza) = terminal::size().unwrap_or((100, 30));
    let cols = cols.max(40) as usize;
    let altezza = altezza.max(8);

    queue!(out, cursor::Hide, cursor::MoveTo(0, 0), Clear(ClearType::CurrentLine))?;
    write!(
        out,
        "── Download rapido · {} in corso, {} in coda\r\n",
        app.dl.in_flight(),
        app.dl.queued()
    )?;
    queue!(out, Clear(ClearType::CurrentLine))?;
    let aiuto = match focus {
        Focus::Prompt => "   Invio accoda · Esc torna al menu (i download continuano)",
        Focus::Quality { .. } => "   ↑↓ scegli · Invio conferma · Esc rimetti il link nel prompt",
    };
    write!(out, "{aiuto}\r\n")?;
    queue!(out, Clear(ClearType::CurrentLine))?;
    write!(out, "\r\n")?;

    // Le righe visibili sono le ultime: sono quelle che stanno succedendo. Quando
    // si sta scegliendo la risoluzione ne cedono lo spazio, invece di sparire.
    let prompt_y = altezza - 2;
    let alta_scelta: u16 = match focus {
        Focus::Prompt => 0,
        Focus::Quality { .. } => ui::PER_DOWNLOAD.len() as u16 + 1,
    };
    let fine_righe = prompt_y.saturating_sub(alta_scelta + 1);
    let spazio = (fine_righe as usize).saturating_sub(3);
    let da = rows.len().saturating_sub(spazio);
    for (i, row) in rows[da..].iter().enumerate() {
        queue!(out, cursor::MoveTo(0, 3 + i as u16), Clear(ClearType::CurrentLine))?;
        let cap = ui::cap_label(row.max_height);
        let cap = if cap.is_empty() { String::new() } else { format!(" [{cap}]") };
        let mut testo = format!("  {}{cap}", label(row));
        if testo.chars().count() > cols {
            testo = testo.chars().take(cols.saturating_sub(1)).collect();
        }
        write!(out, "{testo}")?;
    }
    queue!(out, cursor::MoveTo(0, 3 + (rows.len() - da) as u16), Clear(ClearType::FromCursorDown))?;

    if let Focus::Quality { url, sel } = focus {
        let y0 = prompt_y - alta_scelta;
        queue!(out, cursor::MoveTo(0, y0), Clear(ClearType::CurrentLine))?;
        let breve: String = url.chars().take(cols.saturating_sub(24)).collect();
        write!(out, "  Che risoluzione per {breve}?")?;
        for (i, q) in ui::PER_DOWNLOAD.iter().enumerate() {
            queue!(out, cursor::MoveTo(0, y0 + 1 + i as u16), Clear(ClearType::CurrentLine))?;
            let segno = if i == *sel { "❯" } else { " " };
            write!(out, "  {segno} {}", q.label())?;
        }
    }

    match focus {
        Focus::Prompt => {
            let prompt = "Incolla il link: ";
            queue!(out, cursor::MoveTo(0, prompt_y), Clear(ClearType::CurrentLine))?;
            write!(out, "{prompt}{input}")?;
            let x = (prompt.chars().count() + input.chars().count()).min(cols - 1) as u16;
            queue!(out, cursor::MoveTo(x, prompt_y), cursor::Show)?;
        }
        Focus::Quality { .. } => {
            queue!(out, cursor::MoveTo(0, prompt_y), Clear(ClearType::CurrentLine))?;
            write!(out, "  Invio per far partire il download")?;
        }
    }
    out.flush()?;
    Ok(())
}
