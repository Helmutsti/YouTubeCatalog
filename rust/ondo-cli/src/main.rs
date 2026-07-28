//! `ondo` — la CLI.
//!
//! Struttura dei menu decisa dall'utente:
//!
//! ```text
//! Cerca            ricerca libera nella libreria
//! Sorgenti         elenco e gestione delle sorgenti
//! Libreria         autori · tutti i video · preferiti · da scaricare
//!                  · archiviati · rimossi da YouTube · falliti
//! Download rapido  un link, un download — senza registrare una sorgente
//! Impostazioni     percorsi, strumenti, manutenzione, storico
//! ```
//!
//! Scelte di UX conservate dall'originale, che sono decisioni di progetto:
//! navigazione **con le frecce** (testo libero solo dove è il punto: ricerca e
//! link), una voce **"← Torna"** in coda a ogni sottomenu, e il **reset dello
//! schermo** a ogni menu con un messaggio "in sospeso" che sopravvive esattamente a
//! una schermata — senza, dopo pochi giri il terminale diventa illeggibile.
//!
//! È un adapter sottile: nessuna regola di stato vive qui, tutto passa da
//! `ondo_core::{library, ops}`.
//!
//! **Interruzione**: Ctrl-C. Le operazioni girano in primo piano, quindi la console
//! recapita il segnale a tutto il gruppo di processi, yt-dlp compreso. Chiude anche
//! la CLI, ma non lascia lo stato incoerente: un video interrotto resta
//! `downloading` e la riconciliazione all'avvio successivo lo riporta a "da scaricare".

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use console::{style, Term};
use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, Select};

use ondo_core::config::{check_tools, get_paths};
use ondo_core::downloader::{AudioStrategy, FormatsSummary, Reporter};
use ondo_core::library::schema::{download_state, VideoCategory};
use ondo_core::library::{self, files, metadata, query, search, state, Video};
use ondo_core::ops;

// ── Schermo ─────────────────────────────────────────────────────────────────

struct Screen {
    term: Term,
    pending: Option<String>,
}

impl Screen {
    fn new() -> Self {
        Self { term: Term::stdout(), pending: None }
    }
    fn clear(&mut self) {
        if self.term.is_term() {
            let _ = self.term.clear_screen();
        }
        if let Some(m) = self.pending.take() {
            println!("{m}");
        }
    }
    fn set(&mut self, m: impl Into<String>) {
        self.pending = Some(m.into());
    }
    fn ok(&mut self, m: impl std::fmt::Display) {
        self.set(format!("\n{} {m}\n", style("✔").green()));
    }
    fn warn(&mut self, m: impl std::fmt::Display) {
        self.set(format!("\n{} {m}\n", style("⚠").yellow()));
    }
    fn err(&mut self, m: impl std::fmt::Display) {
        self.set(format!("\n{} {m}\n", style("✘").red()));
    }
    fn report<T>(&mut self, r: ondo_core::Result<T>, m: &str) {
        match r {
            Ok(_) => self.ok(m),
            Err(e) => self.err(e),
        }
    }
}

// ── Reporter da terminale ───────────────────────────────────────────────────

struct TermReporter {
    last: Mutex<i64>,
    quiet: bool,
}

impl TermReporter {
    fn new(quiet: bool) -> Self {
        Self { last: Mutex::new(-1), quiet }
    }
    fn finish(&self) {
        let mut l = self.last.lock().unwrap();
        if *l >= 0 {
            println!();
            *l = -1;
        }
    }
}

impl Reporter for TermReporter {
    fn log(&self, line: &str) {
        // Le righe di avanzamento di yt-dlp sono già rese dalla barra.
        if line.starts_with("[download]") && line.contains('%') {
            return;
        }
        let important = line.starts_with('✔') || line.starts_with('✘') || line.starts_with('⊘') || line.starts_with("---");
        if self.quiet && !important {
            return;
        }
        self.finish();
        println!("  {}", if important { style(line).white() } else { style(line).dim() });
    }
    fn progress(&self, percent: f64) {
        let pct = percent.round() as i64;
        let mut last = self.last.lock().unwrap();
        if *last == pct {
            return;
        }
        *last = pct;
        let filled = (pct.clamp(0, 100) as usize) * 30 / 100;
        print!("\r  {} {pct:>3}%", style("█".repeat(filled) + &"░".repeat(30 - filled)).cyan());
        let _ = std::io::stdout().flush();
    }
}

// ── Presentazione ───────────────────────────────────────────────────────────

fn dur(seconds: Option<f64>) -> String {
    match seconds {
        Some(s) if s > 0.0 => {
            let t = s as u64;
            let (h, m, sec) = (t / 3600, (t % 3600) / 60, t % 60);
            if h > 0 { format!("{h}:{m:02}:{sec:02}") } else { format!("{m}:{sec:02}") }
        }
        _ => "--:--".into(),
    }
}

fn size(bytes: Option<u64>) -> String {
    match bytes {
        Some(b) if b > 0 => {
            let gb = b as f64 / 1_073_741_824.0;
            if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", b as f64 / 1_048_576.0) }
        }
        _ => "—".into(),
    }
}

fn video_line(v: &Video) -> String {
    let c = v.category();
    let icon = match c {
        VideoCategory::Downloaded => style(c.label()).green(),
        VideoCategory::Removed => style(c.label()).red(),
        VideoCategory::Failed => style(c.label()).yellow(),
        VideoCategory::Downloading => style(c.label()).cyan(),
        VideoCategory::Hidden | VideoCategory::Available => style(c.label()).dim(),
    };
    format!(
        "{icon}  {}{}  {}  [{}]",
        if v.favorite() { "[preferito] " } else { "" },
        v.display_title(),
        style(v.channel_name().unwrap_or("—")).dim(),
        dur(v.duration_seconds())
    )
}

fn theme() -> ColorfulTheme {
    ColorfulTheme::default()
}

fn select_back(prompt: &str, mut labels: Vec<String>) -> Option<usize> {
    let n = labels.len();
    labels.push("← Torna".into());
    let i = Select::with_theme(&theme())
        .with_prompt(prompt)
        .items(&labels)
        .default(0)
        .interact_opt()
        .ok()
        .flatten()?;
    (i < n).then_some(i)
}

fn ask(prompt: &str) -> Option<String> {
    let v: String = Input::with_theme(&theme())
        .with_prompt(prompt)
        .allow_empty(true)
        .interact_text()
        .ok()?;
    let v = v.trim().to_string();
    (!v.is_empty()).then_some(v)
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
    let mut b = String::new();
    let _ = std::io::stdin().read_line(&mut b);
}

// ── Qualità ─────────────────────────────────────────────────────────────────

/// Decide qualità e strategia audio **senza chiedere nulla**, quando l'impostazione
/// `download.defaultQuality` è diversa da "chiedi".
///
/// Restituisce `None` se l'impostazione è "chiedi", nel qual caso si passa da
/// [`ask_quality`] — che però richiede prima un'interrogazione di rete per sapere
/// quali risoluzioni esistono. Saltarla è ciò che fa partire il download **subito**.
///
/// Contropartita dichiarata: senza quell'interrogazione non si può sapere in anticipo
/// se al video manca la traccia audio separata (il caso in cui yt-dlp ripiegherebbe in
/// silenzio su 360p). Resta però la rete di sicurezza a posteriori: un download ≤360p
/// viene marcato con una nota di qualità, visibile nel dettaglio del video.
fn quality_without_asking() -> Option<(AudioStrategy, Option<Option<u64>>)> {
    let pref = ondo_core::config::default_quality().ok()?;
    // Due livelli di Option con significati diversi, che è facile confondere:
    //   `max_height()`      → None = «chiedi»,  Some(cap) = «parti con questo tetto»
    //   il parametro passato → None = «usa la config», Some(cap) = tetto esplicito
    // Qui la scelta è già stata fatta, quindi il tetto va passato sempre esplicito.
    let cap = pref.max_height()?;
    Some((AudioStrategy::Auto, Some(cap)))
}

