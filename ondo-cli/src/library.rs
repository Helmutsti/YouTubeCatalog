//! Il menu Libreria: le viste, e le azioni su un singolo video.

use console::style;
use dialoguer::{Confirm, Select};
use ondo::{Filter, Mode, State};

use crate::ui::{self, screen, R};
use crate::App;

pub fn open(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Libreria", &mut app.message);

        let da_scaricare = app.lib.count(Filter::Pending) + app.lib.queue().iter().filter(|q| q.error.is_none()).count();
        let falliti = app.lib.count(Filter::Failed) + app.lib.queue().iter().filter(|q| q.error.is_some()).count();
        let voci = vec![
            format!("Tutti i video ({})", app.lib.count(Filter::All)),
            format!("Autori ({})", app.lib.authors().len()),
            format!("Preferiti ({})", app.lib.count(Filter::Favorites)),
            format!("Da scaricare ({da_scaricare})"),
            format!("Archiviati ({})", app.lib.count(Filter::Archived)),
            format!("Rimossi da YouTube ({})", app.lib.count(Filter::Removed)),
            format!("Falliti ({falliti})"),
            "← indietro".to_string(),
        ];

        match Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()? {
            Some(0) => list_view(app, Filter::All)?,
            Some(1) => authors_view(app)?,
            Some(2) => list_view(app, Filter::Favorites)?,
            Some(3) => pending_view(app)?,
            Some(4) => list_view(app, Filter::Archived)?,
            Some(5) => list_view(app, Filter::Removed)?,
            Some(6) => failed_view(app)?,
            _ => return Ok(()),
        }
    }
}

/// Una vista semplice: elenco di video, si scelgono per agire.
fn list_view(app: &mut App, filter: Filter) -> R<()> {
    loop {
        app.pump(|_| {});
        let titolo = format!("Libreria · {}", filter.label());
        screen(&titolo, &mut app.message);

        let video = app.lib.list(filter);
        if video.is_empty() {
            println!("Non c'è niente qui.\n");
        }
        let ids: Vec<String> = video.iter().map(|v| v.id.clone()).collect();
        let mut voci: Vec<String> = video.iter().map(|v| ui::video_line(v)).collect();
        voci.push("← indietro".into());

        match Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()? {
            Some(i) if i < ids.len() => actions(app, &ids[i])?,
            _ => return Ok(()),
        }
    }
}

fn authors_view(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Libreria · autori", &mut app.message);

        let autori = app.lib.authors();
        let mut voci: Vec<String> = autori.iter().map(|(a, n)| format!("{a}  ({n})")).collect();
        voci.push("← indietro".into());

        let scelta = Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()?;
        let Some(i) = scelta.filter(|i| *i < autori.len()) else { return Ok(()) };
        let autore = autori[i].0.clone();

        loop {
            app.pump(|_| {});
            screen(&format!("Libreria · {autore}"), &mut app.message);
            let video = app.lib.by_author(&autore);
            let ids: Vec<String> = video.iter().map(|v| v.id.clone()).collect();
            let mut voci: Vec<String> = video.iter().map(|v| ui::video_line(v)).collect();
            voci.push("← indietro".into());

            match Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()? {
                Some(i) if i < ids.len() => actions(app, &ids[i])?,
                _ => break,
            }
        }
    }
}

/// "Da scaricare" mette insieme due cose che per l'utente sono la stessa: i video
/// risolti che aspettano il disco, e i link appena incollati che non hanno ancora
/// un id.
fn pending_view(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Libreria · da scaricare", &mut app.message);

        // Chi sta scaricando adesso va in cima e lo dice: sta succedendo, non è in
        // attesa come gli altri. `sort_by_key` è stabile, quindi dentro i due
        // gruppi resta l'ordine di `list`.
        let mut video = app.lib.list(Filter::Pending);
        video.sort_by_key(|v| v.state != State::Downloading);

        let ids: Vec<String> = video.iter().map(|v| v.id.clone()).collect();
        let mut voci: Vec<String> = video
            .iter()
            .map(|v| {
                let tag = if v.state == State::Downloading { "In download" } else { "In attesa" };
                ui::video_line_tagged(v, tag)
            })
            .collect();
        let links: Vec<String> = app
            .lib
            .queue()
            .iter()
            .filter(|q| q.error.is_none())
            .map(|q| q.url.clone())
            .collect();
        for url in &links {
            voci.push(format!("{} {url}  {}", style("○").yellow(), style("da risolvere").cyan()));
        }

        let scarica_tutti = !ids.is_empty() || !links.is_empty();
        if scarica_tutti {
            voci.insert(0, format!("Scarica tutti ({})", ids.len() + links.len()));
        } else {
            println!("Niente in attesa.\n");
        }
        voci.push("← indietro".into());

        let scelta = Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()?;
        let offset = usize::from(scarica_tutti);
        match scelta {
            Some(0) if scarica_tutti => {
                // La risoluzione si chiede **una volta** per tutto il gruppo:
                // chiederla per ognuno sarebbe un interrogatorio.
                let Some(cap) = ui::resolve_quality(app.lib.config().quality, "Che risoluzione, per tutti?")?
                else {
                    continue;
                };
                let mut n = 0;
                let mut in_corso = 0;
                for id in &ids {
                    // Chi sta già scaricando si lascia in pace: rimetterlo in coda
                    // vorrebbe dire un secondo sentinel sullo stesso video.
                    if app.lib.get(id).map(|v| v.state == State::Downloading).unwrap_or(false) {
                        in_corso += 1;
                        continue;
                    }
                    if let Ok(Some(url)) = app.lib.retry(id) {
                        if !url.is_empty() {
                            app.dl.push_with(url, cap);
                            n += 1;
                        }
                    }
                }
                for url in &links {
                    app.dl.push_with(url.clone(), cap);
                    n += 1;
                }
                let salta = if in_corso > 0 { format!(" ({in_corso} già in corso, lasciati stare)") } else { String::new() };
                ui::ok(&mut app.message, format!("{n} accodati{salta} — guardali in «Download rapido»"));
            }
            Some(i) if i >= offset && i - offset < ids.len() => actions(app, &ids[i - offset].clone())?,
            Some(i) if i >= offset + ids.len() && i - offset - ids.len() < links.len() => {
                let url = links[i - offset - ids.len()].clone();
                link_actions(app, &url)?;
            }
            _ => return Ok(()),
        }
    }
}

