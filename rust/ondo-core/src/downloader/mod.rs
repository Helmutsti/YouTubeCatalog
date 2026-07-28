//! `downloader` — l'unico layer che parla con `yt-dlp` e `ffmpeg`.
//!
//! **Puro rispetto allo stato**: prende un URL, restituisce dati (i campi curati
//! mappati dall'`info.json`). Non apre `library.json`, non scrive metadati, non
//! conosce il catalogo. Chi persiste i risultati è [`crate::ops`].
//!
//! È ciò che rompe il ciclo di dipendenze: nella prima stesura questo wrapper
//! chiamava `set_metadata()` e `remove_from_download_archive()` da sé, ereditando la
//! struttura del JavaScript. Ora restituisce e basta — e diventa testabile da solo.

mod ytdlp;

pub use ytdlp::*;
