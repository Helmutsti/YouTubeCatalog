//! Transazione atomica su **più file** — il pezzo che rende sicura la divisione
//! dello stato in `sources.json` + `library.json`.
//!
//! ## Il problema
//!
//! Con un file unico l'atomicità è gratis: si scrive `catalog.json.tmp` e si fa
//! `rename()`, che è atomico su NTFS e POSIX. Con **due** file non basta più: un
//! `addSource` registra la sorgente *e* ingerisce i video, e se il processo muore
//! fra i due rename resta uno stato incoerente — una sorgente senza video, o
//! peggio video che citano una sorgente inesistente.
//!
//! `rename()` atomico su due file non esiste. Ma l'atomicità si può ottenere
//! spostando il **punto di commit** su un unico file minuscolo.
//!
//! ## Il protocollo
//!
//! ```text
//! data/
//!   sources.json          ← stato visibile
//!   library.json          ← stato visibile
//!   .commit/              ← esiste solo durante una transazione
//!     sources.json        ← nuovo contenuto, completo
//!     library.json        ← nuovo contenuto, completo
//!     COMMIT              ← elenco dei file da applicare. QUESTO è il punto di commit.
//! ```
//!
//! Scrittura: (1) svuota `.commit/`; (2) scrive dentro i nuovi file **interi** e li
//! forza su disco con `sync_all()`; (3) crea `COMMIT` con un rename atomico; (4)
//! sposta i file al loro posto; (5) rimuove `COMMIT` e la cartella.
//!
//! Ripristino, eseguito **prima di ogni lettura e di ogni scrittura**:
//! - `COMMIT` **esiste** → la transazione era stata decisa: si completano gli
//!   spostamenti rimasti (idempotente — un file già spostato non c'è più in
//!   `.commit/` e si salta) e si ripulisce;
//! - `COMMIT` **non esiste** ma `.commit/` sì → la transazione non era stata
//!   decisa: si butta tutto, lo stato visibile è ancora quello vecchio e intatto.
//!
//! Il risultato è ciò che serve: **o tutti i file nuovi, o tutti quelli vecchi**,
//! mai un miscuglio. Il `sync_all()` del passo (2) è ciò che rende vera la
//! garanzia anche su spegnimento improvviso, non solo su un processo ucciso.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::Result;

const COMMIT_DIR: &str = ".commit";
const COMMIT_MARKER: &str = "COMMIT";

/// Un file da scrivere nella transazione: nome (relativo a `data/`) e contenuto.
pub struct StagedFile {
    pub name: String,
    pub content: String,
}

fn commit_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(COMMIT_DIR)
}

fn marker_path(data_dir: &Path) -> PathBuf {
    commit_dir(data_dir).join(COMMIT_MARKER)
}

/// Porta lo stato su disco a una situazione coerente. Va chiamata **sotto lock**,
/// prima di qualunque lettura o scrittura.
pub fn recover(data_dir: &Path) -> Result<()> {
    let dir = commit_dir(data_dir);
    if !dir.exists() {
        return Ok(());
    }

    let marker = marker_path(data_dir);
    if !marker.is_file() {
        // Transazione mai decisa: si scarta. Lo stato visibile è ancora il vecchio.
        let _ = fs::remove_dir_all(&dir);
        return Ok(());
    }

    // Transazione decisa: si completa. `COMMIT` elenca i file, uno per riga.
    let listed = fs::read_to_string(&marker)?;
    for name in listed.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let from = dir.join(name);
        if from.is_file() {
            fs::rename(&from, data_dir.join(name))?;
        }
        // Se non c'è più, era già stato spostato: si salta (idempotenza).
    }
    fs::remove_file(&marker)?;
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