/// I falliti, con il loro motivo: video che hanno provato e link che non si sono
/// nemmeno lasciati risolvere.
fn failed_view(app: &mut App) -> R<()> {
    loop {
        app.pump(|_| {});
        screen("Libreria · falliti", &mut app.message);

        let video = app.lib.list(Filter::Failed);
        let ids: Vec<String> = video.iter().map(|v| v.id.clone()).collect();
        // Una voce di menu resta su **una** riga: `dialoguer` misura le voci per
        // disegnare la selezione, e una voce a due righe gli fa perdere il conto.
        let mut voci: Vec<String> = video
            .iter()
            .map(|v| {
                format!(
                    "{}  {}",
                    ui::video_line(v),
                    style(motivo(v.error.as_deref())).red().dim()
                )
            })
            .collect();
        let links: Vec<String> = app
            .lib
            .queue()
            .iter()
            .filter(|q| q.error.is_some())
            .map(|q| q.url.clone())
            .collect();
        for q in app.lib.queue().iter().filter(|q| q.error.is_some()) {
            voci.push(format!(
                "{} {}  {}",
                style("✗").red(),
                q.url,
                style(motivo(q.error.as_deref())).red().dim()
            ));
        }
        if voci.is_empty() {
            println!("Nessun fallimento.\n");
        }
        voci.push("← indietro".into());

        match Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()? {
            Some(i) if i < ids.len() => actions(app, &ids[i].clone())?,
            Some(i) if i - ids.len() < links.len() => {
                let url = links[i - ids.len()].clone();
                link_actions(app, &url)?;
            }
            _ => return Ok(()),
        }
    }
}

/// Il motivo di un fallimento ridotto a una riga: quello che serve per capire
/// *quale* fallimento è. Per intero si vede in «Dettagli».
fn motivo(error: Option<&str>) -> String {
    let testo = error.unwrap_or("motivo non registrato").replace(['\n', '\r'], " ");
    // Il pezzo utile di un errore di yt-dlp sta dopo `ERROR:`.
    let testo = match testo.split_once("ERROR:") {
        Some((_, dopo)) => dopo.trim().to_string(),
        None => testo,
    };
    if testo.chars().count() > 60 {
        format!("{}…", testo.chars().take(59).collect::<String>())
    } else {
        testo
    }
}

/// Cosa si può fare con un link che non è (ancora) un video.
fn link_actions(app: &mut App, url: &str) -> R<()> {
    screen("Link in coda", &mut app.message);
    println!("{url}\n");
    let voci = ["Riprova adesso", "Toglilo dalla coda", "← indietro"];
    match Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()? {
        Some(0) => {
            let Some(cap) = ui::resolve_quality(app.lib.config().quality, "Che risoluzione?")? else {
                return Ok(());
            };
            app.dl.push_with(url.to_string(), cap);
            ui::ok(&mut app.message, "accodato");
        }
        Some(1) => {
            app.lib.dequeue(url)?;
            ui::ok(&mut app.message, "togliato dalla coda");
        }
        _ => {}
    }
    Ok(())
}

