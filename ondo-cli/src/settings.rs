//! Impostazioni: stato e percorsi, qualità predefinita, parallelismo.
//!
//! Tutto finisce in `<radice>/config.json` tramite `ondo::Config`.

use std::path::PathBuf;

use console::style;
use dialoguer::{Input, Select};
use ondo::Filter;

use crate::ui::{self, screen, R};
use crate::App;

pub fn open(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Impostazioni", &mut app.message);

        let voci = vec![
            "Stato e percorsi".to_string(),
            format!("Qualità predefinita: {}", app.lib.config().quality.label()),
            format!("Download in parallelo: {}", app.lib.config().parallel),
            "← indietro".to_string(),
        ];
        match Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()? {
            Some(0) => paths(app)?,
            Some(1) => quality(app)?,
            Some(2) => parallel(app)?,
            _ => return Ok(()),
        }
    }
}

fn quality(app: &mut App) -> R<()> {
    screen("Qualità predefinita", &mut app.message);
    println!(
        "Vale per i download futuri. «Chiedi ogni volta» fa comparire la scelta della\nrisoluzione appena lanci un download, link per link.\n\nLa qualità più alta viene comunque esclusa se è in AV1: alla stessa risoluzione\ndava 403 sistematici.\n"
    );
    let voci: Vec<String> = ui::LIVELLI.iter().map(|q| q.label()).collect();
    let attuale = ui::LIVELLI.iter().position(|q| *q == app.lib.config().quality).unwrap_or(0);
    if let Some(i) = Select::with_theme(&ui::theme()).items(&voci).default(attuale).interact_opt()? {
        app.lib.config_mut().quality = ui::LIVELLI[i];
        app.lib.save_config()?;
        ui::ok(&mut app.message, format!("qualità predefinita: {}", voci[i]));
    }
    Ok(())
}

/// Un menu, non un campo di testo: da un campo con validazione non si esce senza
/// aver dato un valore valido, e uscire deve essere sempre possibile.
fn parallel(app: &mut App) -> R<()> {
    const SCELTE: [usize; 8] = [1, 2, 3, 4, 5, 6, 8, 12];

    screen("Download in parallelo", &mut app.message);
    println!("Quanti sentinel insieme. Vale subito.\n");

    let attuale = app.lib.config().parallel;
    let mut voci: Vec<String> = SCELTE.iter().map(|n| n.to_string()).collect();
    voci.push("← indietro".into());
    let default = SCELTE.iter().position(|n| *n == attuale).unwrap_or(2);

    let Some(i) = Select::with_theme(&ui::theme()).items(&voci).default(default).interact_opt()? else {
        return Ok(());
    };
    if i >= SCELTE.len() {
        return Ok(());
    }
    let n = SCELTE[i];
    app.lib.config_mut().parallel = n;
    app.lib.save_config()?;
    // A caldo: alzarlo fa partire subito altri worker, abbassarlo congeda quelli in
    // eccesso quando hanno finito, senza interrompere niente.
    app.dl.set_parallel(n);
    ui::ok(&mut app.message, format!("{n} download in parallelo"));
    Ok(())
}

