//! Prova end-to-end **reale** del percorso di download, non interattiva.
//!
//! Serve a verificare ciò che nessun test unitario può: che il codice Rust
//! spawni yt-dlp con gli argomenti giusti, ne legga l'avanzamento, ritrovi i file
//! scritti, calcoli lo sha256, consolidi i metadati grezzi e aggiorni il catalogo
//! — sui dati veri, con la rete vera.
//!
//! Uso:  cargo run -p ondo-core --example e2e_download -- <url> [--keep]
//!
//! Senza `--keep` ripulisce tutto ciò che ha creato (B4: pulizia dei dati di test).

use ondo_core::ytdlp::{AudioStrategy, Reporter};
use ondo_core::{library, query, sources, store, tasks};

struct Printer;
impl Reporter for Printer {
    fn log(&self, line: &str) {
        println!("    {line}");
    }
    fn progress(&self, _percent: f64) {}
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let url = args
        .first()
        .cloned()
        .unwrap_or_else(|| "https://www.youtube.com/watch?v=jNQXAC9IVRw".to_string());
    let keep = args.iter().any(|a| a == "--keep");

    println!("== 1. risoluzione del link ==");
    let prepared = sources::prepare_single_video(&url)?;
    let (id, formats) = match prepared {
        sources::SinglePrepared::AlreadyDownloaded { id, .. } => {
            println!("   già scaricato: {id} — niente da fare");
            return Ok(());
        }
        sources::SinglePrepared::Ready { id, title, formats, .. } => {
            println!("   id={id}  titolo={:?}", title);
            println!(
                "   risoluzioni disponibili: {:?}  audio-only: {}  serve scelta: {}",
                formats.available_heights, formats.has_audio_only, formats.needs_audio_choice
            );
            (id, formats)
        }
    };

    println!("\n== 2. lo stub è in catalogo? ==");
    let stub = query::get_video(&id)?;
    println!(
        "   presence={}  download={}  sources={}  (vuoto = nessuna etichetta, è corretto)",
        stub.presence(),
        stub.download(),
        stub.0.get("sources").map(|s| s.to_string()).unwrap_or_default()
    );

    println!("\n== 3. download reale ==");
    let strategy = if formats.needs_audio_choice { AudioStrategy::Merged } else { AudioStrategy::Auto };
    let report = tasks::download_many(&[id.clone()], strategy, Some(None), &Printer)?;
    println!("   esito: {report:?}");
    if report.downloaded != 1 {
        return Err("il download non è riuscito".into());
    }

    println!("\n== 4. verifica del catalogo dopo il download ==");
    let video = query::get_video(&id)?;
    let v = video.0.get("video").cloned().unwrap_or_default();
    println!("   download   = {}", video.download());
    println!("   titolo     = {}", video.display_title());
    println!("   canale     = {:?}", video.channel_name());
    println!("   localPath  = {:?}", video.local_path());
    println!("   sizeBytes  = {}", v.get("sizeBytes").map(|x| x.to_string()).unwrap_or_default());
    println!("   sha256     = {}", v.get("sha256").and_then(|x| x.as_str()).unwrap_or("—"));
    println!("   ytdlp      = {}", v.get("ytdlpVersion").and_then(|x| x.as_str()).unwrap_or("—"));
    println!("   copertina  = {:?}", video.0.get("thumbnail").and_then(|t| t.get("localPath")));

    println!("\n== 5. il file esiste davvero su disco? ==");
    let abs = library::resolve_video_path(&video)?;
    let meta = std::fs::metadata(&abs)?;
    println!("   {} ({} byte)", abs.display(), meta.len());
    assert_eq!(
        meta.len(),
        v.get("sizeBytes").and_then(|x| x.as_u64()).unwrap_or(0),
        "la dimensione registrata deve combaciare col file reale"
    );

    println!("\n== 6. i metadati grezzi sono consolidati? ==");
    match ondo_core::metadata::get_metadata(&id)? {
        Some(m) => {
            let keys = m.as_object().map(|o| o.len()).unwrap_or(0);
            println!("   {keys} campi salvati in metadata.json");
            assert!(
                m.get("automatic_captions").is_none(),
                "automatic_captions deve essere rimosso"
            );
            println!("   automatic_captions rimosso ✔");
        }
        None => return Err("metadati grezzi assenti".into()),
    }

    println!("\n== 7. nessun sidecar .info.json lasciato in giro? ==");
    let paths = ondo_core::config::get_paths()?;
    let mut leftovers = Vec::new();
    fn walk(dir: &std::path::Path, id: &str, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, id, out);
                } else if p.to_string_lossy().contains(id) && p.to_string_lossy().ends_with(".info.json") {
                    out.push(p);
                }
            }
        }
    }
    walk(&paths.videos_dir, &id, &mut leftovers);
    walk(&paths.thumbnails_dir, &id, &mut leftovers);
    if leftovers.is_empty() {
        println!("   nessun residuo ✔");
    } else {
        println!("   ✘ residui: {leftovers:?}");
    }

    if keep {
        println!("\n(--keep: nulla è stato ripulito)");
        return Ok(());
    }

    println!("\n== 8. pulizia ==");
    query::set_video_hidden(&id, true)?; // gate a due passi della cancellazione totale
    library::delete_video_completely(&id)?;
    let gone = query::get_video(&id).is_err();
    let file_gone = !abs.exists();
    let meta_gone = ondo_core::metadata::get_metadata(&id)?.is_none();
    println!("   scheda rimossa: {gone}   file rimosso: {file_gone}   metadati rimossi: {meta_gone}");
    let catalog = store::read_catalog()?;
    println!("   video in catalogo ora: {}", store::videos_of(&catalog).len());
    if !(gone && file_gone && meta_gone) {
        return Err("la pulizia non è completa".into());
    }

    println!("\n✔ END-TO-END SUPERATO");
    Ok(())
}
