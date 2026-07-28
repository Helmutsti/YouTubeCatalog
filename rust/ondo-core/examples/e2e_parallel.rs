//! Prova reale del download **in parallelo** fra più istanze.
//!
//! È lo scenario che l'utente vuole: lanciare N copie di Ondo e lasciarle lavorare.
//! Il lock di scrittura da solo non basta — impedisce che due processi si
//! sovrascrivano lo stato, ma non che **scelgano lo stesso video**. La difesa è la
//! rivendicazione atomica in `ops::download::try_claim`.
//!
//! Uso (da due terminali, o in parallelo da uno solo):
//!   cargo run -p ondo-core --example e2e_parallel -- <url> <etichetta>

use ondo_core::downloader::{AudioStrategy, Reporter};
use ondo_core::library::state;
use ondo_core::ops;

struct Etichettato(String);
impl Reporter for Etichettato {
    fn log(&self, line: &str) {
        // Solo le righe che contano, altrimenti due processi che scrivono insieme
        // rendono l'output illeggibile.
        if line.starts_with('✔') || line.starts_with('✘') || line.starts_with('↷') {
            println!("[{}] {line}", self.0);
        }
    }
    fn progress(&self, _p: f64) {}
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let url = args
        .first()
        .cloned()
        .unwrap_or_else(|| "https://www.youtube.com/watch?v=jNQXAC9IVRw".into());
    let etichetta = args.get(1).cloned().unwrap_or_else(|| format!("pid{}", std::process::id()));

    let id = match ops::quick_download_target(&url)? {
        ops::QuickTarget::AlreadyDownloaded { id, .. } => {
            println!("[{etichetta}] GIA_SCARICATO {id}");
            return Ok(());
        }
        ops::QuickTarget::Video { id, .. } => id,
        ops::QuickTarget::Playlist { .. } => return Err("serve un singolo video".into()),
    };

    let report = ops::download_many(&[id.clone()], AudioStrategy::Auto, Some(None), &Etichettato(etichetta.clone()))?;

    // Riga machine-readable: è quella che lo script confronta fra le due istanze.
    println!(
        "[{etichetta}] ESITO scaricati={} saltati={} falliti={} totale={}",
        report.downloaded, report.skipped, report.failed, report.total
    );

    let st = state::read()?;
    if let Ok(v) = st.video(&id) {
        println!("[{etichetta}] STATO {} {}", v.download(), v.local_path().unwrap_or("-"));
    }
    Ok(())
}
