//! # ondo-core
//!
//! Logica di dominio del catalogo video locale, in tre layer con una sola direzione
//! di dipendenza:
//!
//! ```text
//! ops          orchestrazione delle operazioni utente (sync, download, manutenzione)
//!  ├── library stato: autori, video, sorgenti, metadati, layout dei file
//!  └── downloader  yt-dlp + ffmpeg. PURO: prende un url, restituisce dati.
//! ```
//!
//! `library` non conosce `downloader` e `downloader` non conosce `library`: si
//! incontrano solo in `ops`. La prima stesura di questo porting aveva il ciclo
//! `library → downloader → library` ereditato dal JavaScript (il wrapper scriveva i
//! metadati da sé); spostare l'orchestrazione sopra invece che sotto lo elimina.
//!
//! Non c'è ABI C: la CLI linka questo crate direttamente e usa tipi Rust veri.
//! Progetto e storia: `docs/rust-core.md`.

pub mod config;
pub mod downloader;
pub mod error;
pub mod library;
pub mod lock;
pub mod ops;
pub mod time;

pub use error::{ErrorKind, OndoError, Result};
pub use library::{Author, Source, State, Video, VideoCategory};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