/// Chiede la risoluzione fra quelle **realmente disponibili** per questo video, e la
/// strategia audio quando serve.
fn ask_quality(f: &FormatsSummary) -> Option<(AudioStrategy, Option<Option<u64>>)> {
    let mut strategy = AudioStrategy::Auto;

    // Il caso per cui la nota di qualità esiste: yt-dlp ripiegherebbe in silenzio su
    // un combinato basso perché manca una traccia audio separata da fondere.
    if f.needs_audio_choice {
        println!(
            "\n{}",
            style(format!(
                "⚠  Video disponibile fino a {}p, ma senza traccia audio separata.\n   \
                 Senza una scelta il download ripiegherebbe su {}p.",
                f.max_video_height, f.max_combined_height
            ))
            .yellow()
        );
        let i = Select::with_theme(&theme())
            .with_prompt("Come procedere?")
            .items(&[
                format!("Fondi video {}p + audio con ffmpeg (consigliato)", f.max_video_height),
                format!("Scarica il combinato a {}p", f.max_combined_height),
            ])
            .default(0)
            .interact_opt()
            .ok()??;
        strategy = if i == 0 { AudioStrategy::Merged } else { AudioStrategy::Combined };
    }

    if f.available_heights.is_empty() {
        return Some((strategy, None));
    }
    let mut labels = vec![format!("{}p (massima)", f.available_heights[0])];
    labels.extend(f.available_heights[1..].iter().map(|h| format!("{h}p")));
    let i = Select::with_theme(&theme())
        .with_prompt("Risoluzione")
        .items(&labels)
        .default(0)
        .interact_opt()
        .ok()??;
    // Indice 0 = massima → nessun cap, esplicito (non "usa la config").
    Some((strategy, Some(if i == 0 { None } else { Some(f.available_heights[i]) })))
}

// ── Elenco di video e dettaglio ─────────────────────────────────────────────

fn browse(screen: &mut Screen, videos: Vec<Video>, title: &str) {
    if videos.is_empty() {
        screen.set(format!("\nNiente in «{title}».\n"));
        return;
    }
    loop {
        screen.clear();
        let pending: Vec<String> = videos
            .iter()
            .filter(|v| v.download() == download_state::NONE && !v.hidden())
            .map(|v| v.id().to_string())
            .collect();

        let mut labels = Vec::new();
        if !pending.is_empty() {
            labels.push(format!("Scarica tutti i {} non scaricati", pending.len()));
        }
        labels.extend(videos.iter().map(video_line));

        let Some(i) = select_back(&format!("{title} — {} video", videos.len()), labels) else {
            return;
        };
        if !pending.is_empty() && i == 0 {
            if confirm(&format!("Scaricare {} video?", pending.len()), true) {
                run_download(screen, &pending, AudioStrategy::Auto, None);
            }
            return; // l'elenco è ormai obsoleto
        }
        let id = videos[i - usize::from(!pending.is_empty())].id().to_string();
        detail(screen, &id);
    }
}

fn detail(screen: &mut Screen, id: &str) {
    loop {
        screen.clear();
        let st = match state::read() {
            Ok(s) => s,
            Err(e) => return screen.err(e),
        };
        let Ok(v) = st.video(id) else {
            return screen.err(format!("Video non trovato: {id}"));
        };
        let v = v.clone();

        println!("{}", style(v.display_title()).bold().cyan());
        println!("  autore   {}", v.channel_name().unwrap_or("—"));
        println!("  durata   {}", dur(v.duration_seconds()));
        println!("  stato    {}", v.category().label());
        println!("  id       {}", v.id());
        if let Some(u) = v.webpage_url() {
            println!("  origine  {u}");
        }
        if let Some(p) = v.local_path() {
            println!("  file     {p}  ({})", size(v.size_bytes()));
        }
        let labels_sources: Vec<String> = v
            .source_ids()
            .iter()
            .map(|sid| st.sources.get(*sid).map(|s| s.display_name()).unwrap_or_else(|| (*sid).into()))
            .collect();
        if !labels_sources.is_empty() {
            println!("  sorgenti {}", labels_sources.join(", "));
        }
        if let Some(n) = v.quality_note() {
            println!(
                "  {}",
                style(format!(
                    "⚠ scaricato a {}p — probabile ripiego, vale la pena riprovare",
                    n.get("downloadedHeight").and_then(serde_json::Value::as_u64).unwrap_or(0)
                ))
                .yellow()
            );
        }
        if let Some(e) = v.error_message() {
            println!("  {}", style(format!("errore   {e}")).red());
        }
        println!();

        let mut actions: Vec<(&str, String)> = Vec::new();
        if v.is_downloaded() {
            actions.push(("play", "Riproduci con VLC".into()));
            actions.push(("re", "Elimina e ri-scarica".into()));
            actions.push(("delfile", "Cancella il file (tieni la scheda)".into()));
        } else {
            actions.push(("dl", "Scarica".into()));
        }
        actions.push(if v.favorite() { ("unfav", "Togli dai preferiti".into()) } else { ("fav", "Preferito".into()) });
        actions.push(if v.hidden() { ("unhide", "Ripristina".into()) } else { ("hide", "Archivia".into()) });
        if v.hidden() {
            actions.push(("purge", "Cancella per sempre".into()));
        }
        actions.push(("meta", "Metadati grezzi".into()));

        let Some(i) = select_back("Azione", actions.iter().map(|(_, l)| l.clone()).collect()) else {
            return;
        };
        match actions[i].0 {
            "play" => match play(&v) {
                Ok(()) => screen.ok("VLC avviato."),
                Err(e) => screen.err(e),
            },
            "dl" => download_one(screen, &v),
            "re" => {
                if confirm("Cancellare il file e ri-scaricarlo?", false) {
                    match ops::delete_video_file(id) {
                        Ok(()) => match state::read().and_then(|s| s.video(id).cloned()) {
                            Ok(fresh) => download_one(screen, &fresh),
                            Err(e) => screen.err(e),
                        },
                        Err(e) => screen.err(e),
                    }
                }
            }
            "delfile" => {
                if confirm("Cancellare il file? La scheda resta in libreria.", false) {
                    screen.report(ops::delete_video_file(id), "File cancellato.");
                }
            }
            "purge" => {
                if confirm("CANCELLARE PER SEMPRE (file, scheda, metadati)?", false) {
                    screen.report(ops::delete_video_completely(id), "Cancellato per sempre.");
                    return;
                }
            }
            "fav" => screen.report(ops::set_favorite(id, true), "Aggiunto ai preferiti."),
            "unfav" => screen.report(ops::set_favorite(id, false), "Rimosso dai preferiti."),
            "hide" => screen.report(ops::set_hidden(id, true), "Archiviato."),
            "unhide" => screen.report(ops::set_hidden(id, false), "Ripristinato."),
            "meta" => {
                screen.clear();
                match metadata::get(id) {
                    Ok(Some(m)) => {
                        let t = serde_json::to_string_pretty(&m).unwrap_or_default();
                        for l in t.lines().take(60) {
                            println!("{l}");
                        }
                        if t.lines().count() > 60 {
                            println!("{}", style("… (troncato)").dim());
                        }
                    }
                    Ok(None) => println!("Nessun metadato grezzo per questo video."),
                    Err(e) => println!("{e}"),
                }
                pause();
            }
            _ => {}
        }
    }
}