fn paths(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Stato e percorsi", &mut app.message);
        stato(app);

        println!("{}\n", style("Invio senza cambiare niente lascia il valore com'è.").dim());
        let cfg = app.lib.config();
        let voci = vec![
            format!("Cartella video: {}", cfg.videos.display()),
            format!("Cartella metadati: {}", cfg.metadata.display()),
            format!("VLC: {}", cfg.vlc.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "non configurato".into())),
            format!("Cookie: {}", cfg.cookies.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "nessuno".into())),
            "← indietro".to_string(),
        ];
        match Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()? {
            Some(0) => {
                let attuale = app.lib.config().videos.display().to_string();
                if let Some(nuovo) = chiedi("Cartella video (relativa alla radice, o assoluta)", &attuale)? {
                    if nuovo.is_empty() {
                        ui::err(&mut app.message, "la cartella dei video non può essere vuota");
                        continue;
                    }
                    app.lib.config_mut().videos = PathBuf::from(nuovo);
                    app.lib.save_config()?;
                    ui::ok(
                        &mut app.message,
                        "cambiata. I file già scaricati NON vengono spostati: spostali a mano se serve.",
                    );
                } else {
                    ui::ok(&mut app.message, "invariata");
                }
            }
            Some(1) => {
                let attuale = app.lib.config().metadata.display().to_string();
                if let Some(nuovo) = chiedi("Cartella metadati", &attuale)? {
                    if nuovo.is_empty() {
                        ui::err(&mut app.message, "la cartella dei metadati non può essere vuota");
                        continue;
                    }
                    app.lib.config_mut().metadata = PathBuf::from(nuovo);
                    app.lib.save_config()?;
                    ui::ok(&mut app.message, "cambiata. I metadati già salvati NON vengono spostati.");
                } else {
                    ui::ok(&mut app.message, "invariata");
                }
            }
            Some(2) => {
                let attuale = percorso(app.lib.config().vlc.as_deref());
                if let Some(nuovo) = chiedi("Eseguibile di VLC (vuoto = nessuno)", &attuale)? {
                    app.lib.config_mut().vlc = (!nuovo.is_empty()).then(|| PathBuf::from(&nuovo));
                    app.lib.save_config()?;
                    match &app.lib.config().vlc {
                        Some(p) if !p.is_file() => {
                            ui::err(&mut app.message, format!("salvato, ma non c'è niente in {}", p.display()))
                        }
                        Some(_) => ui::ok(&mut app.message, "VLC impostato"),
                        None => ui::ok(&mut app.message, "VLC dimenticato"),
                    }
                } else {
                    ui::ok(&mut app.message, "invariato");
                }
            }
            Some(3) => {
                let attuale = percorso(app.lib.config().cookies.as_deref());
                if let Some(nuovo) = chiedi("File cookie in formato Netscape (vuoto = nessuno)", &attuale)? {
                    app.lib.config_mut().cookies = (!nuovo.is_empty()).then(|| PathBuf::from(&nuovo));
                    app.lib.save_config()?;
                    ui::ok(
                        &mut app.message,
                        "salvato. I cookie si usano solo come ripiego, dopo un primo tentativo senza.",
                    );
                } else {
                    ui::ok(&mut app.message, "invariato");
                }
            }
            _ => return Ok(()),
        }
    }
}

/// Chiede un percorso, partendo da quello attuale già scritto nel campo.
///
/// `None` = non è stato cambiato niente. Serve perché `dialoguer` non sa annullare
/// un campo di testo: senza questo, entrare per sbaglio in una voce vorrebbe dire
/// non poterne uscire senza aver scritto qualcosa.
fn chiedi(prompt: &str, attuale: &str) -> R<Option<String>> {
    let nuovo: String = Input::with_theme(&ui::theme())
        .with_prompt(prompt)
        .with_initial_text(attuale)
        .allow_empty(true)
        .interact_text()?;
    let nuovo = nuovo.trim().to_string();
    Ok((nuovo != attuale.trim()).then_some(nuovo))
}

fn percorso(p: Option<&std::path::Path>) -> String {
    p.map(|p| p.display().to_string()).unwrap_or_default()
}

/// Il pannello informativo: dove sono le cose e se esistono davvero.
fn stato(app: &App) {
    let cfg = app.lib.config();
    let riga = |k: &str, p: &std::path::Path| {
        let segno = if p.exists() { style("●").green() } else { style("○").red() };
        println!("  {segno} {:<12} {}", style(k).dim(), p.display());
    };
    println!("{}", style("percorsi").bold());
    riga("radice", &cfg.root);
    riga("video", &cfg.videos_dir());
    riga("copertine", &cfg.covers_dir());
    riga("metadati", &cfg.metadata_dir());
    println!("{}", style("binari").bold());
    riga("yt-dlp", &cfg.ytdlp);
    riga("ffmpeg", &cfg.ffmpeg);
    riga("ffprobe", &cfg.ffprobe);
    match ondo::config::in_path("node") {
        Some(p) => riga("node", &p),
        None => println!(
            "  {} {:<12} {}",
            style("○").red(),
            style("node").dim(),
            style("non trovato nel PATH: yt-dlp senza runtime JS dà 403").red()
        ),
    }
    if let Some(vlc) = &cfg.vlc {
        riga("vlc", vlc);
    }
    println!("{}", style("libreria").bold());
    println!(
        "    {} video · {} scaricati · {} da scaricare · {} falliti · {} link in coda",
        app.lib.len(),
        app.lib.count(Filter::Downloaded),
        app.lib.count(Filter::Pending),
        app.lib.count(Filter::Failed),
        app.lib.queue().len()
    );
    let mancanti = app.lib.missing_files().len();
    if mancanti > 0 {
        println!("    {}", style(format!("{mancanti} file dati per scaricati non sono al loro posto")).red());
    }
    println!();
}