/// Applica un insieme di file come **una sola** transazione atomica.
/// Va chiamata sotto lock, dopo `recover()`.
pub fn commit(data_dir: &Path, files: &[StagedFile]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let dir = commit_dir(data_dir);

    // (1) area di staging pulita: un residuo di una transazione scartata non deve
    // finire mischiato con questa.
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;

    // (2) contenuti completi + forzatura su disco. Senza `sync_all()` il marker
    // potrebbe raggiungere il disco prima dei dati, e uno spegnimento improvviso
    // lascerebbe un commit "deciso" su file incompleti — cioè la corruzione che
    // tutto questo esiste per evitare.
    for f in files {
        let path = dir.join(&f.name);
        let mut file = File::create(&path)?;
        file.write_all(f.content.as_bytes())?;
        file.sync_all()?;
    }

    // (3) IL PUNTO DI COMMIT. Scritto altrove e portato dentro con un rename, che è
    // atomico: il marker o c'è per intero o non c'è.
    let listing = files
        .iter()
        .map(|f| f.name.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let marker_tmp = dir.join("COMMIT.tmp");
    {
        let mut file = File::create(&marker_tmp)?;
        file.write_all(listing.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&marker_tmp, marker_path(data_dir))?;

    // (4) e (5): da qui in poi la transazione è decisa. Anche se il processo muore
    // adesso, `recover()` la completerà al prossimo avvio.
    recover(data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ondo-commit-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn staged(name: &str, content: &str) -> StagedFile {
        StagedFile { name: name.to_string(), content: content.to_string() }
    }

    #[test]
    fn commit_applies_all_files_and_cleans_up() {
        let d = tmpdir("apply");
        commit(&d, &[staged("a.json", "AAA"), staged("b.json", "BBB")]).unwrap();
        assert_eq!(fs::read_to_string(d.join("a.json")).unwrap(), "AAA");
        assert_eq!(fs::read_to_string(d.join("b.json")).unwrap(), "BBB");
        assert!(!commit_dir(&d).exists(), "l'area di staging va rimossa");
    }

    #[test]
    fn a_crash_before_the_marker_leaves_the_old_state_intact() {
        let d = tmpdir("before");
        fs::write(d.join("a.json"), "VECCHIO").unwrap();
        fs::write(d.join("b.json"), "VECCHIO").unwrap();

        // Simula un processo morto dopo aver scritto lo staging ma prima del marker.
        let dir = commit_dir(&d);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.json"), "NUOVO").unwrap();
        fs::write(dir.join("b.json"), "NUOVO").unwrap();

        recover(&d).unwrap();

        assert_eq!(fs::read_to_string(d.join("a.json")).unwrap(), "VECCHIO");
        assert_eq!(fs::read_to_string(d.join("b.json")).unwrap(), "VECCHIO");
        assert!(!dir.exists(), "lo staging non deciso va scartato");
    }

    #[test]
    fn a_crash_after_the_marker_completes_the_transaction() {
        let d = tmpdir("after");
        fs::write(d.join("a.json"), "VECCHIO").unwrap();
        fs::write(d.join("b.json"), "VECCHIO").unwrap();

        // Processo morto DOPO il marker: la transazione era decisa.
        let dir = commit_dir(&d);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.json"), "NUOVO").unwrap();
        fs::write(dir.join("b.json"), "NUOVO").unwrap();
        fs::write(dir.join(COMMIT_MARKER), "a.json\nb.json").unwrap();

        recover(&d).unwrap();

        assert_eq!(fs::read_to_string(d.join("a.json")).unwrap(), "NUOVO");
        assert_eq!(fs::read_to_string(d.join("b.json")).unwrap(), "NUOVO");
        assert!(!dir.exists());
    }

    #[test]
    fn a_crash_in_the_middle_of_applying_is_finished_correctly() {
        // Il caso che rende l'atomicità reale invece che apparente: uno dei due
        // rename era già andato a buon fine.
        let d = tmpdir("middle");
        fs::write(d.join("a.json"), "NUOVO").unwrap(); // già spostato
        fs::write(d.join("b.json"), "VECCHIO").unwrap();

        let dir = commit_dir(&d);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.json"), "NUOVO").unwrap(); // a.json non c'è più in staging
        fs::write(dir.join(COMMIT_MARKER), "a.json\nb.json").unwrap();

        recover(&d).unwrap();

        assert_eq!(fs::read_to_string(d.join("a.json")).unwrap(), "NUOVO");
        assert_eq!(fs::read_to_string(d.join("b.json")).unwrap(), "NUOVO", "va completato");
        assert!(!dir.exists());
    }

    #[test]
    fn recover_is_a_no_op_when_there_is_nothing_to_do() {
        let d = tmpdir("noop");
        fs::write(d.join("a.json"), "X").unwrap();
        recover(&d).unwrap();
        recover(&d).unwrap();
        assert_eq!(fs::read_to_string(d.join("a.json")).unwrap(), "X");
    }
}
