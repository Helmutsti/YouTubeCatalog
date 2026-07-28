//! `ondo` — menu a frecce per il catalogo video locale.
//! Porting di `packages/cli/cli.js`.
//!
//! Conserva le scelte di UX dell'originale, che sono decisioni di progetto e non
//! dettagli implementativi:
//!   - **navigazione con le frecce**, mai comandi digitati (l'unica eccezione è la
//!     ricerca, dove il testo libero è il punto);
//!   - una voce **"← Torna"** sempre in coda a ogni sottomenu: è così che si
//!     annulla, mai con un comando;
//!   - **reset dello schermo** a ogni menu, con un messaggio "in sospeso" che
//!     sopravvive esattamente a una schermata (senza, dopo pochi giri il
//!     terminale diventa illeggibile — problema reale risolto nel CLI JS).
//!
//! Come l'originale, è un adapter sottile: nessuna regola di stato vive qui,
//! tutto passa da `ondo_core`.

use std::io::Write;
use std::process::{Command, Stdio};

use console::{style, Term};
use dialoguer::theme::ColorfulTheme;
use dialoguer::{Input, Select};

use ondo_core::config::{check_tools, get_paths};
use ondo_core::schema::{download_state, Video, VideoCategory};
use ondo_core::{library, query, search, store};

// ── Schermata e messaggi in sospeso ─────────────────────────────────────────
//
// `pending` è una singola variabile globale, sicura perché il CLI è bloccante:
// c'è un solo flusso interattivo alla volta. Stessa scelta del JS.

struct Screen {
    term: Term,
    pending: Option<String>,
}

impl Screen {
    fn new() -> Self {
        Self { term: Term::stdout(), pending: None }
    }

    /// Pulisce il terminale e ristampa l'eventuale messaggio in sospeso.
    /// Il clear si applica solo su un TTY vero, per non rompere output rediretto.
    fn clear(&mut self) {
        if self.term.is_term() {
            let _ = self.term.clear_screen();
        }
        if let Some(msg) = self.pending.take() {
            println!("{msg}");
        }
    }

    fn set(&mut self, message: impl Into<String>) {
        self.pending = Some(message.into());
    }

    fn ok(&mut self, message: impl std::fmt::Display) {
        self.set(format!("\n{} {message}\n", style("✔").green()));
    }

    fn err(&mut self, message: impl std::fmt::Display) {
        self.set(format!("\n{} {message}\n", style("✘").red()));
    }
}

// ── Utilità di presentazione ────────────────────────────────────────────────

fn format_duration(seconds: Option<f64>) -> String {
    match seconds {
        Some(s) if s > 0.0 => {
            let total = s as u64;
            let (h, m, sec) = (total / 3600, (total % 3600) / 60, total % 60);
            if h > 0 {
                format!("{h}:{m:02}:{sec:02}")
            } else {
                format!("{m}:{sec:02}")
            }
        }
        _ => "--:--".to_string(),
    }
}

/// Riga di elenco di un video: icona di stato + titolo + canale + durata.
fn video_line(video: &Video) -> String {
    let cat = video.category();
    let icon = match cat {
        VideoCategory::Downloaded => style(cat.label()).green(),
        VideoCategory::Removed => style(cat.label()).red(),
        VideoCategory::Failed => style(cat.label()).yellow(),
        VideoCategory::Downloading => style(cat.label()).cyan(),
        VideoCategory::Hidden => style(cat.label()).dim(),
        VideoCategory::Available => style(cat.label()).dim(),
    };
    let star = if video.favorite() { "★ " } else { "" };
    format!(
        "{icon}  {star}{}  {}  [{}]",
        video.display_title(),
        style(video.channel_name().unwrap_or("—")).dim(),
        format_duration(video.duration_seconds())
    )
}

fn theme() -> ColorfulTheme {
    ColorfulTheme::default()
}

