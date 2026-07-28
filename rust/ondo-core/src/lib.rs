//! # ondo-core
//!
//! Logica di dominio del catalogo video locale, portata da `core/src` (JavaScript).
//! Vale qui lo stesso principio architetturale del progetto: **tutta la logica sta
//! nel core**, gli adapter (CLI, server, futuri binding FFI) restano sottili e non
//! reimplementano regole di stato.
//!
//! Progetto complessivo, contratto FFI e strategia di migrazione:
//! `docs/rust-core.md`. Milestone: `docs/PIANO.md` (M67-M73).
//!
//! ## Stato del porting
//!
//! | Modulo JS | Rust | Stato |
//! |---|---|---|
//! | `catalog/catalogSchema.js` | [`schema`] | portato |
//! | `catalog/catalogStore.js` | [`store`] | portato |
//! | `config.js` + `preflight.js` | [`config`] | portato |
//! | `services/searchService.js` | [`search`] | portato |
//! | `services/videoService.js` + assi hidden/favorite | [`query`] | portato |
//! | `services/libraryService.js` (nomi e percorsi) | [`library`] | parziale |
//! | `ytdlp/ytdlpWrapper.js`, `jobs/*`, sync/sources | — | **non ancora portati** |
//!
//! Finché il porting non è completo, la Regola 1 della migrazione vale in questa
//! forma: le funzioni qui presenti sono **di sola lettura o mutazioni sugli assi
//! `hidden`/`favorite`**; nulla qui scarica video o tocca `jobs.json`, quindi
//! l'implementazione JS resta l'unica proprietaria di quelle aree.

pub mod config;
pub mod error;
pub mod library;
pub mod lock;
pub mod metadata;
pub mod query;
pub mod schema;
pub mod search;
pub mod sources;
pub mod store;
pub mod sync;
pub mod tasks;
pub mod time;
pub mod ytdlp;

pub use error::{ErrorKind, OndoError, Result};
pub use query::{
    get_video, list_available_in, list_channels, list_videos, list_videos_by_channel,
    set_video_favorite, set_video_hidden, Channel, VideoFilter,
};
pub use schema::{download_state, presence, video_category, Video, VideoCategory};
pub use search::search_videos;
pub use store::{read_catalog, update_catalog, videos_of};

/// Versione del crate, esposta per il CLI e (in futuro) per l'handshake FFI.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
