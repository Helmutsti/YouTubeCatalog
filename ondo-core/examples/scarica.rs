//! Il modo più corto per vedere la libreria all'opera, senza la CLI.
//!
//! ```text
//! cargo run --example scarica -- <URL> [<URL> …]          # scarica
//! cargo run --example scarica -- --vivo <URL> [<URL> …]   # come fa la console
//! cargo run --example scarica                             # elenca cosa c'è
//! ```
//!
//! `--vivo` usa il pool non bloccante e **non ricorda niente**: a ogni giro
//! ristampa rileggendo `Downloader::statuses()`, come la console del Download
//! rapido quando la si riapre.
//!
//! La radice è `ondo-data`, o `ONDO_ROOT` se impostata.

use std::collections::BTreeMap;

use ondo::{Event, Filter, Library};

fn main() -> Result<(), ondo::Error> {
    let root = std::env::var("ONDO_ROOT").unwrap_or_else(|_| "ondo-data".into());
    let mut lib = Library::open(&root)?;
    let mut urls: Vec<String> = std::env::args().skip(1).collect();
    let vivo = urls.first().map(String::as_str) == Some("--vivo");
    if vivo {
        urls.remove(0);
        return live(&mut lib, &urls);
    }

    if urls.is_empty() {
        println!("Libreria in {root} — {} video", lib.len());
        for (autore, quanti) in lib.authors() {
            println!("\n{autore} ({quanti})");
            for v in lib.by_author(&autore) {
                let mb = v.size_bytes as f64 / 1_048_576.0;
                println!(
                    "  {:>7}  {:>8.1} MB  {:<12}  {}",
                    v.duration_label(),
                    mb,
                    v.state.label(),
                    v.title
                );
            }
        }
        for f in [Filter::Pending, Filter::Failed, Filter::Archived, Filter::Favorites] {
            let n = lib.count(f);
            if n > 0 {
                println!("\n{}: {n}", f.label());
            }
        }
        if !lib.queue().is_empty() {
            println!("\nlink in coda:");
            for q in lib.queue() {
                println!("  {} {}", q.url, q.error.as_deref().unwrap_or(""));
            }
        }
        let mancanti = lib.missing_files();
        if !mancanti.is_empty() {
            println!("\nFile spariti dal disco: {}", mancanti.join(", "));
        }
        return Ok(());
    }

    let mut titoli: BTreeMap<u64, String> = BTreeMap::new();
    let esiti = lib.download(&urls, |u| match &u.event {
        Event::Phase { phase } => {
            let chi = titoli.get(&u.job).cloned().unwrap_or_else(|| u.url.clone());
            println!("[{}] {} — {chi}", u.job, phase.label());
        }
        Event::Resolved { title, author, .. } => {
            titoli.insert(u.job, format!("{author} — {title}"));
            println!("[{}] risolto: {author} — {title}", u.job);
        }
        Event::Progress { percent } => {
            use std::io::Write;
            print!("\r[{}] {percent:>5.1}%", u.job);
            let _ = std::io::stdout().flush();
        }
        Event::Cover { .. } => println!("\r[{}] copertina salvata", u.job),
        Event::Error { message } => println!("\r[{}] errore: {message}", u.job),
        Event::Done { .. } => println!("\r[{}] scaricato", u.job),
        Event::Log { .. } | Event::Metadata { .. } => {}
    });

    println!("\n— esiti —");
    for e in &esiti {
        match (&e.id, &e.error) {
            (Some(id), _) => {
                let v = lib.get(id).expect("appena entrato in libreria");
                println!("ok      {id}  {}", lib.file_path(v).display());
            }
            (None, Some(err)) => println!("errore  {}  {err}", e.url),
            (None, None) => println!("ignoto  {}", e.url),
        }
    }
    if esiti.iter().any(|e| !e.ok()) {
        std::process::exit(1);
    }
    Ok(())
}

/// Il ciclo di un'interfaccia viva: pompa lo stato della libreria, poi disegna
/// **rileggendo il pool**. Non tiene una sola riga di suo, quindi non c'è niente
/// che possa perdere.
fn live(lib: &mut Library, urls: &[String]) -> Result<(), ondo::Error> {
    let mut dl = ondo::Downloader::start(lib.config());
    for url in urls {
        lib.enqueue(url)?;
        dl.push(url.clone());
    }

    let mut giro = 0;
    while dl.busy() {
        while let Some(u) = dl.try_recv() {
            // Il comando esatto di yt-dlp: è la prima cosa che serve quando fa
            // qualcosa di inspiegabile.
            if let Event::Log { line } = &u.event {
                if line.starts_with('$') {
                    println!("  [{}] {line}", u.job);
                }
            }
            lib.apply(&u)?;
        }
        giro += 1;
        println!("\n— giro {giro}: rileggo i sentinel —");
        for s in dl.statuses() {
            let chi = if s.title.is_empty() { s.url.clone() } else { s.title.clone() };
            println!(
                "  [{}] avviato={} fase={:<9} {:>6} {}{}",
                s.job,
                s.started,
                s.phase.map(|p| p.label()).unwrap_or("in coda"),
                s.percent.map(|p| format!("{p:.1}%")).unwrap_or_else(|| "—".into()),
                chi,
                s.error.as_ref().map(|e| format!("  ✗ {e}")).unwrap_or_default()
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
    while let Some(u) = dl.try_recv() {
        lib.apply(&u)?;
    }
    println!("\n— stato finale, sempre rileggendo il pool —");
    for s in dl.statuses() {
        println!("  [{}] fatto={} errore={:?}  {}", s.job, s.done, s.error, s.title);
    }
    dl.shutdown();
    Ok(())
}
