//! `ondo` — menu a frecce per il catalogo video locale.
//! Porting di `packages/cli/cli.js`.
//!
//! Conserva le scelte di UX dell'originale, che sono decisioni di progetto e non
//! dettagli implementativi:
//!   - **navigazione con le frecce**, mai comandi digitati (le uniche eccezioni
//!     sono ricerca e incolla-link, dove il testo libero è il punto);
//!   - una voce **"← Torna"** sempre in coda a ogni sottomenu: è così che si
//!     annulla, mai con un comando;
//!   - **reset dello schermo** a ogni menu, con un messaggio "in sospeso" che
//!     sopravvive esattamente a una schermata (senza, dopo pochi giri il
//!     terminale diventa illeggibile — problema reale risolto nel CLI JS).
//!
//! Come l'originale è un adapter sottile: nessuna regola di stato vive qui.
//!
//! ## Interruzione di un download
//!
//! Il JS aveva una "X" che abortiva un job in background. Qui le operazioni girano
//! in primo piano (vedi `ondo_core::tasks`), quindi l'interruzione è **Ctrl-C**:
//! la console la recapita all'intero gruppo di processi, yt-dlp compreso. Chiude
//! anche il CLI — comportamento semplice e prevedibile, al posto di un abort
//! parziale. Il catalogo non resta incoerente: un video interrotto risulta
//! `downloading` e la reconciliation all'avvio successivo lo riporta a `none`.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use console::{style, Term};
use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, Select};

use ondo_core::config::{check_tools, get_paths};
use ondo_core::schema::{download_state, Video, VideoCategory};
use ondo_core::ytdlp::{AudioStrategy, Reporter};
use ondo_core::{library, metadata, query, search, sources, store, sync, tasks};

// ── Schermata e messaggi in sospeso ─────────────────────────────────────────

struct Screen {
    term: Term,
    pending: Option<String>,
}

impl Screen {
    fn new() -> Self {
        Self { term: Term::stdout(), pending: None }
    }

    /// Pulisce il terminale e ristampa l'eventuale messaggio in sospeso. Il clear
    /// si applica solo su un TTY vero, per non rompere l'output rediretto.
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

    fn report<T>(&mut self, result: ondo_core::Result<T>, message: &str) {
        match result {
            Ok(_) => self.ok(message),
            Err(e) => self.err(e),
        }
    }
}

// ── Reporter da terminale ───────────────────────────────────────────────────

/// Sostituisce l'infrastruttura `EventEmitter` → SSE → `useJobStream` del modello
/// con la web GUI: qui chi lancia l'operazione è lo stesso processo che la mostra,
/// quindi log e avanzamento vanno direttamente a schermo.
struct TerminalReporter {
    /// Ultima percentuale disegnata: si ridisegna la barra solo quando cambia di
    /// almeno un punto, altrimenti yt-dlp la aggiornerebbe centinaia di volte.
    last_drawn: Mutex<i64>,
    quiet: bool,
}

impl TerminalReporter {
    fn new(quiet: bool) -> Self {
        Self { last_drawn: Mutex::new(-1), quiet }
    }

    fn finish(&self) {
        if *self.last_drawn.lock().unwrap() >= 0 {
            println!();
            *self.last_drawn.lock().unwrap() = -1;
        }
    }
}

impl Reporter for TerminalReporter {
    fn log(&self, line: &str) {
        // Le righe di avanzamento di yt-dlp sono già rese dalla barra: ristamparle
        // produrrebbe centinaia di righe identiche.
        if line.starts_with("[download]") && line.contains('%') {
            return;
        }
        if self.quiet && !(line.starts_with('✔') || line.starts_with('✘') || line.starts_with('⊘') || line.starts_with("---")) {
            return;
        }
        self.finish();
        println!("  {}", style(line).dim());
    }