/// Come `risolvi_con_spinner` per la console di Download rapido: `resolve_video_info`
/// è una singola chiamata bloccante a yt-dlp, senza avanzamento intermedio — senza
/// spinner lo schermo restava fermo su un messaggio statico per tutta l'attesa,
/// indistinguibile da un blocco vero.
fn resolve_video_info_con_spinner(url: &str) -> ondo_core::Result<ondo_core::downloader::ResolvedVideo> {
    const SPINNER: [char; 4] = ['-', '\\', '|', '/'];
    let owned = url.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(ondo_core::downloader::resolve_video_info(&owned));
    });

    let mut frame = 0usize;
    let esito = loop {
        match rx.recv_timeout(std::time::Duration::from_millis(120)) {
            Ok(esito) => break esito,
            Err(_) => {
                print!(
                    "\r  {} {}",
                    style(SPINNER[frame % SPINNER.len()]).cyan(),
                    style("Analisi dei formati disponibili…").dim()
                );
                let _ = std::io::stdout().flush();
                frame += 1;
            }
        }
    };
    println!();
    esito
}

fn download_one(screen: &mut Screen, v: &Video) {
    let Some(url) = v.webpage_url().map(str::to_string) else {
        return screen.err("Nessun URL registrato.");
    };

    // Qualità predefinita impostata: si parte subito, senza interrogare i formati e
    // senza chiedere nulla.
    if let Some((s, h)) = quality_without_asking() {
        return run_download(screen, &[v.id().to_string()], s, h);
    }

    screen.clear();
    match resolve_video_info_con_spinner(&url) {
        Ok(r) => match ask_quality(&r.formats) {
            Some((s, h)) => run_download(screen, &[v.id().to_string()], s, h),
            None => {}
        },
        Err(e) => screen.err(format!("Formati non risolti: {e}")),
    }
}

fn run_download(screen: &mut Screen, ids: &[String], s: AudioStrategy, h: Option<Option<u64>>) {
    screen.clear();
    println!("{}\n", style("Download — Ctrl-C per interrompere").bold());
    let r = TermReporter::new(ids.len() > 1);
    let out = ops::download_many(ids, s, h, &r);
    r.finish();
    match out {
        Ok(rep) => {
            let m = format!("{} scaricati, {} falliti su {}.", rep.downloaded, rep.failed, rep.total);
            if rep.failed == 0 { screen.ok(m) } else { screen.warn(m) }
        }
        Err(e) => screen.err(e),
    }
    pause();
}

