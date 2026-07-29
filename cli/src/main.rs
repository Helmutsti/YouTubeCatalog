//! # ondo — la CLI
//!
//! Menu navigabili con le frecce sopra la libreria. Nessuna logica di dominio qui:
//! ogni voce chiama una funzione di `ondo` e mostra il risultato.
//!
//! ```text
//! Cerca · Libreria · Download rapido · Impostazioni · ← Esci
//! ```

mod library;
mod quick;
mod search;
mod settings;
mod ui;

use std::time::Duration;

use console::style;
use dialoguer::Select;
use ondo::{Downloader, Library, Update};

use ui::{screen, R};

/// Lo stato dell'applicazione: la libreria, **un solo** pool di download che vive
/// quanto la CLI, e il messaggio da mostrare al prossimo ridisegno.
pub struct App {
    pub lib: Library,
    pub dl: Downloader,
    pub message: Option<String>,
}

impl App {
    /// Applica tutto quello che i sentinel hanno detto da quando l'abbiamo chiesto
    /// l'ultima volta. Non blocca.
    ///
    /// Va chiamata a ogni giro di menu: mentre un menu aspetta un tasto nessuno
    /// legge il canale, quindi lo stato di un download che finisce in quel momento
    /// viene registrato appena l'utente si muove (o subito, se è aperta la console
    /// del Download rapido, che invece pompa in continuazione).
    pub fn pump(&mut self, mut on: impl FnMut(&Update)) {
        while let Some(update) = self.dl.try_recv() {
            if let Err(e) = self.lib.apply(&update) {
                ui::err(&mut self.message, e);
            }
            on(&update);
        }
    }

    /// Accoda un link con la qualità predefinita: prima in libreria (così
    /// sopravvive a una chiusura), poi al pool. Ritorna il numero del job, con cui
    /// seguirlo negli aggiornamenti.
    pub fn enqueue(&mut self, url: &str) -> Option<u64> {
        let cap = self.lib.config().quality.max_height();
        self.enqueue_with(url, cap)
    }

    /// Come [`App::enqueue`], ma con la risoluzione decisa per **questo** download
    /// (`None` = la migliore disponibile).
    ///
    /// La scelta vive solo nel pool: se la CLI si chiude prima che il link parta,
    /// resta in coda in `library.json` senza il tetto, e al giro dopo si userà la
    /// qualità predefinita.
    pub fn enqueue_with(&mut self, url: &str, max_height: Option<u32>) -> Option<u64> {
        if let Err(e) = self.lib.enqueue(url) {
            ui::err(&mut self.message, e);
            return None;
        }
        Some(self.dl.push_with(url, max_height))
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{} {e}", style("✗").red());
        std::process::exit(1);
    }
}

fn run() -> R<()> {
    let root = ondo::config::find_root(None);
    let lib = Library::open(&root)?;
    let dl = Downloader::start(lib.config());
    let mut app = App { lib, dl, message: None };

    // I binari esterni si controllano una volta all'avvio: scoprire che manca
    // yt-dlp a metà del primo download è un modo inutilmente crudele di dirlo.
    let mut mancanti = Vec::new();
    for (nome, path) in [
        ("yt-dlp", app.lib.config().ytdlp.clone()),
        ("ffmpeg", app.lib.config().ffmpeg.clone()),
        ("ffprobe", app.lib.config().ffprobe.clone()),
    ] {
        if !path.is_file() {
            mancanti.push(format!("{nome} ({})", path.display()));
        }
    }
    // Non un binario nostro e non un runtime in particolare: yt-dlp ha bisogno di
    // eseguire il JavaScript del player di YouTube, e gli va bene uno qualunque fra
    // deno, node, quickjs e bun. Senza nessuno dei quattro i download YouTube
    // muoiono a metà con 403, che è la causa più frequente di fallimenti
    // inspiegabili — meglio dirlo all'avvio.
    if ondo::config::js_runtime().is_none() {
        mancanti.push(format!(
            "un runtime JavaScript per yt-dlp ({})",
            ondo::config::JS_RUNTIME_NAMES.join(", ")
        ));
    }
    if !mancanti.is_empty() {
        ui::err(
            &mut app.message,
            format!("non trovo: {}. I download falliranno.", mancanti.join(", ")),
        );
    }

    loop {
        app.pump(|_| {});
        let titolo = format!(
            "ondo · {} video in {}{}",
            app.lib.len(),
            root.display(),
            attivi(&app)
        );
        screen(&titolo, &mut app.message);

        let voci = ["Cerca", "Libreria", "Download rapido", "Impostazioni", "← Esci"];
        let scelta = Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()?;

        match scelta {
            Some(0) => search::open(&mut app)?,
            Some(1) => library::open(&mut app)?,
            Some(2) => quick::open(&mut app)?,
            Some(3) => settings::open(&mut app)?,
            Some(4) | None => {
                if esci(&mut app)? {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
}

fn attivi(app: &App) -> String {
    let (corso, coda) = (app.dl.in_flight(), app.dl.queued());
    if corso + coda == 0 {
        String::new()
    } else {
        format!(" · {corso} in corso, {coda} in coda")
    }
}

/// Uscire con dei download aperti è l'unico momento in cui la CLI deve insistere:
/// il pool muore con il processo, e con lui i sentinel.
fn esci(app: &mut App) -> R<bool> {
    if !app.dl.busy() {
        return Ok(true);
    }
    let voci = [
        "Aspetta che finiscano",
        "Interrompi e esci (i file parziali restano, yt-dlp riprende)",
        "← Torna al menu",
    ];
    screen("Ci sono download in corso", &mut app.message);
    match Select::with_theme(&ui::theme()).items(&voci).default(0).interact_opt()? {
        Some(0) => {
            println!("\nAspetto…  (i download finiscono, poi si esce)");
            while app.dl.busy() {
                app.pump(|u| {
                    if let ondo::Event::Done { id, .. } = &u.event {
                        println!("  ✓ {id}");
                    }
                });
                std::thread::sleep(Duration::from_millis(200));
            }
            app.pump(|_| {});
            Ok(true)
        }
        Some(1) => Ok(true),
        _ => Ok(false),
    }
}
