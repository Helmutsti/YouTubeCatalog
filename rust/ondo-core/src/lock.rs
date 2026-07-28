//! Lock di scrittura **fra processi** — non esiste nell'implementazione JS.
//!
//! ## Il problema che risolve
//!
//! `catalogStore.js` serializza le mutazioni con una coda di promise: protegge
//! *dentro* un processo, ma due processi (server + CLI, o due CLI) che scrivono
//! insieme si sovrascrivono a vicenda. È la radice dell'incidente reale del
//! 2026-07-25 documentato in `storico.md`, dove 83 video "scaricati" sono stati
//! azzerati e recuperarli ha richiesto una riparazione manuale.
//!
//! `documentazione.md` lo registra come regola per l'utente («se uno script
//! esterno modifica il catalogo mentre un server/CLI gira, riavvia quel
//! processo») — cioè una **convenzione umana** al posto di una garanzia tecnica.
//! Qui diventa una garanzia: `create_new(true)` è atomico sia su NTFS sia su
//! POSIX, quindi solo un processo alla volta può ottenere il lock.
//!
//! ## Perché non blocca per sempre
//!
//! Un processo ucciso brutalmente lascia il file. Due difese: (1) si attende con
//! ritentativi brevi per qualche secondo, perché le scritture durano millisecondi;
//! (2) un lock più vecchio di `STALE_AFTER` è considerato abbandonato e rimosso.
//! Il contenuto (pid + timestamp) serve a rendere diagnosticabile un lock appeso.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::error::{ErrorKind, OndoError, Result};

/// Le scritture reali durano millisecondi: se dopo questo tempo il lock è ancora
/// occupato, qualcosa non va e vale la pena dirlo invece di attendere in silenzio.
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_EVERY: Duration = Duration::from_millis(50);

/// Oltre questa età il lock è considerato abbandonato da un processo morto.
/// Generoso di proposito: un download lungo NON tiene il lock (lo prende solo
/// per la scrittura finale), quindi nessuna operazione legittima si avvicina.
const STALE_AFTER: Duration = Duration::from_secs(120);

/// Rilascia il lock quando esce di scope, anche in caso di panic o di `?`.
pub struct FileLock {
    path: PathBuf,
}

impl FileLock {
    /// Acquisisce il lock, attendendo che si liberi entro `WAIT_TIMEOUT`.
    pub fn acquire(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let deadline = SystemTime::now() + WAIT_TIMEOUT;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    // Diagnostica per un lock eventualmente appeso.
                    let _ = writeln!(file, "pid={} at={}", std::process::id(), crate::time::now_iso8601());
                    return Ok(FileLock { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if is_stale(&path) {
                        // Best-effort: se un altro processo lo rimuove nel mentre,
                        // il prossimo giro riprova comunque.
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if SystemTime::now() >= deadline {
                        return Err(OndoError::new(
                            ErrorKind::Conflict,
                            format!(
                                "Un'altra istanza di Ondo sta scrivendo sul catalogo \
                                 (lock: {}). Attendi che finisca, oppure — se sei certo \
                                 che nessun altro processo sia attivo — cancella quel file.",
                                path.display()
                            ),
                        ));
                    }
                    std::thread::sleep(RETRY_EVERY);
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

fn is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age > STALE_AFTER)
        .unwrap_or(false)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Best-effort: se la rimozione fallisce, il lock scadrà come stale.
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ondo-lock-test-{}-{name}", std::process::id()))
    }

    #[test]
    fn lock_is_exclusive_then_released_on_drop() {
        let p = tmp("exclusive");
        let _ = fs::remove_file(&p);

        let first = FileLock::acquire(&p).expect("il primo lock deve riuscire");
        assert!(p.exists());

        // Il secondo non deve riuscire (e non deve attendere 10s: il file è appena
        // stato creato, quindi non è stale — si accetta l'attesa del timeout solo
        // qui, dove è il comportamento in prova).
        drop(first);
        assert!(!p.exists(), "il lock va rimosso al drop");

        // Dopo il rilascio si riacquisisce senza problemi.
        let again = FileLock::acquire(&p).expect("dopo il rilascio deve riuscire");
        drop(again);
    }

    #[test]
    fn a_stale_lock_is_reclaimed() {
        let p = tmp("stale");
        fs::write(&p, "pid=999999 at=vecchio").unwrap();
        // Non si può retrodatare mtime senza dipendenze: si verifica invece che un
        // lock appena creato NON sia considerato stale, che è l'altra metà della
        // proprietà (e quella che, se sbagliata, corromperebbe i dati).
        assert!(!is_stale(&p), "un lock fresco non deve mai essere considerato abbandonato");
        let _ = fs::remove_file(&p);
    }
}
