//! Lato Rust del banco differenziale (docs/rust-core.md §7).
//!
//! Stampa su stdout un JSON con l'esito delle operazioni portate, letto dallo
//! stesso `data/catalog.json` che legge l'implementazione JS. Il driver
//! `rust/difftest.mjs` esegue questo e il suo gemello in Node e **diffa**.
//!
//! Non è un test unitario: i test unitari verificano che il codice faccia ciò che
//! *credo*, questo verifica che faccia ciò che *fa il JS* — l'unica garanzia utile
//! finché le due implementazioni coesistono.
//!
//! Uso:  cargo run -p ondo-core --example dump

use ondo_core::library::{sanitize_name, target_rel_path};
use ondo_core::query::{list_channels_in, list_videos_in, VideoFilter};
use ondo_core::schema::download_state;
use ondo_core::search::search_in;
use ondo_core::store::read_catalog;
use serde_json::{json, Value};

/// Le stesse query usate dal lato JS. Includono i casi che hanno storia nel
/// progetto: un typo su un nome di canale ("sampuma" → "Sampurna", M7), una
/// query che non deve matchare nulla, e testo con accenti/emoji.
const QUERIES: [&str; 8] = [
    "asmr",
    "asmr sleep",
    "sampuma",
    "bel gramar",
    "zzzz nessuna corrispondenza",
    "créatôr",
    "🎧",
    "study with me",
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let catalog = read_catalog()?;

    // 1. listVideos senza filtri: ordine e flag derivati.
    let all = list_videos_in(&catalog, &VideoFilter::new());
    let videos: Vec<Value> = all
        .iter()
        .map(|v| {
            json!({
                "id": v.id(),
                "category": v.category().as_str(),
                "presence": v.presence(),
                "download": v.download(),
                "hidden": v.hidden(),
                "favorite": v.favorite(),
                "displayTitle": v.display_title(),
                // Il campo a più alto rischio: il percorso canonico deve
                // coincidere carattere per carattere con quello del JS.
                "targetRelPath": target_rel_path(v),
            })
        })
        .collect();

    // 2. Filtri sui singoli assi.
    let filtered = json!({
        "downloaded": list_videos_in(&catalog, &VideoFilter::new().download(download_state::DOWNLOADED))
            .iter().map(|v| v.id().to_string()).collect::<Vec<_>>(),
        "hidden": list_videos_in(&catalog, &VideoFilter::new().hidden(true))
            .iter().map(|v| v.id().to_string()).collect::<Vec<_>>(),
        "favorite": list_videos_in(&catalog, &VideoFilter::new().favorite(true))
            .iter().map(|v| v.id().to_string()).collect::<Vec<_>>(),
    });

    // 3. Canali: raggruppamento, conteggio, ordinamento.
    let channels: Vec<Value> = list_channels_in(&catalog, None)
        .iter()
        .map(|c| json!({ "key": c.key, "name": c.name, "count": c.count }))
        .collect();
    let channels_downloaded: Vec<Value> = list_channels_in(&catalog, Some(download_state::DOWNLOADED))
        .iter()
        .map(|c| json!({ "key": c.key, "name": c.name, "count": c.count }))
        .collect();

    // 4. Ricerca: ordine dei risultati (quindi implicitamente i punteggi).
    let mut search = serde_json::Map::new();
    for q in QUERIES {
        let ids: Vec<String> = search_in(&catalog, q, Some(50))
            .iter()
            .map(|v| v.id().to_string())
            .collect();
        search.insert(q.to_string(), json!(ids));
    }

    // 5. sanitizeName sui casi limite, isolata dal resto.
    let sanitize_cases = [
        "normale",
        "a<b>c:d\"e/f\\g|h?i*j",
        "  molti   spazi  ",
        "punti...",
        "spazio e punto . ",
        "CON",
        "com1",
        "CONSOLE",
        "Créatôr 🎧 ASMR",
        "",
        "///",
        "ASMR | Relaxing",
    ];
    let sanitized: Vec<Value> = sanitize_cases
        .iter()
        .map(|c| json!({ "in": c, "out": sanitize_name(Some(c), "Sconosciuto") }))
        .collect();

    let out = json!({
        "videos": videos,
        "filtered": filtered,
        "channels": channels,
        "channelsDownloaded": channels_downloaded,
        "search": Value::Object(search),
        "sanitize": sanitized,
    });

    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