/// `Select` con "← Torna" già in coda. Ritorna `None` se si torna indietro
/// (voce scelta o ESC premuto).
fn select_with_back(prompt: &str, mut labels: Vec<String>) -> Option<usize> {
    let count = labels.len();
    labels.push("← Torna".to_string());
    let choice = Select::with_theme(&theme())
        .with_prompt(prompt)
        .items(&labels)
        .default(0)
        .interact_opt()
        .ok()
        .flatten()?;
    (choice < count).then_some(choice)
}

// ── Menu: Catalogo ──────────────────────────────────────────────────────────

/// I filtri corrispondono alle categorie derivate da `video_category()` nel core:
/// il CLI non reimplementa la regola, la consuma.
const FILTERS: [(&str, Option<VideoCategory>); 7] = [
    ("Tutti", None),
    ("Disponibili", Some(VideoCategory::Available)),
    ("Scaricati", Some(VideoCategory::Downloaded)),
    ("Falliti", Some(VideoCategory::Failed)),
    ("Rimossi da YouTube", Some(VideoCategory::Removed)),
    ("Archiviati (nascosti)", Some(VideoCategory::Hidden)),
    ("In download", Some(VideoCategory::Downloading)),
];

fn menu_catalog(screen: &mut Screen) {
    loop {
        screen.clear();

        let catalog = match store::read_catalog() {
            Ok(c) => c,
            Err(e) => {
                screen.err(e);
                return;
            }
        };
        let all = query::list_videos_in(&catalog, &query::VideoFilter::new());

        let labels: Vec<String> = FILTERS
            .iter()
            .map(|(name, cat)| {
                let n = match cat {
                    None => all.len(),
                    Some(c) => all.iter().filter(|v| v.category() == *c).count(),
                };
                format!("{name} ({n})")
            })
            .collect();

        let Some(choice) = select_with_back("Catalogo — quale gruppo?", labels) else {
            return;
        };

        let (_, wanted) = FILTERS[choice];
        let videos: Vec<Video> = match wanted {
            None => all,
            Some(c) => all.into_iter().filter(|v| v.category() == c).collect(),
        };
        browse_videos(screen, videos, FILTERS[choice].0);
    }
}

/// Elenco di video navigabile; selezionandone uno si apre il dettaglio.
fn browse_videos(screen: &mut Screen, videos: Vec<Video>, title: &str) {
    if videos.is_empty() {
        screen.set(format!("\nNessun video in «{title}».\n"));
        return;
    }
    loop {
        screen.clear();
        let labels: Vec<String> = videos.iter().map(video_line).collect();
        let prompt = format!("{title} — {} video", videos.len());
        let Some(index) = select_with_back(&prompt, labels) else {
            return;
        };
        // Si ricarica dal catalogo: il dettaglio può averne cambiato i flag.
        let id = videos[index].id().to_string();
        video_detail(screen, &id);
    }
}

// ── Dettaglio di un video ───────────────────────────────────────────────────

fn video_detail(screen: &mut Screen, id: &str) {
    loop {
        screen.clear();

        let video = match query::get_video(id) {
            Ok(v) => v,
            Err(e) => {
                screen.err(e);
                return;
            }
        };

        println!("{}", style(video.display_title()).bold().cyan());
        println!("  canale   {}", video.channel_name().unwrap_or("—"));
        println!("  durata   {}", format_duration(video.duration_seconds()));
        println!("  stato    {}", video.category().label());
        println!("  id       {}", video.id());
        if let Some(url) = video.webpage_url() {
            println!("  origine  {url}");
        }
        if let Some(local) = video.local_path() {
            println!("  file     {local}");
        }
        println!();

        let mut actions: Vec<(&str, &str)> = Vec::new();
        if video.is_downloaded() {
            actions.push(("play", "▶ Riproduci con VLC"));
        }
        actions.push(if video.favorite() {
            ("unfav", "☆ Togli dai preferiti")
        } else {
            ("fav", "★ Aggiungi ai preferiti")
        });
        actions.push(if video.hidden() {
            ("unhide", "◉ Ripristina dagli archiviati")
        } else {
            ("hide", "◌ Archivia (nascondi)")
        });

        let labels: Vec<String> = actions.iter().map(|(_, l)| l.to_string()).collect();
        let Some(choice) = select_with_back("Azione", labels) else {
            return;
        };

        match actions[choice].0 {
            "play" => match play_with_vlc(&video) {
                Ok(()) => screen.ok("VLC avviato."),
                Err(e) => screen.err(e),
            },
            "fav" => report(screen, query::set_video_favorite(id, true), "Aggiunto ai preferiti."),
            "unfav" => report(screen, query::set_video_favorite(id, false), "Rimosso dai preferiti."),
            "hide" => report(screen, query::set_video_hidden(id, true), "Archiviato."),
            "unhide" => report(screen, query::set_video_hidden(id, false), "Ripristinato."),
            _ => {}
        }
    }
}

