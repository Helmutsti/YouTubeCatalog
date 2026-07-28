//! `ops` — l'**orchestrazione**: le operazioni che l'utente riconosce come tali.
//!
//! È l'unico layer che vede sia [`crate::library`] sia [`crate::downloader`], ed è
//! per questo che esiste: il downloader restituisce dati e la library li persiste,
//! ma qualcuno deve mettere in fila le due cose. Se quel "qualcuno" stesse *dentro*
//! la library avremmo il ciclo `library → downloader → library`.
//!
//! ## Niente coda in background
//!
//! L'implementazione JavaScript aveva un `jobManager`: coda single-worker,
//! `EventEmitter` con canali per job, storico persistito, `AbortController`. Serviva
//! ad alimentare **via SSE** un pannello job nel browser. Con il frontend fuori
//! scope, l'unico consumatore è una CLI **bloccante per progetto** (un solo flusso
//! interattivo alla volta): le operazioni girano in primo piano e riportano su un
//! [`crate::downloader::Reporter`].
//!
//! Oltre alle ~600 righe risparmiate, il guadagno vero è che **nessuna operazione
//! può restare orfana**. Nel JS un processo morto lasciava job `running` per sempre,
//! né interrompibili né cancellabili (l'`AbortController` viveva solo in memoria), e
//! serviva una `reconcileOrphanJobs()` per ripulirli all'avvio. Senza coda in
//! background quello stato non è nemmeno rappresentabile.
//!
//! Lo **storico** resta: [`runs`] registra l'esito di ogni operazione lunga.

pub mod download;
pub mod maintain;
pub mod runs;
pub mod sources;
pub mod sync;

pub use download::{download_many, enrich, DownloadReport, EnrichReport};
pub use maintain::{
    delete_video_completely, delete_video_file, migrate_all, reorganize_library, set_favorite,
    set_hidden, sync_author_avatars, MigrateReport, ReorganizeReport,
};
pub use runs::{list_runs, clear_runs, RunRecord};
pub use sources::{add_source, quick_download_target, remove_source, QuickTarget};
pub use sync::{sync_all, sync_source, SyncReport};
