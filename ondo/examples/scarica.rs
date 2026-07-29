//! Il modo più corto per vedere la libreria all'opera.
//!
//! ```text
//! cargo run --example scarica -- <URL> [<URL> …]   # scarica
//! cargo run --example scarica                      # elenca cosa c'è
//! ```
//!
//! La radice è `ondo-data`, o `ONDO_ROOT` se impostata.

use std::collections::BTreeMap;

use ondo::{Event, Library};

fn main() -> Result<(), ondo::Error> {
    let root = std::env::var("ONDO_ROOT").unwrap_or_else(|_| "ondo-data".into());
    let mut lib = Library::open(&root)?;
    let urls: Vec<String> = std::env::args().skip(1).collect();

    if urls.is_empty() {
        println!("Libreria in {root} — {} video", lib.len());
        for (autore, quanti) in lib.authors() {
            println!("\n{autore} ({quanti})");
            for v in lib.by_author(&autore) {
                let mb = v.size_bytes as f64 / 1_048_576.0;
                println!("  {:>7}  {:>8.1} MB  {}", v.duration_label(), mb, v.title);
            }
        }
        let mancanti = lib.missing_files();
        if !mancanti.is_empty() {
            println!("\nFile spariti dal disco: {}", mancanti.join(", "));
        }
        return Ok(());
    }

    // Una riga di stato per link, riscritta man mano: è ciò che rende leggibili N
    // download in parallelo su un terminale solo.
    let mut titoli: BTreeMap<usize, String> = BTreeMap::new();
    let esiti = lib.download(&urls, |u| match &u.event {
        Event::Phase { phase } => {
            let chi = titoli.get(&u.index).cloned().unwrap_or_else(|| u.url.clone());
            println!("[{}] {} — {chi}", u.index + 1, phase.label());
        }
        Event::Resolved { title, author, .. } => {
            titoli.insert(u.index, format!("{author} — {title}"));
            println!("[{}] risolto: {author} — {title}", u.index + 1);
        }
        Event::Progress { percent } => {
            print!("\r[{}] {percent:>5.1}%", u.index + 1);
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
        Event::Cover { .. } => println!("\r[{}] copertina salvata", u.index + 1),
        Event::Error { message } => println!("\r[{}] errore: {message}", u.index + 1),
        Event::Done { .. } => println!("\r[{}] scaricato", u.index + 1),
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