    fn progress(&self, percent: f64) {
        let pct = percent.round() as i64;
        let mut last = self.last_drawn.lock().unwrap();
        if *last == pct {
            return;
        }
        *last = pct;
        let filled = (pct.clamp(0, 100) as usize) * 30 / 100;
        let bar: String = "█".repeat(filled) + &"░".repeat(30 - filled);
        print!("\r  {} {pct:>3}%", style(bar).cyan());
        let _ = std::io::stdout().flush();
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

fn format_size(bytes: Option<u64>) -> String {
    match bytes {
        Some(b) if b > 0 => {
            let gb = b as f64 / 1_073_741_824.0;
            if gb >= 1.0 {
                format!("{gb:.1} GB")
            } else {
                format!("{:.0} MB", b as f64 / 1_048_576.0)
            }
        }
        _ => "—".to_string(),
    }
}

fn video_line(video: &Video) -> String {
    let cat = video.category();
    let icon = match cat {
        VideoCategory::Downloaded => style(cat.label()).green(),
        VideoCategory::Removed => style(cat.label()).red(),
        VideoCategory::Failed => style(cat.label()).yellow(),
        VideoCategory::Downloading => style(cat.label()).cyan(),
        VideoCategory::Hidden | VideoCategory::Available => style(cat.label()).dim(),
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

/// `Select` con "← Torna" già in coda. `None` = si torna indietro (voce scelta o
/// ESC premuto).
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

fn ask_text(prompt: &str) -> Option<String> {
    let value: String = Input::with_theme(&theme())
        .with_prompt(prompt)
        .allow_empty(true)
        .interact_text()
        .ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn confirm(prompt: &str, default: bool) -> bool {
    Confirm::with_theme(&theme())
        .with_prompt(prompt)
        .default(default)
        .interact_opt()
        .ok()
        .flatten()
        .unwrap_or(false)
}

fn pause() {
    print!("\nPremi invio per continuare… ");
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    let _ = std::io::stdin().read_line(&mut buf);
}

// ── Scelta della risoluzione ────────────────────────────────────────────────

/// Chiede la risoluzione fra quelle **realmente disponibili** per questo video, e
/// se serve la strategia audio. La prima voce è "massima" = nessun cap.
fn ask_quality(formats: &ondo_core::ytdlp::FormatsSummary) -> Option<(AudioStrategy, Option<Option<u64>>)> {
    let mut strategy = AudioStrategy::Auto;

    // Il caso che la nota di qualità esiste per intercettare: yt-dlp ripiegherebbe
    // in silenzio su un combinato basso perché manca l'audio-only da fondere.
    if formats.needs_audio_choice {
        println!(
            "\n{}",
            style(format!(
                "⚠  Per questo video YouTube espone il video fino a {}p ma nessuna traccia audio separata.\n   \
                 Senza una scelta, il download ripiegherebbe su {}p (video+audio già uniti).",
                formats.max_video_height, formats.max_combined_height
            ))
            .yellow()
        );
        let choice = Select::with_theme(&theme())
            .with_prompt("Come procedere?")
            .items(&[
                format!("Fondi video {}p + audio con ffmpeg (consigliato)", formats.max_video_height),
                format!("Scarica il combinato a {}p", formats.max_combined_height),
            ])
            .default(0)
            .interact_opt()
            .ok()??;
        strategy = if choice == 0 { AudioStrategy::Merged } else { AudioStrategy::Combined };
    }

    if formats.available_heights.is_empty() {
        return Some((strategy, None));
    }

    let mut labels: Vec<String> = vec![format!("{}p (massima)", formats.available_heights[0])];
    labels.extend(
        formats.available_heights[1..]
            .iter()
            .map(|h| format!("{h}p")),
    );
    let idx = Select::with_theme(&theme())
        .with_prompt("Risoluzione")
        .items(&labels)
        .default(0)
        .interact_opt()
        .ok()??;

    // Indice 0 = "massima" → Some(None): nessun cap, esplicito (non "usa config").
    let cap = if idx == 0 { None } else { Some(formats.available_heights[idx]) };
    Some((strategy, Some(cap)))
}

// ── Menu: Catalogo ──────────────────────────────────────────────────────────

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
            Err(e) => return screen.err(e),
        };
        let all = query::list_videos_in(&catalog, &query::VideoFilter::new());

        let mut labels: Vec<String> = FILTERS
            .iter()
            .map(|(name, cat)| {
                let n = match cat {
                    None => all.len(),
                    Some(c) => all.iter().filter(|v| v.category() == *c).count(),
                };
                format!("{name} ({n})")
            })
            .collect();
        let favorites = all.iter().filter(|v| v.favorite()).count();
        labels.push(format!("★ Preferiti ({favorites})"));

        let Some(choice) = select_with_back("Catalogo — quale gruppo?", labels) else {
            return;
        };

        let (title, videos): (String, Vec<Video>) = if choice == FILTERS.len() {
            ("Preferiti".into(), all.into_iter().filter(|v| v.favorite()).collect())
        } else {
            let (name, wanted) = FILTERS[choice];
            let filtered = match wanted {
                None => all,
                Some(c) => all.into_iter().filter(|v| v.category() == c).collect(),
            };
            (name.to_string(), filtered)
        };
        browse_videos(screen, videos, &title);
    }
}

fn browse_videos(screen: &mut Screen, videos: Vec<Video>, title: &str) {
    if videos.is_empty() {
        screen.set(format!("\nNessun video in «{title}».\n"));
        return;
    }
    loop {
        screen.clear();
        let mut labels: Vec<String> = Vec::new();
        // Scaricare in blocco tutto ciò che in questa vista non è ancora scaricato.
        let downloadable: Vec<String> = videos
            .iter()
            .filter(|v| v.download() == download_state::NONE)
            .map(|v| v.id().to_string())
            .collect();
        if !downloadable.is_empty() {
            labels.push(format!("▶ Scarica tutti i {} non scaricati", downloadable.len()));
        }
        labels.extend(videos.iter().map(video_line));

        let prompt = format!("{title} — {} video", videos.len());
        let Some(index) = select_with_back(&prompt, labels) else {
            return;
        };

        if !downloadable.is_empty() && index == 0 {
            if confirm(&format!("Scaricare {} video ora?", downloadable.len()), true) {
                run_download(screen, &downloadable, AudioStrategy::Auto, None);
            }
            return; // la lista è ormai obsoleta: si torna al livello superiore
        }
        let offset = usize::from(!downloadable.is_empty());
        let id = videos[index - offset].id().to_string();
        video_detail(screen, &id);
    }
}

// ── Dettaglio di un video ───────────────────────────────────────────────────

fn video_detail(screen: &mut Screen, id: &str) {
    loop {
        screen.clear();
        let video = match query::get_video(id) {
            Ok(v) => v,
            Err(e) => return screen.err(e),
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
            let size = video.0.get("video").and_then(|v| v.get("sizeBytes")).and_then(serde_json::Value::as_u64);
            println!("  file     {local}  ({})", format_size(size));
        }
        if let Some(note) = video.0.get("video").and_then(|v| v.get("qualityNote")) {
            if !note.is_null() {
                println!(
                    "  {}",
                    style(format!(
                        "⚠ scaricato a {}p — probabile ripiego, vale la pena riprovare",
                        note.get("downloadedHeight").and_then(serde_json::Value::as_u64).unwrap_or(0)
                    ))
                    .yellow()
                );
            }
        }
        if let Some(err) = video.0.get("error").and_then(|e| e.get("message")).and_then(serde_json::Value::as_str) {
            println!("  {}", style(format!("errore   {err}")).red());
        }
        println!();

        let mut actions: Vec<(&str, String)> = Vec::new();
        if video.is_downloaded() {
            actions.push(("play", "▶ Riproduci con VLC".into()));
            actions.push(("redownload", "⟳ Elimina il file e ri-scarica".into()));
            actions.push(("delfile", "🗑 Cancella solo il file (tieni la scheda)".into()));
        } else {
            actions.push(("download", "⬇ Scarica".into()));
        }
        actions.push(if video.favorite() {
            ("unfav", "☆ Togli dai preferiti".into())
        } else {
            ("fav", "★ Aggiungi ai preferiti".into())
        });
        actions.push(if video.hidden() {
            ("unhide", "◉ Ripristina dagli archiviati".into())
        } else {
            ("hide", "◌ Archivia (nascondi)".into())
        });
        if video.hidden() {
            actions.push(("purge", "⚠ Cancella definitivamente (file + scheda)".into()));
        }
        actions.push(("meta", "ℹ Metadati grezzi".into()));

        let labels: Vec<String> = actions.iter().map(|(_, l)| l.clone()).collect();
        let Some(choice) = select_with_back("Azione", labels) else {
            return;
        };

        match actions[choice].0 {
            "play" => match play_with_vlc(&video) {
                Ok(()) => screen.ok("VLC avviato."),
                Err(e) => screen.err(e),
            },
            "download" => download_one(screen, &video),
            "redownload" => {
                if confirm("Cancellare il file attuale e ri-scaricarlo?", false) {
                    match library::delete_video_file(id) {
                        Ok(()) => match query::get_video(id) {
                            Ok(fresh) => download_one(screen, &fresh),
                            Err(e) => screen.err(e),
                        },
                        Err(e) => screen.err(e),
                    }
                }
            }
            "delfile" => {
                if confirm("Cancellare il file dal disco? La scheda resta in libreria.", false) {
                    screen.report(library::delete_video_file(id), "File cancellato, scheda mantenuta.");
                }
            }
            "purge" => {
                if confirm("CANCELLARE DEFINITIVAMENTE questo video? Irreversibile.", false) {
                    screen.report(library::delete_video_completely(id), "Cancellato definitivamente.");
                    return; // la scheda non esiste più
                }
            }
            "fav" => screen.report(query::set_video_favorite(id, true), "Aggiunto ai preferiti."),
            "unfav" => screen.report(query::set_video_favorite(id, false), "Rimosso dai preferiti."),
            "hide" => screen.report(query::set_video_hidden(id, true), "Archiviato."),
            "unhide" => screen.report(query::set_video_hidden(id, false), "Ripristinato."),
            "meta" => {
                screen.clear();
                match metadata::get_metadata(id) {
                    Ok(Some(m)) => {
                        let text = serde_json::to_string_pretty(&m).unwrap_or_default();
                        for line in text.lines().take(60) {
                            println!("{line}");
                        }
                        if text.lines().count() > 60 {
                            println!("{}", style("… (troncato)").dim());
                        }
                    }
                    Ok(None) => println!("Nessun metadato grezzo salvato per questo video."),
                    Err(e) => println!("{e}"),
                }
                pause();
            }
            _ => {}
        }
    }
}

fn download_one(screen: &mut Screen, video: &Video) {
    let Some(url) = video.webpage_url().map(str::to_string) else {
        return screen.err("Nessun URL registrato per questo video.");
    };
    screen.clear();
    println!("{}", style("Analisi dei formati disponibili…").dim());

    // Si interroga yt-dlp per sapere quali risoluzioni esistono davvero, invece di
    // proporre una lista fissa che potrebbe non corrispondere a questo video.
    let (strategy, max_height) = match ondo_core::ytdlp::resolve_video_info(&url) {
        Ok(resolved) => match ask_quality(&resolved.formats) {
            Some(v) => v,
            None => return,
        },
        Err(e) => {
            screen.err(format!("Formati non risolti: {e}"));
            return;
        }
    };
    run_download(screen, &[video.id().to_string()], strategy, max_height);
}

fn run_download(screen: &mut Screen, ids: &[String], strategy: AudioStrategy, max_height: Option<Option<u64>>) {
    screen.clear();
    println!("{}\n", style("Download in corso — Ctrl-C per interrompere").bold());
    let reporter = TerminalReporter::new(ids.len() > 1);
    let result = tasks::download_many(ids, strategy, max_height, &reporter);
    reporter.finish();
    match result {
        Ok(r) => {
            let msg = format!("{} scaricati, {} falliti su {}.", r.downloaded, r.failed, r.total);
            if r.failed == 0 {
                screen.ok(msg);
            } else {
                screen.set(format!("\n{} {msg}\n", style("⚠").yellow()));
            }
        }
        Err(e) => screen.err(e),
    }
    pause();
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
        .map_err(|e| {
            ondo_core::OndoError::new(ondo_core::ErrorKind::Io, format!("Avvio di VLC fallito: {e}"))
        })?;
    Ok(())
}

// ── Menu: Cerca ─────────────────────────────────────────────────────────────

fn menu_search(screen: &mut Screen) {
    loop {
        screen.clear();
        println!("{}", style("Cerca fra titoli, canali, tag e descrizioni (invio vuoto per tornare)").dim());
        let Some(q) = ask_text("Cerca") else { return };
        match search::search_videos(&q, Some(50)) {
            Ok(hits) if hits.is_empty() => screen.set(format!("\nNessun risultato per «{q}».\n")),
            Ok(hits) => browse_videos(screen, hits, &format!("Risultati per «{q}»")),
            Err(e) => screen.err(e),
        }
    }
}

// ── Menu: Guarda ────────────────────────────────────────────────────────────

fn menu_watch(screen: &mut Screen) {
    loop {
        screen.clear();
        let channels = match query::list_channels(Some(download_state::DOWNLOADED)) {
            Ok(c) => c,
            Err(e) => return screen.err(e),
        };
        if channels.is_empty() {
            return screen.set("\nNessun video scaricato: non c'è ancora niente da guardare.\n".to_string());
        }
        let labels: Vec<String> = channels
            .iter()
            .map(|c| {
                format!(
                    "{}  {}",
                    c.name.clone().unwrap_or_else(|| c.key.clone()),
                    style(format!("({})", c.count)).dim()
                )
            })
            .collect();
        let Some(index) = select_with_back("Guarda — quale creator?", labels) else {
            return;
        };
        let channel = &channels[index];
        match query::list_videos_by_channel(&channel.key, Some(download_state::DOWNLOADED)) {
            Ok(videos) => browse_videos(screen, videos, channel.name.as_deref().unwrap_or(&channel.key)),
            Err(e) => screen.err(e),
        }
    }
}

// ── Menu: Fonti ─────────────────────────────────────────────────────────────

fn menu_sources(screen: &mut Screen) {
    loop {
        screen.clear();
        let list = match sources::list_sources() {
            Ok(l) => l,
            Err(e) => return screen.err(e),
        };

        if list.is_empty() {
            println!("{}\n", style("Nessuna fonte configurata.").dim());
        } else {
            println!("{}", style("Fonti configurate").bold());
            for s in &list {
                println!(
                    "  {}  {}  {}",
                    s.name.clone().unwrap_or_else(|| s.id.clone()),
                    style(format!("({} video)", s.video_count)).dim(),
                    style(s.last_checked_at.clone().unwrap_or_else(|| "mai sincronizzata".into())).dim()
                );
            }
            println!();
        }

        let mut labels = vec!["＋ Aggiungi una playlist".to_string()];
        if !list.is_empty() {
            labels.push("⟳ Sincronizza tutte".to_string());
            labels.push("⟳ Sincronizza una fonte…".to_string());
            labels.push("✎ Completa i metadati mancanti".to_string());
            labels.push("－ Rimuovi una fonte…".to_string());
        }

        let Some(choice) = select_with_back("Gestisci fonti", labels) else {
            return;
        };

        match choice {
            0 => {
                let Some(url) = ask_text("URL della playlist (deve contenere list=)") else { continue };
                screen.clear();
                println!("{}", style("Enumerazione della playlist…").dim());
                match sources::add_source(&url) {
                    Ok(outcome) if outcome.already_exists => {
                        screen.set(format!("\nLa fonte «{}» è già configurata.\n", outcome.name.unwrap_or_default()))
                    }
                    Ok(outcome) => {
                        let n = outcome.report.as_ref().map(|r| r.new_count).unwrap_or(0);
                        let missing = outcome.report.as_ref().map(|r| r.missing_count()).unwrap_or(0);
                        let mut msg = format!("Fonte «{}» aggiunta: {n} video.", outcome.name.unwrap_or_default());
                        if missing > 0 {
                            msg.push_str(&format!(
                                " Attenzione: {missing} video dichiarati da YouTube non erano visibili in questa estrazione (privati o rimossi)."
                            ));
                        }
                        screen.ok(msg);
                        if confirm("Completare ora i metadati e le copertine?", true) {
                            run_enrich(screen, Some(&outcome.source_id));
                        }
                    }
                    Err(e) => screen.err(e),
                }
            }
            1 => {
                let ids: Vec<String> = list.iter().map(|s| s.id.clone()).collect();
                run_sync(screen, &ids);
            }
            2 => {
                let labels: Vec<String> = list
                    .iter()
                    .map(|s| s.name.clone().unwrap_or_else(|| s.id.clone()))
                    .collect();
                if let Some(i) = select_with_back("Quale fonte?", labels) {
                    run_sync(screen, &[list[i].id.clone()]);
                }
            }
            3 => run_enrich(screen, None),
            4 => {
                let labels: Vec<String> = list
                    .iter()
                    .map(|s| s.name.clone().unwrap_or_else(|| s.id.clone()))
                    .collect();
                if let Some(i) = select_with_back("Quale fonte rimuovere?", labels) {
                    let name = list[i].name.clone().unwrap_or_else(|| list[i].id.clone());
                    if confirm(&format!("Rimuovere «{name}»? I video restano in libreria."), false) {
                        screen.report(sources::remove_source(&list[i].id), "Fonte rimossa.");
                    }
                }
            }
            _ => {}
        }
    }
}

fn run_sync(screen: &mut Screen, source_ids: &[String]) {
    screen.clear();
    println!("{}\n", style("Sincronizzazione…").bold());
    let (mut new, mut healed, mut removed, mut restored, mut reclaimed) = (0, 0, 0, 0, 0);
    let mut skipped_healing = false;
    let mut errors: Vec<String> = Vec::new();

    for id in source_ids {
        print!("  {id} … ");
        let _ = std::io::stdout().flush();
        match sync::sync_source(id) {
            Ok(r) => {
                println!(
                    "{} nuovi, {} rimossi, {} ripristinati",
                    r.new_count, r.removed_count, r.restored_count
                );
                new += r.new_count;
                healed += r.healed_count;
                removed += r.removed_count;
                restored += r.restored_count;
                reclaimed += r.reclaimed_count;
                skipped_healing |= r.healing_skipped;
            }
            Err(e) => {
                println!("{}", style("errore").red());
                errors.push(format!("{id}: {e}"));
            }
        }
    }

    let mut msg = format!(
        "Sincronizzazione completata: {new} nuovi, {removed} rimossi, {restored} ripristinati, {healed} da ri-scaricare."
    );
    if reclaimed > 0 {
        msg.push_str(&format!(" {reclaimed} recuperati (file ricomparso su disco)."));
    }
    if skipped_healing {
        msg.push_str(
            "\n  ⚠ La cartella dei video risulta vuota o irraggiungibile: il controllo dei file \
             è stato SALTATO per non azzerare lo stato. Verifica che il disco sia collegato.",
        );
    }
    for e in &errors {
        msg.push_str(&format!("\n  ✘ {e}"));
    }
    screen.set(format!("\n{msg}\n"));
    pause();
}

fn run_enrich(screen: &mut Screen, source_id: Option<&str>) {
    screen.clear();
    println!("{}\n", style("Recupero metadati e copertine — Ctrl-C per interrompere").bold());
    let reporter = TerminalReporter::new(true);
    let result = tasks::enrich_pending(source_id, &reporter);
    reporter.finish();
    match result {
        Ok(r) => screen.ok(format!(
            "{} arricchiti, {} falliti, {} non più disponibili.",
            r.enriched, r.failed, r.removed
        )),
        Err(e) => screen.err(e),
    }
    pause();
}

// ── Menu: Scarica un singolo video ──────────────────────────────────────────

fn menu_single(screen: &mut Screen) {
    screen.clear();
    println!(
        "{}",
        style("Incolla il link di un video (YouTube o qualunque sito supportato da yt-dlp),\noppure un id YouTube di 11 caratteri.").dim()
    );
    let Some(input) = ask_text("Link") else { return };

    screen.clear();
    println!("{}", style("Risoluzione del link…").dim());
    match sources::prepare_single_video(&input) {
        Ok(sources::SinglePrepared::AlreadyDownloaded { id, title }) => screen.set(format!(
            "\nGià in archivio: «{}» ({id}).\n",
            title.unwrap_or_else(|| id.clone())
        )),
        Ok(sources::SinglePrepared::Ready { id, title, formats, .. }) => {
            println!("\n{}", style(title.unwrap_or_else(|| id.clone())).bold());
            let Some((strategy, max_height)) = ask_quality(&formats) else { return };
            run_download(screen, &[id], strategy, max_height);
        }
        Err(e) => screen.err(e),
    }
}

// ── Menu: Manutenzione ──────────────────────────────────────────────────────

fn menu_maintenance(screen: &mut Screen) {
    loop {
        screen.clear();
        let labels = vec![
            "📁 Riorganizza l'archivio per creator".to_string(),
            "🖼 Aggiorna le foto dei creator".to_string(),
            "🕘 Storico delle esecuzioni".to_string(),
            "🧹 Svuota lo storico".to_string(),
        ];
        let Some(choice) = select_with_back("Manutenzione", labels) else {
            return;
        };

        match choice {
            0 => {
                screen.clear();
                println!("{}", style("Analisi (nessun file viene toccato)…").dim());
                match library::reorganize_library(true) {
                    Ok(plan) => {
                        println!(
                            "\n  già a posto: {}   da spostare: {}   file mancanti: {}\n",
                            plan.already_ok,
                            plan.planned.len(),
                            plan.missing.len()
                        );
                        for m in plan.planned.iter().take(15) {
                            println!("  {}\n    → {}", style(&m.from).dim(), m.to);
                        }
                        if plan.planned.len() > 15 {
                            println!("  … e altri {}", plan.planned.len() - 15);
                        }
                        if !plan.planned.is_empty() && confirm("\nEseguire gli spostamenti?", false) {
                            match library::reorganize_library(false) {
                                Ok(done) => screen.ok(format!("{} file spostati.", done.moved)),
                                Err(e) => screen.err(e),
                            }
                        }
                    }
                    Err(e) => screen.err(e),
                }
            }
            1 => {
                screen.clear();
                println!("{}\n", style("Aggiornamento foto dei creator…").bold());
                let reporter = TerminalReporter::new(true);
                match tasks::sync_channel_avatars(false, &reporter) {
                    Ok(r) => screen.ok(format!(
                        "{} aggiornate, {} già presenti, {} non trovate.",
                        r.fetched, r.skipped, r.failed
                    )),
                    Err(e) => screen.err(e),
                }
                pause();
            }
            2 => {
                screen.clear();
                match tasks::list_runs(30) {
                    Ok(runs) if runs.is_empty() => println!("Nessuna esecuzione registrata."),
                    Ok(runs) => {
                        println!("{}\n", style("Storico delle esecuzioni").bold());
                        for r in runs {
                            let icon = if r.status == "success" {
                                style("✔").green()
                            } else {
                                style("✘").red()
                            };
                            println!(
                                "  {icon} {}  {}  {}",
                                r.finished_at.unwrap_or_default(),
                                r.kind,
                                style(r.summary.to_string()).dim()
                            );
                        }
                    }
                    Err(e) => println!("{e}"),
                }
                pause();
            }
            3 => {
                if confirm("Svuotare lo storico delle esecuzioni?", false) {
                    match tasks::clear_runs() {
                        Ok(n) => screen.ok(format!("{n} voci rimosse.")),
                        Err(e) => screen.err(e),
                    }
                }
            }
            _ => {}
        }
    }
}

// ── Menu: Stato ─────────────────────────────────────────────────────────────

fn menu_status(screen: &mut Screen) {
    screen.clear();
    let paths = match get_paths() {
        Ok(p) => p,
        Err(e) => return screen.err(e),
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

    if let Ok(catalog) = store::read_catalog() {
        let all = query::list_videos_in(&catalog, &query::VideoFilter::new());
        let downloaded = all.iter().filter(|v| v.is_downloaded()).count();
        let bytes: u64 = all
            .iter()
            .filter_map(|v| v.0.get("video").and_then(|x| x.get("sizeBytes")).and_then(serde_json::Value::as_u64))
            .sum();
        println!(
            "\n  {} video in catalogo, {} scaricati ({})",
            all.len(),
            downloaded,
            format_size(Some(bytes))
        );
        if let Ok(n) = metadata::count() {
            println!("  {n} con metadati grezzi salvati");
        }
    }

    match check_tools() {
        Ok(s) if s.ok => {
            println!("\n  {} yt-dlp  {}", style("✔").green(), s.ytdlp_path.display());
            if let Ok(v) = ondo_core::ytdlp::get_ytdlp_version() {
                println!("           versione {v}");
            }
            println!("  {} ffmpeg  {}", style("✔").green(), s.ffmpeg_source.unwrap_or_default());
        }
        Ok(s) => {
            println!("\n{}", style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow());
            for m in &s.messages {
                println!("  • {m}");
            }
            println!("\n  Rimedio: esegui  npm run setup");
        }
        Err(e) => println!("\n{} {e}", style("✘").red()),
    }

    println!("\n  ondo-core {}\n", ondo_core::VERSION);
    pause();
}

// ── Menu principale ─────────────────────────────────────────────────────────

fn main() {
    let mut screen = Screen::new();

    // Prerequisiti esterni: l'avviso passa da un messaggio in sospeso e non da una
    // stampa diretta, che il primo clear cancellerebbe.
    if let Ok(status) = check_tools() {
        if !status.ok {
            screen.set(format!(
                "\n{}\n\n{}\n\n  Rimedio: esegui  npm run setup\n",
                style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow(),
                status.messages.iter().map(|m| format!("  • {m}")).collect::<Vec<_>>().join("\n\n")
            ));
        }
    }

    let entries: [(&str, fn(&mut Screen)); 7] = [
        ("Catalogo", menu_catalog),
        ("Cerca", menu_search),
        ("Guarda", menu_watch),
        ("Gestisci fonti", menu_sources),
        ("Scarica un video singolo", menu_single),
        ("Manutenzione", menu_maintenance),
        ("Stato installazione", menu_status),
    ];

    loop {
        screen.clear();
        let mut labels: Vec<String> = entries.iter().map(|(n, _)| n.to_string()).collect();
        labels.push("Esci".to_string());

        match Select::with_theme(&theme())
            .with_prompt("Ondo — cosa vuoi fare?")
            .items(&labels)
            .default(0)
            .interact_opt()
        {
            Ok(Some(i)) if i < entries.len() => entries[i].1(&mut screen),
            _ => break, // "Esci", ESC o Ctrl-C
        }
    }

    println!("Ciao!");
}

// I test di comportamento vivono in ondo-core; qui si verifica solo la
// presentazione, che è l'unica logica propria di questo adapter.
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
    fn sizes_switch_unit_at_one_gigabyte() {
        assert_eq!(format_size(None), "—");
        assert_eq!(format_size(Some(0)), "—");
        assert_eq!(format_size(Some(343 * 1_048_576)), "343 MB");
        assert_eq!(format_size(Some(2 * 1_073_741_824)), "2.0 GB");
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
        assert!(line.contains("Titolo") && line.contains("Creator") && line.contains("3:32"));
    }
}
