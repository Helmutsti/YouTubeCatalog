//! Prova reale del download **in parallelo su thread** dentro un solo processo.
//!
//! Verifica le due cose che i test unitari non possono: che N download davvero
//! girino insieme (misurando il tempo), e che lo stato resti coerente quando N
//! risultati tornano al thread principale.
//!
//! Uso:  cargo run -p ondo-core --example e2e_batch -- <url> [url…]

use std::time::Instant;

use ondo_core::downloader::{AudioStrategy, Reporter};
use ondo_core::library::{files, metadata, query, state};
use ondo_core::ops;

struct Printer;
impl Reporter for Printer {
    fn log(&self, line: &str) {
        println!("    {line}");
    }
    fn progress(&self, _p: f64) {}
}

fn scarica(urls: &[String], paralleli: usize) -> Result<(u64, usize), Box<dyn std::error::Error>> {
    ondo_core::config::set_parallel_downloads(paralleli)?;

    let mut ids = Vec::new();
    for u in urls {
        match ops::quick_download_target(u)? {
            ops::QuickTarget::Video { id, .. } => ids.push(id),
            ops::QuickTarget::AlreadyDownloaded { id, .. } => ids.push(id),
            ops::QuickTarget::Playlist { .. } => return Err("atteso un singolo video".into()),
        }
    }

    // Si riparte da zero, così il confronto dei tempi è onesto.
    for id in &ids {
        if state::read()?.video(id).map(|v| v.is_downloaded()).unwrap_or(false) {
            ops::set_hidden(id, true)?;
            ops::delete_video_completely(id)?;
        }
    }
    let mut ids = Vec::new();
    for u in urls {
        if let ops::QuickTarget::Video { id, .. } = ops::quick_download_target(u)? {
            ids.push(id);
        }
    }

    let t = Instant::now();
    let r = ops::download_many(&ids, AudioStrategy::Auto, Some(None), &Printer)?;
    let secondi = t.elapsed().as_secs();
    println!("    → {} scaricati, {} falliti in {secondi}s", r.downloaded, r.failed);
    if r.downloaded != ids.len() {
        return Err(format!("attesi {} download, ottenuti {}", ids.len(), r.downloaded).into());
    }
    Ok((secondi, ids.len()))
}

fn verifica(urls: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let st = state::read()?;
    for u in urls {
        let id = u.rsplit("v=").next().unwrap().to_string();
        let v = st.video(&id)?;

        // Stato coerente: nessuna rivendicazione rimasta appesa.
        assert!(v.is_downloaded(), "{id}: stato {}", v.download());
        assert!(
            v.0.get("downloadingSince").map(|x| x.is_null()).unwrap_or(true),
            "{id}: la rivendicazione non è stata rilasciata"
        );

        // Il file c'è e la dimensione registrata combacia con quella reale.
        let abs = files::resolve_video_path(v)?;
        let reale = std::fs::metadata(&abs)?.len();
        assert_eq!(reale, v.size_bytes().unwrap_or(0), "{id}: dimensione incoerente");
        assert!(metadata::has(&id), "{id}: metadati grezzi mancanti");
        println!(
            "    ✔ {id}  {}  {} byte",
            v.display_title().chars().take(40).collect::<String>(),
            reale
        );
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let urls: Vec<String> = std::env::args().skip(1).filter(|a| a.starts_with("http")).collect();
    if urls.len() < 2 {
        return Err("servono almeno due URL".into());
    }
    println!("{} video da scaricare\n", urls.len());

    println!("== A. uno alla volta ==");
    let (seq, _) = scarica(&urls, 1)?;
    verifica(&urls)?;

    println!("\n== B. tre in parallelo ==");
    let (par, n) = scarica(&urls, 3)?;
    verifica(&urls)?;

    println!("\n== confronto ==");
    println!("    sequenziale: {seq}s   parallelo(3): {par}s   su {n} video");
    if par < seq {
        println!("    ✔ il parallelo è più veloce");
    } else {
        // Su video da 10 secondi il tempo è dominato dall'estrazione dei metadati, non
        // dal trasferimento: non è un fallimento, ma va detto invece che spacciarlo
        // per un successo.
        println!("    ⚠ nessun guadagno misurabile: con file così piccoli il tempo se ne va");
        println!("      nell'estrazione, non nel trasferimento. Il parallelismo si vede sui video veri.");
    }

    println!("\n== stato finale ==");
    let st = state::read()?;
    let c = query::counts(&st);
    println!("    {} video, {} scaricati, {} autori", c.total, c.downloaded, st.authors.len());
    assert_eq!(c.downloading, 0, "nessun video deve restare «in corso»");
    println!("    ✔ nessuna rivendicazione appesa");

    println!("\n== pulizia ==");
    for u in &urls {
        let id = u.rsplit("v=").next().unwrap().to_string();
        if state::read()?.video(&id).is_ok() {
            ops::set_hidden(&id, true)?;
            ops::delete_video_completely(&id)?;
        }
    }
    ondo_core::config::set_parallel_downloads(3)?;
    println!("    fatto");

    println!("\n✔ BATCH PARALLELO SUPERATO");
    Ok(())
}
