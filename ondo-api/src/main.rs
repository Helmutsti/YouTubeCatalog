//! # ondo-api
//!
//! Il server HTTP sopra la libreria: espone `/api`, serve i file multimediali con
//! le Range request (il seek del player) e, se c'è, la web app compilata.
//!
//! ```text
//! ondo-api                                  # ./ondo-data su http://127.0.0.1:3001
//! ondo-api --root D:\Video\ondo-data        # una libreria che vive altrove
//! ondo-api --root \\nas\video\ondo --port 8080 --bind 0.0.0.0
//! ```
//!
//! La libreria **non sta dentro il server**: gliela si indica da fuori. E dentro la
//! libreria, `config.json` può puntare `videos`/`covers`/`metadata` a percorsi
//! assoluti, quindi i file possono stare su un altro disco ancora.
//!
//! ⚠️ **Un solo processo per libreria.** Ogni processo tiene `library.json` in
//! memoria e lo riscrive quando salva: server e CLI aperti insieme si sovrascrivono
//! a vicenda. È una regola, non un vincolo imposto dal codice.

mod api;
mod public;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::Router;
use ondo::Library;
use state::Stato;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() {
    if let Err(e) = avvia().await {
        eprintln!("✗ {e}");
        std::process::exit(1);
    }
}

/// Le impostazioni di avvio: prima gli argomenti, poi le variabili d'ambiente, poi
/// i default. Gli argomenti vincono perché sono quello che si legge nel comando.
struct Avvio {
    root: String,
    bind: String,
    port: u16,
    web: PathBuf,
}

const AIUTO: &str = "\
ondo-api — server HTTP sopra la libreria Ondo

USO
  ondo-api [OPZIONI]

OPZIONI
  --root <cartella>   la libreria da servire        (o ONDO_ROOT, default ./ondo-data)
  --port <numero>     porta                          (o ONDO_PORT, default 3001)
  --bind <indirizzo>  su che indirizzo ascoltare     (o ONDO_BIND, default 127.0.0.1)
  --web <cartella>    la web app compilata           (o ONDO_WEB, default ondo-api/web/dist)
  -h, --help          questo testo

NOTE
  La libreria vive dove dici tu: il server non ci tiene niente dentro di sé.
  Dentro la libreria, config.json puo' puntare videos/covers/metadata a percorsi
  assoluti, per tenere i file su un altro disco.
  Un solo processo per libreria: non tenere aperta anche la CLI.
";

fn leggi_argomenti() -> Result<Avvio, String> {
    let mut avvio = Avvio {
        root: std::env::var("ONDO_ROOT").unwrap_or_else(|_| "ondo-data".into()),
        bind: std::env::var("ONDO_BIND").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("ONDO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3001),
        web: PathBuf::from(std::env::var("ONDO_WEB").unwrap_or_else(|_| "ondo-api/web/dist".into())),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut valore = || it.next().ok_or_else(|| format!("manca il valore di {flag}"));
        match flag.as_str() {
            "--root" => avvio.root = valore()?,
            "--bind" => avvio.bind = valore()?,
            "--web" => avvio.web = PathBuf::from(valore()?),
            "--port" => {
                let raw = valore()?;
                avvio.port = raw.parse().map_err(|_| format!("--port: {raw} non è una porta"))?;
            }
            "-h" | "--help" => {
                print!("{AIUTO}");
                std::process::exit(0);
            }
            altro => return Err(format!("argomento non riconosciuto: {altro}\n\n{AIUTO}")),
        }
    }
    Ok(avvio)
}

async fn avvia() -> Result<(), Box<dyn std::error::Error>> {
    let avvio = leggi_argomenti()?;
    let root = avvio.root;
    let lib = Library::open(&root)?;

    // Le cartelle si leggono adesso: montare uno `ServeDir` significa fissare un
    // percorso, quindi cambiare le cartelle dalle impostazioni richiede un riavvio.
    let videos = lib.config().videos_dir();
    let covers = lib.config().covers_dir();
    avvisi(&lib);

    let stato = Stato::new(lib);
    let mut app = Router::new()
        .merge(api::router(std::sync::Arc::clone(&stato)))
        // `ServeDir` porta le Range request e gli ETag: è quello che permette al
        // player nel browser di saltare a metà video senza scaricarlo tutto.
        .nest_service("/media/videos", ServeDir::new(&videos))
        .nest_service("/media/covers", ServeDir::new(&covers))
        // Strumento locale per una persona sola: nessun motivo di litigare col CORS
        // quando la web app gira dal server di sviluppo di vite.
        .layer(CorsLayer::permissive());

    // La web app compilata, se è stata costruita. Le rotte del router SPA non sono
    // file: qualunque percorso non trovato torna `index.html`, che poi decide lui.
    let web = avvio.web;
    let stato_web = if web.join("index.html").is_file() {
        let index = ServeFile::new(web.join("index.html"));
        app = app.fallback_service(ServeDir::new(&web).fallback(index));
        format!("{}", web.display())
    } else {
        app = app.fallback(senza_web);
        format!("non compilata ({}) — l'API funziona comunque", web.display())
    };

    let addr: SocketAddr = format!("{}:{}", avvio.bind, avvio.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Dove sono le cose, scritto all'avvio: è la risposta a «da quale cartella sta
    // attingendo?» senza dover indovinare.
    println!("ondo-api");
    println!("  libreria    {root}");
    println!("  video       {}", videos.display());
    println!("  copertine   {}", covers.display());
    println!("  web app     {stato_web}");
    println!("  in ascolto  http://{addr}");
    println!("  un solo processo per libreria: non tenere aperta anche la CLI");
    axum::serve(listener, app).with_graceful_shutdown(ctrl_c()).await?;
    Ok(())
}

/// Gli stessi controlli che fa la CLI all'avvio: un binario mancante si dice adesso,
/// non a metà del primo download.
fn avvisi(lib: &Library) {
    let c = lib.config();
    let mut mancanti = Vec::new();
    for (nome, path) in [("yt-dlp", &c.ytdlp), ("ffmpeg", &c.ffmpeg), ("ffprobe", &c.ffprobe)] {
        if !path.is_file() {
            mancanti.push(format!("{nome} ({})", path.display()));
        }
    }
    if ondo::config::js_runtime().is_none() {
        mancanti.push(format!(
            "un runtime JavaScript per yt-dlp ({})",
            ondo::config::JS_RUNTIME_NAMES.join(", ")
        ));
    }
    if !mancanti.is_empty() {
        eprintln!("✗ non trovo: {}. I download falliranno.", mancanti.join(", "));
    }
}

async fn senza_web() -> axum::response::Html<&'static str> {
    axum::response::Html(
        "<h1>ondo-api</h1><p>L'API risponde sotto <code>/api</code>. \
         La web app non è compilata: <code>npm run build</code> in <code>ondo-api/web</code>.</p>",
    )
}

async fn ctrl_c() {
    let _ = tokio::signal::ctrl_c().await;
    println!("\nchiudo");
}
