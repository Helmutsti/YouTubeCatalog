//! Lo stato condiviso del server, e il travaso degli eventi dal pool ai client.

use std::sync::{Arc, Mutex, MutexGuard};

use ondo::{Downloader, Library, Update};
use tokio::sync::broadcast;

/// Quello che ogni handler ha in mano.
///
/// ⚠️ **Regola sui due lock**: non si tengono mai insieme. Ogni punto del codice
/// prende `lib` **oppure** `dl`, fa quello che deve, e rilascia. Il travaso qui
/// sotto va nell'ordine opposto agli handler (prima `dl`, poi `lib`), quindi
/// tenerli insieme sarebbe un abbraccio mortale in attesa di succedere.
pub struct Stato {
    lib: Mutex<Library>,
    dl: Mutex<Downloader>,
    /// Gli eventi dei download, già in JSON, per i client SSE. Un client lento non
    /// blocca nessuno: `broadcast` gli fa perdere i messaggi più vecchi.
    pub eventi: broadcast::Sender<String>,
}

impl Stato {
    pub fn new(lib: Library) -> Arc<Stato> {
        let dl = Downloader::start(lib.config());
        let (eventi, _) = broadcast::channel(512);
        let stato = Arc::new(Stato { lib: Mutex::new(lib), dl: Mutex::new(dl), eventi });
        avvia_travaso(Arc::clone(&stato));
        stato
    }

    pub fn lib(&self) -> MutexGuard<'_, Library> {
        self.lib.lock().expect("la libreria non è avvelenata")
    }

    pub fn dl(&self) -> MutexGuard<'_, Downloader> {
        self.dl.lock().expect("il pool non è avvelenato")
    }
}

/// Il thread che fa quello che nella CLI fa `App::pump`: prende gli aggiornamenti
/// dal pool, li applica allo stato, e li rimanda ai client.
///
/// Senza questo, i download partirebbero e nessuno registrerebbe che sono finiti.
/// È un thread di sistema e non un task async perché il pool è sincrono: aspetta su
/// canali `std`, non su un runtime.
fn avvia_travaso(stato: Arc<Stato>) {
    std::thread::spawn(move || loop {
        let mut visti = 0;
        loop {
            // Un lock alla volta: si prende l'aggiornamento e si lascia subito il pool.
            let update = { stato.dl().try_recv() };
            let Some(update) = update else { break };

            let esito = { stato.lib().apply(&update) };
            let mut payload = riga(&update);
            if let Err(e) = esito {
                payload = serde_json::json!({
                    "job": update.job,
                    "url": update.url,
                    "id": update.id,
                    "event": { "event": "error", "message": e.to_string() }
                });
            }
            let _ = stato.eventi.send(payload.to_string());
            visti += 1;
        }
        if visti == 0 {
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
    });
}

fn riga(update: &Update) -> serde_json::Value {
    serde_json::json!({
        "job": update.job,
        "url": update.url,
        "id": update.id,
        "event": serde_json::to_value(&update.event).unwrap_or(serde_json::Value::Null),
    })
}