/// Le azioni su un video, contestuali al suo stato. Usata anche dalla ricerca:
/// un solo posto dove si decide cosa si può fare con un video.
///
/// Le statistiche stanno **in alto**, sopra le voci: è quello che si vuole sapere
/// prima di decidere, e rende inutile una voce «Dettagli».
pub fn actions(app: &mut App, id: &str) -> R<()> {
    loop {
        app.pump(|_| {});
        let Some(v) = app.lib.get(id).cloned() else {
            return Ok(());
        };
        screen(&format!("{} — {}", v.author, v.title), &mut app.message);
        statistiche(app, &v);

        // Le voci si costruiscono in base allo stato: niente azioni impossibili da
        // scegliere e poi rifiutare. Senza icone, come il resto dei menu.
        let mut voci: Vec<String> = Vec::new();
        let mut azioni: Vec<Azione> = Vec::new();
        if v.state == State::Downloaded {
            voci.push("Riproduci".into());
            azioni.push(Azione::Play);
            voci.push("Solo audio".into());
            azioni.push(Azione::Audio);
        }
        if matches!(v.state, State::Pending | State::Failed) {
            voci.push("Scarica ora".into());
            azioni.push(Azione::Scarica);
        }
        voci.push(if v.favorite { "Togli dai preferiti".into() } else { "Aggiungi ai preferiti".to_string() });
        azioni.push(Azione::Preferito(!v.favorite));
        voci.push(if v.archived { "Ripristina".into() } else { "Archivia".to_string() });
        azioni.push(Azione::Archivia(!v.archived));
        voci.push("Togli dalla libreria".into());
        azioni.push(Azione::Rimuovi);
        voci.push("← indietro".into());

        let scelta = Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()?;
        let Some(i) = scelta.filter(|i| *i < azioni.len()) else { return Ok(()) };

        match azioni[i] {
            Azione::Play => match app.lib.play(id, Mode::Video) {
                Ok(()) => ui::ok(&mut app.message, "VLC avviato"),
                Err(e) => ui::err(&mut app.message, e),
            },
            Azione::Audio => match app.lib.play(id, Mode::Audio) {
                Ok(()) => ui::ok(&mut app.message, "VLC avviato (solo audio)"),
                Err(e) => ui::err(&mut app.message, e),
            },
            Azione::Scarica => {
                // Se la qualità è «chiedi ogni volta», si chiede adesso: è il
                // momento in cui il download parte.
                let Some(cap) = ui::resolve_quality(app.lib.config().quality, "Che risoluzione?")? else {
                    continue;
                };
                match app.lib.retry(id)? {
                    Some(url) if !url.is_empty() => {
                        app.dl.push_with(url, cap);
                        ui::ok(&mut app.message, "accodato — guardalo in «Download rapido»");
                    }
                    _ => ui::err(&mut app.message, "questo video non ha un URL da riscaricare"),
                }
            }
            Azione::Preferito(on) => {
                app.lib.set_favorite(id, on)?;
                ui::ok(&mut app.message, if on { "nei preferiti" } else { "togliato dai preferiti" });
            }
            Azione::Archivia(on) => {
                app.lib.set_archived(id, on)?;
                ui::ok(&mut app.message, if on { "archiviato" } else { "ripristinato" });
            }
            Azione::Rimuovi => {
                let conferma = Confirm::with_theme(&ui::theme())
                    .with_prompt(format!("Togliere «{}» dalla libreria?", v.title))
                    .default(false)
                    .interact()?;
                if conferma {
                    let anche_file = v.state == State::Downloaded
                        && Confirm::with_theme(&ui::theme())
                            .with_prompt("Cancellare anche il file dal disco?")
                            .default(false)
                            .interact()?;
                    app.lib.remove(id, anche_file)?;
                    ui::ok(
                        &mut app.message,
                        if anche_file { "togliato, file cancellato" } else { "togliato dalla libreria" },
                    );
                    return Ok(());
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Azione {
    Play,
    Audio,
    Scarica,
    Preferito(bool),
    Archivia(bool),
    Rimuovi,
}

/// Le statistiche del video, sopra le voci del menu.
fn statistiche(app: &App, v: &ondo::Video) {
    let riga = |k: &str, val: String| println!("  {:<12} {val}", style(k).dim());
    riga("stato", style(v.state.label()).cyan().to_string());
    riga("durata", v.duration_label());
    riga("pubblicato", v.upload_date.clone().unwrap_or_else(|| "—".into()));
    riga(
        "risoluzione",
        match (v.width, v.height) {
            (Some(w), Some(h)) => {
                let fps = v.fps.map(|f| format!(" @ {f:.0}fps")).unwrap_or_default();
                format!("{w}×{h}{fps}")
            }
            _ => "—".into(),
        },
    );
    if v.size_bytes > 0 {
        riga("dimensione", ui::size_label(v.size_bytes));
    }
    riga("url", v.url.clone());
    if v.state == State::Downloaded {
        let file = app.lib.file_path(v);
        let manca = if file.is_file() { String::new() } else { style("  (non è al suo posto)").red().to_string() };
        riga("file", format!("{}{manca}", file.display()));
    }
    if !v.tags.is_empty() {
        let tag: Vec<&str> = v.tags.iter().take(8).map(String::as_str).collect();
        riga("tag", tag.join(", "));
    }
    if let Some(e) = &v.error {
        riga("errore", style(e).red().to_string());
        riga("tentativi", v.attempts.to_string());
    }
    println!();
}