fn report<T>(screen: &mut Screen, result: ondo_core::Result<T>, message: &str) {
    match result {
        Ok(_) => screen.ok(message),
        Err(e) => screen.err(e),
    }
}

// ── Riproduzione con VLC ────────────────────────────────────────────────────

/// VLC parte come processo **indipendente**: continua a girare anche chiudendo il
/// CLI (equivalente di `detached: true` + `unref()` nel JS).
fn play_with_vlc(video: &Video) -> ondo_core::Result<()> {
    let path = library::resolve_video_path(video)?;
    let paths = get_paths()?;

    if paths.vlc_path.is_empty() || !std::path::Path::new(&paths.vlc_path).is_file() {
        return Err(ondo_core::OndoError::not_found(format!(
            "VLC non trovato in {}. Imposta playback.vlcPath in data/config.json.",
            paths.vlc_path
        )));
    }

    Command::new(&paths.vlc_path)
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ondo_core::OndoError::new(ondo_core::ErrorKind::Io, format!("Avvio di VLC fallito: {e}")))?;
    Ok(())
}

// ── Menu: Cerca ─────────────────────────────────────────────────────────────

fn menu_search(screen: &mut Screen) {
    loop {
        screen.clear();
        println!("{}", style("Cerca — testo libero, invio per cercare (vuoto per tornare)").dim());

        let query: String = match Input::with_theme(&theme())
            .with_prompt("Cerca")
            .allow_empty(true)
            .interact_text()
        {
            Ok(q) => q,
            Err(_) => return,
        };
        if query.trim().is_empty() {
            return;
        }

        match search::search_videos(&query, Some(50)) {
            Ok(hits) if hits.is_empty() => screen.set(format!("\nNessun risultato per «{query}».\n")),
            Ok(hits) => browse_videos(screen, hits, &format!("Risultati per «{query}»")),
            Err(e) => screen.err(e),
        }
    }
}

// ── Menu: Guarda (canali → video) ───────────────────────────────────────────

fn menu_watch(screen: &mut Screen) {
    loop {
        screen.clear();

        let channels = match query::list_channels(Some(download_state::DOWNLOADED)) {
            Ok(c) => c,
            Err(e) => {
                screen.err(e);
                return;
            }
        };
        if channels.is_empty() {
            screen.set("\nNessun video scaricato: non c'è ancora niente da guardare.\n".to_string());
            return;
        }

        let labels: Vec<String> = channels
            .iter()
            .map(|c| format!("{}  {}", c.name.clone().unwrap_or_else(|| c.key.clone()), style(format!("({})", c.count)).dim()))
            .collect();

        let Some(index) = select_with_back("Guarda — quale creator?", labels) else {
            return;
        };

        let channel = &channels[index];
        match query::list_videos_by_channel(&channel.key, Some(download_state::DOWNLOADED)) {
            Ok(videos) => browse_videos(
                screen,
                videos,
                channel.name.as_deref().unwrap_or(&channel.key),
            ),
            Err(e) => screen.err(e),
        }
    }
}

// ── Menu: Stato dell'installazione ──────────────────────────────────────────

