//! `library` — lo **stato**: autori, video, sorgenti, metadati grezzi, e il layout
//! dei file su disco.
//!
//! È l'unico layer che scrive i json. Sopra di lui sta [`crate::ops`], che orchestra
//! le operazioni utente; sotto di lui **niente**: in particolare `library` non
//! conosce [`crate::downloader`], e non lo chiama mai.
//!
//! ## Perché la freccia va in quella direzione
//!
//! La tentazione naturale è mettere il downloader *sotto* la library, così che la
//! library "sappia scaricare". Ma il downloader deve scrivere il risultato **dentro**
//! la library (la entry del video, i metadati grezzi), e questo crea un ciclo:
//! `library → downloader → library`.
//!
//! Il ciclo esisteva davvero nella prima stesura di questo porting, ereditato dal
//! JavaScript: il wrapper di yt-dlp chiamava `set_metadata()` e
//! `remove_from_download_archive()`. La correzione è spostare l'orchestrazione
//! **sopra** invece che sotto: il downloader restituisce dati e non tocca lo stato,
//! `ops` scrive. Una sola direzione, e il downloader diventa testabile da solo.
//!
//! ## Divisione dei file
//!
//! ```text
//! data/
//!   sources.json          le sorgenti
//!   library.json          autori + video
//!   metadata/<id>.json    metadati grezzi, UNO PER VIDEO (vedi metadata.rs)
//!   covers/<id>.jpg       copertine
//!   authors/<key>.jpg     foto profilo
//! videos/                 configurabile, tipicamente su un altro disco
//!   <Autore>/<Titolo> [<id>].<ext>
//! ```
//!
//! `sources.json` e `library.json` si scrivono in **una sola transazione atomica**
//! (vedi [`commit`]): o entrambi nuovi, o entrambi vecchi, mai un miscuglio.

pub mod commit;
pub mod zip;
pub mod files;
pub mod metadata;
pub mod query;
pub mod schema;
pub mod search;
pub mod state;

pub use query::{authors, counts, to_download, videos, AuthorView, Counts, Filter};
pub use schema::{
    author_key_from, download_state, new_video, presence, video_category, Author, NewVideo, Source,
    Video, VideoCategory,
};
pub use search::search;
pub use state::{migrate_from_legacy, migration_pending, read, transaction, MigrationReport, State};