/// VLC parte come processo **indipendente**: continua a girare anche chiudendo la CLI.
fn play(v: &Video) -> ondo_core::Result<()> {
    let path = files::resolve_video_path(v)?;
    let paths = get_paths()?;
    if paths.vlc_path.is_empty() || !std::path::Path::new(&paths.vlc_path).is_file() {
        return Err(ondo_core::OndoError::not_found(format!(
            "VLC non trovato in {}. Impostalo in data/config.json → playback.vlcPath.",
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

// ── 1. Cerca ────────────────────────────────────────────────────────────────

fn menu_search(screen: &mut Screen) {
    loop {
        screen.clear();
        println!("{}", style("Cerca fra titoli, autori, tag e descrizioni (invio vuoto per tornare)").dim());
        let Some(q) = ask("Cerca") else { return };
        match state::read() {
            Ok(st) => {
                let hits: Vec<Video> = search(&st, &q, Some(50)).into_iter().cloned().collect();
                if hits.is_empty() {
                    screen.set(format!("\nNessun risultato per «{q}».\n"));
                } else {
                    browse(screen, hits, &format!("Risultati per «{q}»"));
                }
            }
            Err(e) => screen.err(e),
        }
    }
}

// ── 2. Sorgenti ─────────────────────────────────────────────────────────────

fn menu_sources(screen: &mut Screen) {
    loop {
        screen.clear();
        let st = match state::read() {
            Ok(s) => s,
            Err(e) => return screen.err(e),
        };
        let sources: Vec<_> = st.sources.values().cloned().collect();

        if sources.is_empty() {
            println!("{}\n", style("Nessuna sorgente configurata.").dim());
        } else {
            println!("{}", style("Sorgenti").bold());
            for s in &sources {
                println!(
                    "  {}  {}  {}",
                    s.display_name(),
                    style(format!("({} video)", st.videos_of_source(s.id()).len())).dim(),
                    style(s.last_checked_at().unwrap_or("mai sincronizzata")).dim()
                );
            }
            println!();
        }

        let mut labels = vec!["Aggiungi una playlist".to_string()];
        if !sources.is_empty() {
            labels.push("Aggiorna tutto — sincronizza, schede, foto".into());
            labels.push("Solo sincronizza (veloce)".into());
            labels.push("Sincronizza una…".into());
            labels.push("Completa metadati e copertine".into());
            labels.push("Rimuovi una sorgente…".into());
        }
        let Some(i) = select_back("Sorgenti", labels) else { return };

        match i {
            0 => {
                let Some(url) = ask("URL della playlist (con list=)") else { continue };
                screen.clear();
                println!("{}", style("Enumerazione…").dim());
                match ops::add_source(&url) {
                    Ok(o) if o.already_exists => screen.warn(format!("«{}» è già configurata.", o.name)),
                    Ok(o) => {
                        let n = o.report.as_ref().map(|r| r.new_count).unwrap_or(0);
                        let missing = o.report.as_ref().map(|r| r.missing_count()).unwrap_or(0);
                        let mut m = format!("«{}» aggiunta: {n} video.", o.name);
                        if missing > 0 {
                            m.push_str(&format!(
                                " {missing} dichiarati da YouTube non erano visibili (privati o rimossi)."
                            ));
                        }
                        screen.ok(m);
                        if confirm("Completare ora metadati e copertine?", true) {
                            run_enrich(screen, Some(&o.source_id));
                        }
                    }
                    Err(e) => screen.err(e),
                }
            }
            1 => run_update(screen),
            2 => run_sync(screen),
            3 => {
                let labels: Vec<String> = sources.iter().map(|s| s.display_name()).collect();
                if let Some(j) = select_back("Quale sorgente?", labels) {
                    screen.clear();
                    println!("{}\n", style("Sincronizzazione…").bold());
                    match ops::sync_source(sources[j].id()) {
                        Ok(r) => screen.ok(sync_summary(&r)),
                        Err(e) => screen.err(e),
                    }
                    pause();
                }
            }
            4 => run_enrich(screen, None),
            5 => {
                let labels: Vec<String> = sources.iter().map(|s| s.display_name()).collect();
                if let Some(j) = select_back("Quale rimuovere?", labels) {
                    let name = sources[j].display_name();
                    if confirm(&format!("Rimuovere «{name}»? I video restano in libreria."), false) {
                        screen.report(ops::remove_source(sources[j].id()), "Sorgente rimossa.");
                    }
                }
            }
            _ => {}
        }
    }
}

fn sync_summary(r: &ops::SyncReport) -> String {
    let mut m = format!(
        "{} nuovi, {} rimossi, {} ripristinati, {} da ri-scaricare.",
        r.new_count, r.removed_count, r.restored_count, r.healed_count
    );
    if r.reclaimed_count > 0 {
        m.push_str(&format!(" {} recuperati (file ricomparso).", r.reclaimed_count));
    }
    if r.healing_skipped {
        m.push_str(
            "\n  ⚠ La cartella dei video risulta vuota o irraggiungibile: il controllo dei file \
             è stato SALTATO per non azzerare lo stato. Verifica che il disco sia collegato.",
        );
    }
    for e in &r.errors {
        m.push_str(&format!("\n  ✘ {e}"));
    }
    m
}

/// Aggiornamento completo: sincronizza, completa le schede, prende le foto dei
/// creator. **Non scarica** — alla fine dice quanti video sono pronti e lascia
/// decidere.
fn run_update(screen: &mut Screen) {
    screen.clear();
    println!("{}", style("Aggiornamento della libreria").bold());
    println!(
        "{}\n",
        style("① sincronizza le sorgenti  ② completa metadati e copertine  ③ foto dei creator\nNon scarica video. Ctrl-C per interrompere.").dim()
    );

    let r = TermReporter::new(true);
    let out = ops::update_library(&r);
    r.finish();

    match out {
        Ok(rep) => {
            let mut m = format!("{} (in {}s)", rep.summary(), rep.seconds);
            for w in rep.warnings() {
                m.push_str(&format!("\n  ⚠ {w}"));
            }
            if rep.pending > 0 {
                m.push_str(&format!(
                    "\n\n  {} video pronti da scaricare — Libreria → Da scaricare",
                    rep.pending
                ));
            }
            screen.set(format!("\n{} {m}\n", style("✔").green()));
        }
        Err(e) => screen.err(e),
    }
    pause();
}

fn run_sync(screen: &mut Screen) {
    screen.clear();
    println!("{}\n", style("Sincronizzazione di tutte le sorgenti…").bold());
    match ops::sync_all() {
        Ok(r) => screen.set(format!("\n{}\n", sync_summary(&r))),
        Err(e) => screen.err(e),
    }
    pause();
}

fn run_enrich(screen: &mut Screen, source_id: Option<&str>) {
    screen.clear();
    println!("{}\n", style("Metadati e copertine — Ctrl-C per interrompere").bold());
    let r = TermReporter::new(true);
    let out = ops::enrich(source_id, &r);
    r.finish();
    match out {
        Ok(rep) => screen.ok(format!(
            "{} completati, {} falliti, {} non più disponibili.",
            rep.enriched, rep.failed, rep.removed
        )),
        Err(e) => screen.err(e),
    }
    pause();
}

// ── 3. Libreria ─────────────────────────────────────────────────────────────

fn menu_library(screen: &mut Screen) {
    loop {
        screen.clear();
        let st = match state::read() {
            Ok(s) => s,
            Err(e) => return screen.err(e),
        };
        let c = query::counts(&st);

        let labels = vec![
            format!("Autori ({})", st.authors.len()),
            format!("Tutti i video ({}) — dall'ultimo aggiunto", c.total),
            format!("Preferiti ({})", c.favorite),
            format!("Da scaricare ({})", c.available),
            format!("Archiviati ({})", c.hidden),
            format!("Rimossi da YouTube ({})", c.removed),
            format!("Falliti ({})", c.failed),
        ];
        let Some(i) = select_back("Libreria", labels) else { return };

        match i {
            0 => menu_authors(screen),
            _ => {
                let (title, filter) = match i {
                    1 => ("Tutti i video", query::Filter::new()),
                    2 => ("Preferiti", query::Filter::new().favorite(true)),
                    3 => ("Da scaricare", query::Filter::new().category(VideoCategory::Available)),
                    4 => ("Archiviati", query::Filter::new().category(VideoCategory::Hidden)),
                    5 => ("Rimossi da YouTube", query::Filter::new().category(VideoCategory::Removed)),
                    _ => ("Falliti", query::Filter::new().category(VideoCategory::Failed)),
                };
                let videos: Vec<Video> = query::videos(&st, &filter).into_iter().cloned().collect();
                browse(screen, videos, title);
            }
        }
    }
}

fn menu_authors(screen: &mut Screen) {
    loop {
        screen.clear();
        let st = match state::read() {
            Ok(s) => s,
            Err(e) => return screen.err(e),
        };
        let authors = query::authors(&st, false);
        if authors.is_empty() {
            return screen.set("\nNessun autore in libreria.\n".to_string());
        }
        let labels: Vec<String> = authors
            .iter()
            .map(|a| {
                format!(
                    "{}  {}",
                    a.author.display_name(),
                    style(format!("({} video, {} scaricati)", a.total, a.downloaded)).dim()
                )
            })
            .collect();
        let Some(i) = select_back("Autori", labels) else { return };

        let key = authors[i].author.key().to_string();
        let name = authors[i].author.display_name();
        let videos: Vec<Video> = query::videos(&st, &query::Filter::new().author(&key))
            .into_iter()
            .cloned()
            .collect();
        browse(screen, videos, &name);
    }
}

// ── 4. Download rapido ──────────────────────────────────────────────────────

/// Console di download: il prompt resta **sempre in alto**, i download continuano
/// **sotto** mentre si incolla il link successivo.
///
/// ## Perché è scritta a mano invece di usare `dialoguer`
///
/// `dialoguer::Input` prende possesso della riga e blocca finché non si preme invio:
/// mentre digiti non si può ridisegnare nulla, quindi una lista che si aggiorna sotto
/// il prompt è impossibile. Qui l'input si legge **tasto per tasto** (`Term::read_key`)
/// e fra un tasto e l'altro si ridipinge il blocco sottostante.
///
/// Regola che tiene insieme il disegno: **una sola cosa scrive sul terminale**, questo
/// ciclo. I worker non stampano niente — riportano nello stato condiviso della coda, e
/// qui si legge lo snapshot. Senza questa regola due thread che stampano insieme
/// distruggerebbero la riga che stai scrivendo.
/// Una riga della coda — un video singolo, oppure un membro di una playlist mostrato
/// come sottovoce indentata sotto la sua voce padre.
fn job_row(s: &ondo_core::ops::JobStatus, title_len: usize) -> String {
    use ondo_core::ops::JobState;
    let titolo: String = s.title.chars().take(title_len).collect();
    match &s.state {
        JobState::Queued => format!("{}  {titolo}", style("⋯ in attesa").dim()),
        JobState::FetchingMetadata => format!("{}  {titolo}", style("⋯ scarico metadati").cyan()),
        JobState::Running { percent } => {
            let p = percent.round().clamp(0.0, 100.0) as usize;
            let barra = "█".repeat(p * 18 / 100) + &"░".repeat(18 - p * 18 / 100);
            format!("{} {p:>3}%  {titolo}", style(barra).cyan())
        }
        JobState::Done => format!("{}  {titolo}", style("✔ fatto    ").green()),
        JobState::Skipped => format!("{}  {titolo}", style("↷ saltato  ").dim()),
        JobState::Failed { message } => format!(
            "{}  {titolo}\n              {}",
            style("✘ fallito  ").red(),
            style(message.chars().take(60).collect::<String>()).red()
        ),
    }
}

/// Intestazione condivisa fra il disegno principale della console e la fase di
/// risoluzione dei link (`accoda`) — stessa posizione, mai sotto il prompt "Scarica:".
fn intestazione_download() {
    println!("{}", style("Download rapido — la coda continua mentre incolli").bold());
    println!(
        "{}",
        style("link separati da virgola · invio per accodare · ESC per uscire").dim()
    );
    println!("{}", style("─".repeat(66)).dim());
}

fn download_console(screen: &mut Screen) {
    use console::Key;
    use ondo_core::ops::{DownloadQueue, JobState};

    let workers = ondo_core::config::parallel_downloads().unwrap_or(1);
    let queue = DownloadQueue::start(workers);
    let term = Term::stdout();

    if !term.is_term() {
        // Senza un terminale vero non si può disegnare: si ricade sul flusso classico.
        queue.stop();
        return menu_quick(screen);
    }

    // Niente thread dedicato alla lettura tasti: un thread lanciato per la sola
    // durata di questa funzione non ha modo di essere interrotto a metà di un
    // `read_key()` bloccante quando si esce (nessuna cancellazione in questa
    // versione di `console`). Restava vivo dopo l'uscita e rubava il primo tasto
    // premuto altrove nella CLI (es. "Metadati grezzi"), bloccandolo — bug reale,
    // trovato dall'utente. Si torna alla lettura diretta: niente animazione senza
    // tasti premuti, ma niente thread orfani che rompono il resto della CLI.
    const SPINNER: [char; 4] = ['-', '\\', '|', '/'];
    let mut input = String::new();
    let mut spin_frame = 0usize;

    loop {
        // ── disegno ──────────────────────────────────────────────────────────
        //
        // I download si accumulano SOPRA, il prompt di digitazione resta ancorato
        // in fondo — come una console/chat, non come un modulo con l'input in cima.
        let _ = term.clear_screen();
        intestazione_download();

        let snapshot = queue.snapshot();
        if snapshot.is_empty() {
            println!("{}", style("  (nessun download)").dim());
        } else {
            let mut i = 0usize;
            // Ogni video accodato resta visibile, uno per uno: nessun limite di righe
            // né di sotto-voci per playlist, su richiesta esplicita dell'utente — vuole
            // vedere l'intera coda, non un riassunto.
            while i < snapshot.len() {
                let s = &snapshot[i];
                // Una playlist è stata accodata in blocco con lo stesso `group`: i suoi
                // membri restano contigui nello snapshot, quindi basta guardare avanti
                // per trovare dove finisce il gruppo — nessun raggruppamento globale.
                let gruppo = s.group.clone().filter(|_| {
                    i + 1 < snapshot.len() && snapshot[i + 1].group.as_deref() == s.group.as_deref()
                });
                if let Some(nome_gruppo) = gruppo {
                    let mut j = i;
                    while j < snapshot.len() && snapshot[j].group.as_deref() == Some(nome_gruppo.as_str()) {
                        j += 1;
                    }
                    let membri = &snapshot[i..j];
                    let totale = membri.len();
                    let conclusi = membri
                        .iter()
                        .filter(|m| matches!(m.state, JobState::Done | JobState::Failed { .. } | JobState::Skipped))
                        .count();
                    let p = if totale > 0 { conclusi * 100 / totale } else { 0 };
                    let barra = "█".repeat(p * 18 / 100) + &"░".repeat(18 - p * 18 / 100);
                    let nome: String = nome_gruppo.chars().take(40).collect();
                    println!("  {} {conclusi:>3}/{totale:<3}  {}", style(barra).cyan(), style(nome).bold());
                    for m in membri {
                        println!("        {}", job_row(m, 40));
                    }
                    i = j;
                } else {
                    println!("  {}", job_row(s, 44));
                    i += 1;
                }
            }
        }

        let rimasti = queue.outstanding();
        println!("{}", style("─".repeat(66)).dim());
        println!(
            "  {}",
            style(format!(
                "{rimasti} in corso o in attesa · {workers} alla volta · ^L pulisci i conclusi"
            ))
            .dim()
        );

        // Risoluzione dei link in corso in sottofondo, su tanti thread quanti i
        // download paralleli: non blocca la digitazione (vive dentro la coda, via
        // `enqueue_links`) e più link si risolvono davvero insieme, non in fila
        // dietro a uno solo. Ogni voce ha la stessa forma, risolvenda o in attesa.
        let rs = queue.resolve_status();
        for link in &rs.risolvendo {
            println!(
                "  {}  risolvo: {}",
                style(SPINNER[spin_frame % SPINNER.len()]).cyan(),
                link.chars().take(50).collect::<String>()
            );
        }
        for link in &rs.in_coda {
            println!("  {}  {}", style("⋯ in attesa").dim(), link.chars().take(50).collect::<String>());
        }
        if rs.accodati + rs.gia_in_archivio + rs.non_risolti > 0 {
            let mut riepilogo = format!("{} accodati", rs.accodati);
            if rs.gia_in_archivio > 0 {
                riepilogo.push_str(&format!(", {} già in archivio", rs.gia_in_archivio));
            }
            if rs.non_risolti > 0 {
                riepilogo.push_str(&format!(", {} non risolti", rs.non_risolti));
                if let Some(e) = &rs.ultimo_errore {
                    riepilogo.push_str(&format!(" ({})", e.chars().take(60).collect::<String>()));
                }
            }
            println!("  {}", style(riepilogo).dim());
        }
        if ondo_core::config::default_quality().map(|q| q == ondo_core::config::QualityPref::Ask).unwrap_or(false) {
            println!("  {}", style("(massima qualità — impostane una predefinita per cambiarla)").dim());
        }

        println!();
        println!("  {} {input}{}", style("Scarica:").cyan().bold(), style("█").cyan());
        spin_frame = spin_frame.wrapping_add(1);

        // ── input ────────────────────────────────────────────────────────────
        //
        // Lettura diretta e bloccante: senza un tasto premuto lo schermo non si
        // ridisegna da solo (la coda e la risoluzione continuano comunque a
        // lavorare in sottofondo, si vedono aggiornate al prossimo tasto).
        if let Ok(tasto) = term.read_key() {
            match tasto {
                Key::Escape => {
                    if rimasti > 0 {
                        let _ = term.clear_screen();
                        println!(
                            "\n{}",
                            style(format!("{rimasti} download ancora in corso.")).yellow()
                        );
                        println!(
                            "{}",
                            style("Uscendo da qui continuano finché Ondo resta aperto; chiudendo Ondo si fermano.").dim()
                        );
                        if !confirm("Uscire comunque?", false) {
                            continue;
                        }
                    }
                    queue.stop();
                    if rimasti > 0 {
                        screen.warn(format!("{rimasti} download interrotti all'uscita."));
                    }
                    return;
                }
                Key::Enter => {
                    let testo = std::mem::take(&mut input);
                    let links = ops::sources::split_links(&testo);
                    if !links.is_empty() {
                        // Nella console non si può chiedere la risoluzione per ogni video
                        // senza rompere il flusso: senza una qualità predefinita si va al
                        // massimo (si vede il promemoria sotto lo stato).
                        let (strategy, max_height) =
                            quality_without_asking().unwrap_or((AudioStrategy::Auto, Some(None)));
                        queue.enqueue_links(&links, strategy, max_height);
                    }
                }
                Key::Backspace => {
                    input.pop();
                }
                Key::Char(c) => {
                    // ^L: ripulisce i conclusi dall'elenco.
                    if c == '\u{c}' {
                        queue.clear_finished();
                    } else if !c.is_control() {
                        input.push(c);
                    }
                }
                _ => {}
            }
        }
    }
}

fn menu_quick(screen: &mut Screen) {
    screen.clear();
    println!(
        "{}",
        style(
            "Download rapido — incolla uno o più link:\n  · video YouTube (o id di 11 caratteri)\n  \
             · video di altri siti supportati da yt-dlp (Rumble, …)\n  · playlist YouTube\n\n\
             Più link insieme: separali con virgola, punto e virgola o spazio.\n\n\
             Nota: NON crea una sorgente. Questi video non verranno sincronizzati,\n\
             quindi non sapranno mai di essere stati rimossi da YouTube."
        )
        .dim()
    );
    let Some(input) = ask("Link") else { return };

    let links = ops::sources::split_links(&input);
    match links.len() {
        0 => return,
        1 => quick_single(screen, &links[0]),
        _ => quick_many(screen, &links),
    }
}

/// Più link in un colpo solo: si risolvono tutti, si mostra il totale, si scarica in
/// un'unica passata. La qualità si sceglie **una volta** per l'intero lotto — chiederla
/// per ognuno di venti video sarebbe insostenibile.
fn quick_many(screen: &mut Screen, links: &[String]) {
    screen.clear();
    println!("{}\n", style(format!("{} link da risolvere…", links.len())).bold());

    let mut ids: Vec<String> = Vec::new();
    let mut gia_scaricati = 0;
    let mut errori: Vec<String> = Vec::new();

    for (i, link) in links.iter().enumerate() {
        let breve: String = link.chars().take(70).collect();
        print!("  [{}/{}] {breve} … ", i + 1, links.len());
        let _ = std::io::stdout().flush();

        match ops::quick_download_target(link) {
            Ok(ops::QuickTarget::AlreadyDownloaded { title, .. }) => {
                println!("{}", style(format!("già in archivio ({title})")).dim());
                gia_scaricati += 1;
            }
            Ok(ops::QuickTarget::Video { id, title, .. }) => {
                println!("{}", style(title).green());
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            Ok(ops::QuickTarget::Playlist { title, ids: pl, already_downloaded }) => {
                println!(
                    "{}",
                    style(format!("playlist «{title}»: {} da scaricare, {already_downloaded} già presenti", pl.len())).green()
                );
                for id in pl {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            Err(e) => {
                println!("{}", style("errore").red());
                errori.push(format!("{breve} — {e}"));
            }
        }
    }

    println!("\n{}", style("─".repeat(60)).dim());
    println!(
        "  {} video da scaricare · {gia_scaricati} già in archivio · {} link non risolti",
        ids.len(),
        errori.len()
    );
    for e in &errori {
        println!("  {} {e}", style("✘").red());
    }

    if ids.is_empty() {
        screen.warn("Niente da scaricare.");
        return pause();
    }

    // Qualità: se è impostata si parte e basta; altrimenti si chiede una volta sola
    // per tutto il lotto, senza l'elenco per-video (che sarebbe diverso per ognuno).
    let scelta = match quality_without_asking() {
        Some(q) => Some(q),
        None => {
            println!();
            ask_quality_for_batch()
        }
    };
    let Some((strategy, max_height)) = scelta else { return };

    if !confirm(&format!("\nScaricare {} video?", ids.len()), true) {
        return;
    }
    run_download(screen, &ids, strategy, max_height);
}

/// Scelta della qualità per un lotto: non si può mostrare l'elenco delle risoluzioni
/// disponibili, perché è diverso da video a video. Si offrono i tagli standard come
/// **tetto** (`height<=N`): ogni video prende la migliore sotto quella soglia.
fn ask_quality_for_batch() -> Option<(AudioStrategy, Option<Option<u64>>)> {
    use ondo_core::config::{QualityPref, QUALITY_CHOICES};

    let scelte: Vec<QualityPref> = QUALITY_CHOICES
        .iter()
        .copied()
        .filter(|q| *q != QualityPref::Ask)
        .collect();
    let labels: Vec<String> = scelte.iter().map(|q| q.label()).collect();

    println!(
        "{}",
        style("Vale per tutti i video del lotto. Per non chiederlo più: Impostazioni → Qualità predefinita.").dim()
    );
    let i = Select::with_theme(&theme())
        .with_prompt("Qualità")
        .items(&labels)
        .default(0)
        .interact_opt()
        .ok()??;
    Some((AudioStrategy::Auto, Some(scelte[i].max_height()?)))
}

fn quick_single(screen: &mut Screen, input: &str) {
    screen.clear();
    println!("{}", style("Risoluzione del link…").dim());
    match ops::quick_download_target(input) {
        Ok(ops::QuickTarget::AlreadyDownloaded { id, title }) => {
            screen.warn(format!("Già in archivio: «{title}» ({id})."))
        }
        Ok(ops::QuickTarget::Video { id, title, formats }) => {
            println!("\n{}", style(title).bold());
            // Con una qualità predefinita si evita anche il prompt qui: incolli il
            // link e parte.
            match quality_without_asking() {
                Some((s, h)) => run_download(screen, &[id], s, h),
                None => {
                    if let Some((s, h)) = ask_quality(&formats) {
                        run_download(screen, &[id], s, h);
                    }
                }
            }
        }
        Ok(ops::QuickTarget::Playlist { title, ids, already_downloaded }) => {
            println!("\n{}", style(&title).bold());
            println!(
                "  {} da scaricare, {} già presenti\n",
                ids.len(),
                already_downloaded
            );
            if ids.is_empty() {
                screen.warn("Tutti i video della playlist sono già in archivio.");
            } else if confirm(&format!("Scaricare {} video?", ids.len()), true) {
                // In blocco si va alla massima risoluzione: chiedere per ognuno di N
                // video sarebbe insostenibile.
                run_download(screen, &ids, AudioStrategy::Auto, Some(None));
            }
        }
        Err(e) => screen.err(e),
    }
}

// ── 5. Impostazioni ─────────────────────────────────────────────────────────

fn menu_settings(screen: &mut Screen) {
    loop {
        screen.clear();
        let attuale = ondo_core::config::default_quality()
            .map(|q| q.label())
            .unwrap_or_else(|_| "?".into());

        let paralleli = ondo_core::config::parallel_downloads().unwrap_or(1);
        let vlc = match get_paths().map(|p| p.vlc_path).unwrap_or_default() {
            p if p.is_empty() => "non impostato".to_string(),
            p if std::path::Path::new(&p).is_file() => "✔ ok".to_string(),
            _ => "✘ non trovato".to_string(),
        };

        let labels = vec![
            "Stato e percorsi".to_string(),
            format!("Qualità predefinita: {attuale}"),
            format!(
                "Download in parallelo: {paralleli}{}",
                if paralleli == 1 { " (uno alla volta)" } else { "" }
            ),
            format!("Percorso di VLC: {vlc}"),
            "Salva un backup…".into(),
            "Ripristina da un backup…".into(),
            "Aggiorna le foto dei creator".into(),
            "Storico delle operazioni".into(),
            "Svuota lo storico".into(),
            "Migra dal vecchio formato".into(),
        ];
        let Some(i) = select_back("Impostazioni", labels) else { return };

        match i {
            0 => show_status(screen),
            1 => set_quality(screen),
            2 => set_parallel(screen),
            3 => set_vlc_path(screen),
            4 => backup_save(screen),
            5 => backup_restore(screen),
            6 => {
                screen.clear();
                println!("{}\n", style("Foto dei creator…").bold());
                let force = confirm("Ri-scaricare anche quelle già salvate?", false);
                println!();
                let r = TermReporter::new(true);
                let out = ops::sync_author_avatars(force, &r);
                r.finish();
                match out {
                    Ok(rep) => screen.ok(format!(
                        "{} salvate ({}), {} già presenti, {} senza foto, {} fallite.",
                        rep.saved,
                        size(Some(rep.bytes)),
                        rep.skipped,
                        rep.not_found,
                        rep.failed
                    )),
                    Err(e) => screen.err(e),
                }
                pause();
            }
            7 => {
                screen.clear();
                match ops::list_runs(30) {
                    Ok(runs) if runs.is_empty() => println!("Nessuna operazione registrata."),
                    Ok(runs) => {
                        println!("{}\n", style("Storico").bold());
                        for r in runs {
                            let icon = if r.status == "success" { style("✔").green() } else { style("✘").red() };
                            println!(
                                "  {icon} {}  {:<10}  {}",
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
            8 => {
                if confirm("Svuotare lo storico?", false) {
                    match ops::clear_runs() {
                        Ok(n) => screen.ok(format!("{n} voci rimosse.")),
                        Err(e) => screen.err(e),
                    }
                }
            }
            9 => {
                screen.clear();
                println!(
                    "{}",
                    style(
                        "Migra catalog.json + metadata.json al nuovo formato\n\
                         (library.json + sources.json + metadata/<id>.json).\n\n\
                         I file vecchi NON vengono cancellati: sono rinominati .pre-v2."
                    )
                    .dim()
                );
                if confirm("\nProcedere?", false) {
                    match ops::migrate_all() {
                        Ok(r) => {
                            let mut m = String::new();
                            if let Some(s) = &r.state {
                                m.push_str(&format!(
                                    "{} video, {} autori, {} sorgenti, {} avatar. ",
                                    s.videos, s.authors, s.sources, s.avatars
                                ));
                            }
                            m.push_str(&format!("{} file di metadati.", r.metadata_files));
                            screen.ok(m);
                        }
                        Err(e) => screen.err(e),
                    }
                }
            }
            _ => {}
        }
    }
}

// ── Qualità predefinita ─────────────────────────────────────────────────────

fn set_quality(screen: &mut Screen) {
    use ondo_core::config::{QualityPref, QUALITY_CHOICES};

    screen.clear();
    let attuale = ondo_core::config::default_quality().unwrap_or(QualityPref::Ask);

    println!("{}", style("Qualità predefinita dei download").bold());
    println!(
        "{}",
        style(
            "Con «Chiedi ogni volta» il download si ferma a domandarti la risoluzione\n\
             fra quelle davvero disponibili per quel video.\n\n\
             Con qualunque altra scelta parte SUBITO, senza interruzioni: è ciò che\n\
             permette di lanciare più istanze di Ondo in parallelo e lasciarle lavorare."
        )
        .dim()
    );
    println!(
        "\n{}",
        style(
            "Nota: saltando la domanda si salta anche il controllo dei formati, quindi\n\
             non si può sapere in anticipo se a un video manca la traccia audio separata\n\
             (caso in cui yt-dlp ripiega su 360p). Resta l'avviso a posteriori: un\n\
             download a 360p o meno viene marcato nel dettaglio del video."
        )
        .yellow()
    );
    println!();

    let labels: Vec<String> = QUALITY_CHOICES
        .iter()
        .map(|q| {
            if *q == attuale {
                format!("{}   ← attuale", q.label())
            } else {
                q.label()
            }
        })
        .collect();
    let default = QUALITY_CHOICES.iter().position(|q| *q == attuale).unwrap_or(0);

    let scelta = Select::with_theme(&theme())
        .with_prompt("Qualità predefinita")
        .items(&labels)
        .default(default)
        .interact_opt();

    let Ok(Some(i)) = scelta else { return };
    let nuova = QUALITY_CHOICES[i];
    if nuova == attuale {
        return;
    }
    match ondo_core::config::set_default_quality(nuova) {
        Ok(()) => screen.ok(format!("Qualità predefinita: {}", nuova.label())),
        Err(e) => screen.err(e),
    }
}

fn set_parallel(screen: &mut Screen) {
    screen.clear();
    let attuale = ondo_core::config::parallel_downloads().unwrap_or(1);

    println!("{}", style("Download in parallelo").bold());
    println!(
        "{}",
        style(
            "Quanti video scaricare insieme, su thread separati dello stesso processo.\n\
             I download girano in parallelo; a scrivere sul catalogo resta un thread solo,\n\
             quindi non c'è modo che due risultati si pestino i piedi."
        )
        .dim()
    );
    println!(
        "\n{}",
        style(
            "Con più di 1 sparisce la barra di avanzamento per-video (N barre insieme\n\
             sarebbero illeggibili): resta una riga di inizio e una di fine per ciascuno.\n\
             Non alzarlo troppo: ogni download è una connessione in più verso YouTube,\n\
             e oltre una certa soglia si guadagnano solo 403."
        )
        .yellow()
    );
    println!();

    let scelte: Vec<usize> = (1..=ondo_core::config::MAX_PARALLEL as usize).collect();
    let labels: Vec<String> = scelte
        .iter()
        .map(|n| {
            let base = match n {
                1 => "1 — uno alla volta (con barra di avanzamento)".to_string(),
                2 | 3 => format!("{n} — consigliato"),
                _ => n.to_string(),
            };
            if *n == attuale { format!("{base}   ← attuale") } else { base }
        })
        .collect();

    let Ok(Some(i)) = Select::with_theme(&theme())
        .with_prompt("Download simultanei")
        .items(&labels)
        .default(attuale.saturating_sub(1).min(labels.len() - 1))
        .interact_opt()
    else {
        return;
    };
    if scelte[i] == attuale {
        return;
    }
    match ondo_core::config::set_parallel_downloads(scelte[i]) {
        Ok(()) => screen.ok(format!("Download in parallelo: {}", scelte[i])),
        Err(e) => screen.err(e),
    }
}

// ── Percorso di VLC ─────────────────────────────────────────────────────────

/// Posti in cui VLC si trova di solito. Su questa macchina è nella cartella a **32
/// bit** anche su un Windows a 64 — non è un caso isolato, l'installer a 32 bit resta
/// il download predefinito dal sito di VideoLAN. Per questo non si assume un percorso
/// solo: si cercano entrambi e si propone quello che esiste davvero.
#[cfg(target_os = "windows")]
const VLC_CANDIDATI: [&str; 2] = [
    r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
    r"C:\Program Files\VideoLAN\VLC\vlc.exe",
];
#[cfg(target_os = "macos")]
const VLC_CANDIDATI: [&str; 1] = ["/Applications/VLC.app/Contents/MacOS/VLC"];
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const VLC_CANDIDATI: [&str; 3] = ["/usr/bin/vlc", "/usr/local/bin/vlc", "/snap/bin/vlc"];

fn set_vlc_path(screen: &mut Screen) {
    screen.clear();
    let attuale = get_paths().map(|p| p.vlc_path).unwrap_or_default();
    let valido = !attuale.is_empty() && std::path::Path::new(&attuale).is_file();

    println!("{}", style("Percorso di VLC").bold());
    println!(
        "{}",
        style("Serve solo per «Riproduci con VLC» dal dettaglio di un video.\nSe non lo usi, puoi lasciarlo com'è.").dim()
    );
    println!(
        "\n  attuale: {}",
        if attuale.is_empty() {
            style("(non impostato)".to_string()).dim().to_string()
        } else if valido {
            style(format!("{attuale}  ✔ trovato")).green().to_string()
        } else {
            style(format!("{attuale}  ✘ non esiste")).red().to_string()
        }
    );

    // Si propongono solo i percorsi che esistono davvero: suggerire un file assente
    // sposterebbe solo più avanti la scoperta dell'errore.
    let trovati: Vec<&str> = VLC_CANDIDATI
        .iter()
        .copied()
        .filter(|p| std::path::Path::new(p).is_file() && *p != attuale)
        .collect();

    let mut labels: Vec<String> = trovati
        .iter()
        .map(|p| format!("Usa {p}   {}", style("(trovato)").green()))
        .collect();
    labels.push("Scrivi un percorso…".to_string());

    println!();
    let Some(i) = select_back("Percorso di VLC", labels) else { return };

    let scelto = if i < trovati.len() {
        trovati[i].to_string()
    } else {
        println!(
            "\n{}",
            style("Percorso completo dell'eseguibile, virgolette comprese se lo incolli da Esplora file.").dim()
        );
        let Some(p) = ask("Percorso") else { return };
        p.trim().trim_matches('"').to_string()
    };

    if !std::path::Path::new(&scelto).is_file() {
        // Non si rifiuta: un percorso su un disco al momento scollegato è legittimo.
        // Ma si dice chiaramente, invece di scoprirlo alla prima riproduzione.
        if !confirm(
            &format!("«{scelto}» non esiste (adesso). Salvarlo lo stesso?"),
            false,
        ) {
            return;
        }
    }

    match ondo_core::config::update_config(&serde_json::json!({ "playback": { "vlcPath": scelto } })) {
        Ok(_) => screen.ok(format!("VLC: {scelto}")),
        Err(e) => screen.err(e),
    }
}

// ── Backup ──────────────────────────────────────────────────────────────────

fn backup_save(screen: &mut Screen) {
    screen.clear();
    let stima = ops::backup::estimate_size().unwrap_or(0) as u64;
    println!("{}", style("Salva un backup").bold());
    println!(
        "{}",
        style(
            "Contiene tutto lo stato TRANNE i file video (ri-scaricabili) e i cookie\n\
             (sono una credenziale, non vanno in un file che si copia in giro).\n\
             Le copertine sì: per un video rimosso da YouTube sono l'unica cosa\n\
             che non si può più recuperare."
        )
        .dim()
    );
    println!("\n  dimensione stimata: ~{}", size(Some(stima)));
    println!("  {}", style("(senza compressione: lo ZIP pesa quanto la somma dei file)").dim());

    let default = ops::suggested_filename();
    println!("\n  invio = «{default}» nella cartella del progetto\n");
    let raw: String = match Input::with_theme(&theme())
        .with_prompt("Percorso del file")
        .allow_empty(true)
        .interact_text()
    {
        Ok(v) => v,
        Err(_) => return,
    };
    let target = if raw.trim().is_empty() {
        get_paths().map(|p| p.project_root.join(&default)).unwrap_or_else(|_| default.clone().into())
    } else {
        std::path::PathBuf::from(raw.trim())
    };

    if target.exists() && !confirm(&format!("«{}» esiste già: sovrascrivere?", target.display()), false) {
        return;
    }

    println!("\n{}", style("Creazione dell'archivio…").dim());
    match ops::write_backup_to(&target) {
        Ok(r) => screen.ok(format!(
            "Backup salvato in {}\n  {} ({} video, {} autori, {} sorgenti, {} metadati, {} copertine)",
            target.display(),
            size(Some(r.bytes as u64)),
            r.videos,
            r.authors,
            r.sources,
            r.metadata_files,
            r.covers
        )),
        Err(e) => screen.err(e),
    }
    pause();
}

fn backup_restore(screen: &mut Screen) {
    screen.clear();
    println!("{}", style("Ripristina da un backup").bold());
    println!(
        "{}",
        style(
            "Lo stato attuale viene prima COPIATO in data/pre-restore-<data-ora>/:\n\
             se il ripristino si rivela un errore, la strada indietro esiste ancora.\n\
             I file che nell'archivio non ci sono NON vengono cancellati."
        )
        .dim()
    );

    let Some(raw) = ask("\nPercorso del file .zip") else { return };
    let path = std::path::PathBuf::from(raw.trim().trim_matches('"'));
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return screen.err(format!("Impossibile leggere {}: {e}", path.display())),
    };

    // Si mostra cosa c'è dentro PRIMA di sovrascrivere qualunque cosa.
    match ops::inspect_backup(&bytes) {
        Ok((manifest, files, total)) => {
            println!("\n  {files} file, {} in tutto", size(Some(total as u64)));
            if let Some(m) = manifest {
                if let Some(created) = m.get("createdAt").and_then(|v| v.as_str()) {
                    println!("  creato il {created}");
                }
                if let Some(c) = m.get("counts") {
                    println!(
                        "  {} video · {} autori · {} sorgenti",
                        c.get("videos").and_then(|v| v.as_u64()).unwrap_or(0),
                        c.get("authors").and_then(|v| v.as_u64()).unwrap_or(0),
                        c.get("sources").and_then(|v| v.as_u64()).unwrap_or(0)
                    );
                }
            } else {
                println!("  {}", style("(nessun manifesto: forse un backup della versione JavaScript)").dim());
            }
        }
        Err(e) => return screen.err(e),
    }

    if !confirm("\nRipristinare, sostituendo lo stato attuale?", false) {
        return;
    }

    match ops::restore_backup(&bytes) {
        Ok(r) => {
            let mut m = format!("{} file ripristinati.", r.restored_files);
            if let Some(dir) = &r.safety_copy {
                m.push_str(&format!("\n  Copia di sicurezza in {}", dir.display()));
            }
            if !r.skipped.is_empty() {
                m.push_str(&format!(
                    "\n  {} voci ignorate perché fuori dalle cartelle previste: {}",
                    r.skipped.len(),
                    r.skipped.join(", ")
                ));
            }
            m.push_str("\n\n  ⚠ RIAVVIA il programma: lo stato in memoria è ormai vecchio.");
            screen.ok(m);
        }
        Err(e) => screen.err(e),
    }
    pause();
}

fn show_status(screen: &mut Screen) {
    screen.clear();
    let paths = match get_paths() {
        Ok(p) => p,
        Err(e) => return screen.err(e),
    };

    println!("{}", style("Percorsi").bold());
    println!("  progetto   {}", paths.project_root.display());
    println!("  stato      {}", paths.data_dir.display());
    println!("  video      {}", paths.videos_dir.display());
    println!("  copertine  {}", paths.covers_dir.display());
    println!("  autori     {}", paths.authors_dir.display());
    println!("  strumenti  {}", paths.tools_dir.display());
    println!(
        "  cookie     {}",
        paths.cookies_path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "assenti".into())
    );

    if let Ok(st) = state::read() {
        let c = query::counts(&st);
        println!(
            "\n{}\n  {} video · {} autori · {} sorgenti",
            style("Libreria").bold(),
            c.total,
            st.authors.len(),
            st.sources.len()
        );
        println!("  {} scaricati ({})", c.downloaded, size(Some(c.bytes)));
        println!(
            "  {} da scaricare · {} archiviati · {} rimossi · {} falliti",
            c.available, c.hidden, c.removed, c.failed
        );
        if let Ok((n, bytes)) = metadata::stats() {
            println!("  {n} con metadati grezzi ({})", size(Some(bytes)));
        }
    }

    match check_tools() {
        Ok(s) if s.ok => {
            println!("\n{}", style("Strumenti").bold());
            println!("  {} yt-dlp  {}", style("✔").green(), ondo_core::downloader::get_ytdlp_version().unwrap_or_default());
            println!("  {} ffmpeg  {}", style("✔").green(), s.ffmpeg_source.unwrap_or_default());
        }
        Ok(s) => {
            println!("\n{}", style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow());
            for m in &s.messages {
                println!("  • {m}");
            }
            println!("\n  Rimedio: npm run setup");
        }
        Err(e) => println!("\n{} {e}", style("✘").red()),
    }
    println!("\n  ondo-core {}\n", ondo_core::VERSION);
    pause();
}

// ── Menu principale ─────────────────────────────────────────────────────────

fn main() {
    let mut screen = Screen::new();

    // Migrazione: si segnala, non si esegue di nascosto. Toccare i dati dell'utente
    // senza che lo abbia chiesto non è mai la scelta giusta.
    if library::migration_pending().unwrap_or(false) {
        screen.set(format!(
            "\n{}\n  Vai in Impostazioni → «Migra dal vecchio formato».\n  \
             I file attuali non vengono cancellati.\n",
            style("⇪  Trovato un catalog.json nel formato vecchio.").cyan()
        ));
    } else if let Ok(status) = check_tools() {
        if !status.ok {
            screen.set(format!(
                "\n{}\n\n{}\n\n  Rimedio: npm run setup\n",
                style("⚠  Installazione incompleta — i download NON funzioneranno.").yellow(),
                status.messages.iter().map(|m| format!("  • {m}")).collect::<Vec<_>>().join("\n\n")
            ));
        }
    }

    let entries: [(&str, fn(&mut Screen)); 5] = [
        ("Cerca", menu_search),
        ("Sorgenti", menu_sources),
        ("Libreria", menu_library),
        ("Download rapido", download_console),
        ("Impostazioni", menu_settings),
    ];

    loop {
        screen.clear();
        let mut labels: Vec<String> = entries.iter().map(|(n, _)| n.to_string()).collect();
        labels.push("Esci".into());
        match Select::with_theme(&theme())
            .with_prompt("Ondo")
            .items(&labels)
            .default(0)
            .interact_opt()
        {
            Ok(Some(i)) if i < entries.len() => entries[i].1(&mut screen),
            _ => break,
        }
    }
    println!("Ciao!");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(dur(None), "--:--");
        assert_eq!(dur(Some(0.0)), "--:--");
        assert_eq!(dur(Some(59.0)), "0:59");
        assert_eq!(dur(Some(212.0)), "3:32");
        assert_eq!(dur(Some(3725.0)), "1:02:05");
    }

    #[test]
    fn sizes_switch_unit_at_one_gigabyte() {
        assert_eq!(size(None), "—");
        assert_eq!(size(Some(343 * 1_048_576)), "343 MB");
        assert_eq!(size(Some(2 * 1_073_741_824)), "2.0 GB");
    }

    #[test]
    fn video_line_shows_state_favourite_author_and_duration() {
        let v = Video::from_value(serde_json::json!({
            "id": "abc", "title": "Titolo", "presence": "present", "download": "downloaded",
            "hidden": false, "favorite": true, "channel": { "name": "Creator" },
            "durationSeconds": 212
        }))
        .unwrap();
        let l = console::strip_ansi_codes(&video_line(&v)).to_string();
        assert!(l.contains("scaricato") && l.contains("preferito") && l.contains("Titolo"));
        assert!(l.contains("Creator") && l.contains("3:32"));
    }
}
