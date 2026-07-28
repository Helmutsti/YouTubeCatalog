//! Prova end-to-end **reale**, non interattiva.
//!
//! Verifica ciò che nessun test unitario può: che il codice spawni yt-dlp con gli
//! argomenti giusti, ne legga l'avanzamento, ritrovi i file scritti, calcoli lo
//! sha256, archivi i metadati grezzi nel file per-video e aggiorni lo stato — sui
//! dati veri, con la rete vera. E che la **transazione atomica** sui due json
//! produca uno stato coerente.
//!
//! Uso:  cargo run -p ondo-core --example e2e_download -- [url] [--keep]
//!
//! Senza `--keep` ripulisce tutto ciò che ha creato.

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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let url = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| "https://www.youtube.com/watch?v=jNQXAC9IVRw".into());
    let keep = args.iter().any(|a| a == "--keep");

    println!("== 1. risoluzione del link ==");
    let (id, formats) = match ops::quick_download_target(&url)? {
        ops::QuickTarget::AlreadyDownloaded { id, .. } => {
            println!("   già scaricato: {id} — niente da fare");
            return Ok(());
        }
        ops::QuickTarget::Playlist { title, ids, .. } => {
            println!("   playlist «{title}»: {} video — non è il caso di prova", ids.len());
            return Ok(());
        }
        ops::QuickTarget::Video { id, title, formats } => {
            println!("   id={id}  titolo={title}");
            println!(
                "   risoluzioni: {:?}  audio-only: {}  serve scelta: {}",
                formats.available_heights, formats.has_audio_only, formats.needs_audio_choice
            );
            (id, formats)
        }
    };

    println!("\n== 2. lo stub è nello stato, e l'autore è nato con lui? ==");
    let st = state::read()?;
    let v = st.video(&id)?;
    println!("   presence={}  download={}", v.presence(), v.download());
    println!(
        "   sources={}  (vuoto = download rapido, nessuna sorgente: è corretto)",
        v.0.get("sources").map(|s| s.to_string()).unwrap_or_default()
    );
    let author_key = v.author_key();
    println!("   authorKey={author_key:?}");
    if let Some(k) = &author_key {
        assert!(st.authors.contains_key(k), "l'autore deve esistere nella tabella");
        println!("   autore in tabella: {}", st.authors[k].display_name());
    }

    println!("\n== 3. i due json esistono e sono coerenti? ==");
    let paths = ondo_core::config::get_paths()?;
    for p in [&paths.library_path, &paths.sources_path] {
        println!("   {} — {} byte", p.display(), std::fs::metadata(p)?.len());
    }
    assert!(!paths.data_dir.join(".commit").exists(), "nessuna transazione a metà");
    println!("   nessuna transazione interrotta ✔");

    println!("\n== 4. download reale ==");
    let strategy = if formats.needs_audio_choice { AudioStrategy::Merged } else { AudioStrategy::Auto };
    let report = ops::download_many(&[id.clone()], strategy, Some(None), &Printer)?;
    println!("   esito: {report:?}");
    if report.downloaded != 1 {
        return Err("il download non è riuscito".into());
    }

    println!("\n== 5. stato dopo il download ==");
    let st = state::read()?;
    let v = st.video(&id)?.clone();
    let vi = v.0.get("video").cloned().unwrap_or_default();
    println!("   download   = {}", v.download());
    println!("   titolo     = {}", v.display_title());
    println!("   autore     = {:?}", v.channel_name());
    println!("   localPath  = {:?}", v.local_path());
    println!("   sizeBytes  = {}", vi.get("sizeBytes").map(|x| x.to_string()).unwrap_or_default());
    println!("   sha256     = {}", vi.get("sha256").and_then(|x| x.as_str()).unwrap_or("—"));
    println!("   copertina  = {:?}", v.0.get("thumbnail").and_then(|t| t.get("localPath")));
    // Il download porta i metadati completi del canale: la tabella authors deve aver
    // imparato l'id vero, che l'enumerazione flat non dava.
    if let Some(k) = v.author_key() {
        let a = &st.authors[&k];
        println!("   autore     = {} (id={:?}, url={:?})", a.display_name(), a.id(), a.url());
    }

    println!("\n== 6. il file esiste, e la dimensione registrata combacia? ==");
    let abs = files::resolve_video_path(&v)?;
    let meta = std::fs::metadata(&abs)?;
    println!("   {} ({} byte)", abs.display(), meta.len());
    assert_eq!(
        meta.len(),
        vi.get("sizeBytes").and_then(|x| x.as_u64()).unwrap_or(0),
        "la dimensione registrata deve combaciare col file reale"
    );

    println!("\n== 7. metadati grezzi: un file per video ==");
    let mpath = paths.metadata_dir.join(format!("{id}.json"));
    let m = metadata::get(&id)?.ok_or("metadati assenti")?;
    println!(
        "   {} — {} byte, {} campi",
        mpath.display(),
        std::fs::metadata(&mpath)?.len(),
        m.as_object().map(|o| o.len()).unwrap_or(0)
    );
    assert!(m.get("automatic_captions").is_none(), "automatic_captions va rimosso");
    println!("   automatic_captions rimosso ✔");

    println!("\n== 8. nessun sidecar .info.json lasciato in giro? ==");
    fn walk(dir: &std::path::Path, id: &str, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, id, out);
                } else {
                    let s = p.to_string_lossy();
                    if s.contains(id) && s.ends_with(".info.json") {
                        out.push(p);
                    }
                }
            }
        }
    }
    let mut leftovers = Vec::new();
    walk(&paths.videos_dir, &id, &mut leftovers);
    walk(&paths.covers_dir, &id, &mut leftovers);
    if leftovers.is_empty() {
        println!("   nessun residuo ✔");
    } else {
        return Err(format!("residui: {leftovers:?}").into());
    }

    if keep {
        println!("\n(--keep: nulla è stato ripulito)");
        return Ok(());
    }

    println!("\n== 9. pulizia ==");
    ops::set_hidden(&id, true)?; // gate a due passi della cancellazione totale
    ops::delete_video_completely(&id)?;
    let st = state::read()?;
    let gone = st.video(&id).is_err();
    let file_gone = !abs.exists();
    let meta_gone = metadata::get(&id)?.is_none();
    let author_pruned = author_key.map(|k| !st.authors.contains_key(&k)).unwrap_or(true);
    println!("   scheda: {gone}   file: {file_gone}   metadati: {meta_gone}   autore orfano rimosso: {author_pruned}");
    let c = query::counts(&st);
    println!("   video in libreria ora: {}", c.total);
    if !(gone && file_gone && meta_gone) {
        return Err("la pulizia non è completa".into());
    }

    println!("\n✔ END-TO-END SUPERATO");
    Ok(())
}