fn menu_status(screen: &mut Screen) {
    screen.clear();
    let paths = match get_paths() {
        Ok(p) => p,
        Err(e) => {
            screen.err(e);
            return;
        }
    };

    println!("{}", style("Stato dell'installazione").bold());
    println!("  progetto     {}", paths.project_root.display());
    println!("  catalogo     {}", paths.catalog_path.display());
    println!("  video        {}", paths.videos_dir.display());
    println!("  strumenti    {}", paths.tools_dir.display());
    println!(
        "  cookie       {}",
        paths.cookies_path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "assenti".into())
    );

    match check_tools() {
        Ok(status) if status.ok => {
            println!("\n  {} yt-dlp: {}", style("✔").green(), status.ytdlp_path.display());
            println!(
                "  {} ffmpeg: {}",
                style("✔").green(),
                status.ffmpeg_source.unwrap_or_default()
            );
        }
        Ok(status) => {
            println!("\n{}", style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow());
            for m in &status.messages {
                println!("  • {m}");
            }
            println!("\n  Rimedio: esegui  npm run setup");
        }
        Err(e) => println!("\n{} {e}", style("✘").red()),
    }

    println!("\n  core {}\n", ondo_core::VERSION);
    print!("Premi invio per tornare al menu… ");
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    let _ = std::io::stdin().read_line(&mut buf);
}

// ── Menu principale ─────────────────────────────────────────────────────────

fn main() {
    let mut screen = Screen::new();

    // Prerequisiti esterni (M64): come nel CLI JS, l'avviso passa da un messaggio
    // in sospeso e non da una stampa diretta, che il primo clear cancellerebbe.
    if let Ok(status) = check_tools() {
        if !status.ok {
            screen.set(format!(
                "\n{}\n\n{}\n\n  Rimedio: esegui  npm run setup\n",
                style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow(),
                status.messages.iter().map(|m| format!("  • {m}")).collect::<Vec<_>>().join("\n\n")
            ));
        }
    }

    let entries: [(&str, fn(&mut Screen)); 4] = [
        ("Catalogo", menu_catalog),
        ("Cerca", menu_search),
        ("Guarda", menu_watch),
        ("Stato installazione", menu_status),
    ];

    loop {
        screen.clear();
        let mut labels: Vec<String> = entries.iter().map(|(n, _)| n.to_string()).collect();
        labels.push("Esci".to_string());

        let choice = Select::with_theme(&theme())
            .with_prompt("Ondo — cosa vuoi fare?")
            .items(&labels)
            .default(0)
            .interact_opt();

        match choice {
            Ok(Some(i)) if i < entries.len() => entries[i].1(&mut screen),
            // "Esci", ESC, o Ctrl-C: si esce pulito, come il JS che stampa "Ciao!".
            _ => break,
        }
    }

    println!("Ciao!");
}

// I test di comportamento vivono in ondo-core; qui si verificano solo le
// funzioni di presentazione, che sono l'unica logica propria di questo adapter.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_are_formatted_like_the_js_cli() {
        assert_eq!(format_duration(None), "--:--");
        assert_eq!(format_duration(Some(0.0)), "--:--");
        assert_eq!(format_duration(Some(59.0)), "0:59");
        assert_eq!(format_duration(Some(212.0)), "3:32");
        assert_eq!(format_duration(Some(3600.0)), "1:00:00");
        assert_eq!(format_duration(Some(3725.0)), "1:02:05");
    }

    #[test]
    fn video_line_shows_state_and_favourite_marker() {
        let v = Video::from_value(serde_json::json!({
            "id": "abc", "title": "Titolo", "presence": "present",
            "download": "downloaded", "hidden": false, "favorite": true,
            "channel": { "name": "Creator" }, "durationSeconds": 212
        }))
        .unwrap();
        let line = console::strip_ansi_codes(&video_line(&v)).to_string();
        assert!(line.contains("scaricato"), "{line}");
        assert!(line.contains('★'), "{line}");
        assert!(line.contains("Titolo"));
        assert!(line.contains("Creator"));
        assert!(line.contains("3:32"));
    }
}
