//! Le route sotto `/api`.
//!
//! Ogni handler è sottile per costruzione: chiama una funzione della libreria e
//! traduce il risultato in JSON. Nessuna regola di stato vive qui — se una cosa non
//! si può fare, è la libreria a dirlo, e noi la riportiamo con un codice HTTP.

use std::sync::Arc;

use axum::extract::{Path, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use ondo::{Filter, Quality, State};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::public;
use crate::state::Stato;

pub type Risposta = Result<Json<Value>, Errore>;

/// Un errore con il suo codice. La libreria non conosce HTTP: la traduzione sta qui,
/// in un posto solo.
pub struct Errore(StatusCode, String);

impl IntoResponse for Errore {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<ondo::Error> for Errore {
    fn from(e: ondo::Error) -> Self {
        Errore(StatusCode::BAD_REQUEST, e.0)
    }
}

fn assente(cosa: impl std::fmt::Display) -> Errore {
    Errore(StatusCode::NOT_FOUND, cosa.to_string())
}

fn conflitto(cosa: impl std::fmt::Display) -> Errore {
    Errore(StatusCode::CONFLICT, cosa.to_string())
}

pub fn router(stato: Arc<Stato>) -> Router {
    Router::new()
        .route("/api/videos", get(elenco))
        .route("/api/videos/{id}", get(dettaglio).delete(rimuovi))
        .route("/api/videos/{id}/metadata", get(metadata))
        .route("/api/videos/{id}/favorite", post(favorite))
        .route("/api/videos/{id}/archived", post(archived))
        .route("/api/videos/{id}/download", post(riscarica))
        .route("/api/search", get(cerca))
        .route("/api/authors", get(autori))
        .route("/api/authors/{name}/videos", get(video_autore))
        .route("/api/queue", get(coda).post(accoda).delete(disaccoda))
        .route("/api/jobs", get(jobs))
        .route("/api/events", get(eventi))
        .route("/api/stats", get(stats))
        .route("/api/config", get(config_leggi).patch(config_scrivi))
        .with_state(stato)
}

// ── Lettura ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ElencoQuery {
    /// `all` (default), `downloaded`, `pending`, `failed`, `favorites`, `archived`,
    /// `removed`.
    filter: Option<String>,
}

fn filtro(nome: Option<&str>) -> Result<Filter, Errore> {
    Ok(match nome.unwrap_or("all") {
        "all" => Filter::All,
        "downloaded" => Filter::Downloaded,
        "pending" | "available" => Filter::Pending,
        "failed" => Filter::Failed,
        "favorites" => Filter::Favorites,
        "archived" | "hidden" => Filter::Archived,
        "removed" => Filter::Removed,
        altro => {
            return Err(Errore(StatusCode::BAD_REQUEST, format!("filtro sconosciuto: {altro}")))
        }
    })
}

async fn elenco(AxState(stato): AxState<Arc<Stato>>, Query(q): Query<ElencoQuery>) -> Risposta {
    let f = filtro(q.filter.as_deref())?;
    let lib = stato.lib();
    let video: Vec<Value> = lib.list(f).into_iter().map(|v| public::video(&lib, v)).collect();
    Ok(Json(json!({ "videos": video })))
}

async fn dettaglio(AxState(stato): AxState<Arc<Stato>>, Path(id): Path<String>) -> Risposta {
    let lib = stato.lib();
    let v = lib.get(&id).ok_or_else(|| assente(format!("nessun video con id {id}")))?;
    Ok(Json(public::video(&lib, v)))
}

async fn metadata(AxState(stato): AxState<Arc<Stato>>, Path(id): Path<String>) -> Risposta {
    let meta = stato.lib().metadata(&id)?;
    Ok(Json(meta))
}

#[derive(Deserialize)]
pub struct CercaQuery {
    q: Option<String>,
}

async fn cerca(AxState(stato): AxState<Arc<Stato>>, Query(q): Query<CercaQuery>) -> Risposta {
    let lib = stato.lib();
    let query = q.q.unwrap_or_default();
    let video: Vec<Value> = lib.search(&query).into_iter().map(|v| public::video(&lib, v)).collect();
    Ok(Json(json!({ "query": query, "videos": video })))
}

async fn autori(AxState(stato): AxState<Arc<Stato>>) -> Risposta {
    let autori: Vec<Value> = stato
        .lib()
        .authors()
        .into_iter()
        .map(|(nome, quanti)| json!({ "name": nome, "count": quanti }))
        .collect();
    Ok(Json(json!({ "authors": autori })))
}

/// I video di un autore. La chiave è il **nome**, ma si accetta anche l'id del
/// canale: il frontend costruisce i suoi link con `channel.id` quando c'è, e non
/// vale la pena rompere quei collegamenti per una chiave diversa.
async fn video_autore(AxState(stato): AxState<Arc<Stato>>, Path(chiave): Path<String>) -> Risposta {
    let lib = stato.lib();
    let nome = if lib.authors().iter().any(|(a, _)| *a == chiave) {
        chiave.clone()
    } else {
        match lib
            .list(Filter::All)
            .into_iter()
            .find(|v| v.author_id.as_deref() == Some(chiave.as_str()))
        {
            Some(v) => v.author.clone(),
            None => return Err(assente(format!("nessun autore «{chiave}»"))),
        }
    };
    let video: Vec<Value> = lib.by_author(&nome).into_iter().map(|v| public::video(&lib, v)).collect();
    Ok(Json(json!({ "author": nome, "videos": video })))
}

async fn stats(AxState(stato): AxState<Arc<Stato>>) -> Risposta {
    let lib = stato.lib();
    let conta = |f: Filter| lib.count(f);
    let coda = lib.queue();
    Ok(Json(json!({
        "total": lib.len(),
        "counts": {
            "all": conta(Filter::All),
            "downloaded": conta(Filter::Downloaded),
            "pending": conta(Filter::Pending),
            "failed": conta(Filter::Failed),
            "favorites": conta(Filter::Favorites),
            "archived": conta(Filter::Archived),
            "removed": conta(Filter::Removed),
        },
        "queue": { "waiting": coda.iter().filter(|q| q.error.is_none()).count(),
                   "failed": coda.iter().filter(|q| q.error.is_some()).count() },
        "missingFiles": lib.missing_files().len(),
    })))
}

async fn jobs(AxState(stato): AxState<Arc<Stato>>) -> Risposta {
    let (in_corso, in_coda) = {
        let dl = stato.dl();
        (dl.in_flight(), dl.queued())
    };
    let jobs: Vec<Value> = stato.dl().statuses().iter().map(public::job).collect();
    Ok(Json(json!({ "jobs": jobs, "inFlight": in_corso, "queued": in_coda })))
}

/// Gli eventi dei download, dal vivo. È il canale su cui il frontend fa muovere le
/// barre: gli stessi eventi che la console della CLI disegna.
async fn eventi(
    AxState(stato): AxState<Arc<Stato>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let rx = stato.eventi.subscribe();
    let flusso = BroadcastStream::new(rx).filter_map(|r| r.ok().map(|riga| Ok(SseEvent::default().data(riga))));
    Sse::new(flusso).keep_alive(KeepAlive::default())
}

// ── Scrittura ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct Valore {
    value: bool,
}

async fn favorite(
    AxState(stato): AxState<Arc<Stato>>,
    Path(id): Path<String>,
    Json(v): Json<Valore>,
) -> Risposta {
    if !stato.lib().set_favorite(&id, v.value)? {
        return Err(assente(format!("nessun video con id {id}")));
    }
    Ok(Json(json!({ "id": id, "favorite": v.value })))
}

async fn archived(
    AxState(stato): AxState<Arc<Stato>>,
    Path(id): Path<String>,
    Json(v): Json<Valore>,
) -> Risposta {
    if !stato.lib().set_archived(&id, v.value)? {
        return Err(assente(format!("nessun video con id {id}")));
    }
    Ok(Json(json!({ "id": id, "archived": v.value })))
}

#[derive(Deserialize)]
pub struct QualitaQuery {
    /// Tetto di risoluzione per **questo** download; assente = la predefinita.
    #[serde(rename = "maxHeight")]
    max_height: Option<u32>,
}

/// Rimette in coda un video già in libreria (fallito, o da riscaricare).
async fn riscarica(
    AxState(stato): AxState<Arc<Stato>>,
    Path(id): Path<String>,
    Query(q): Query<QualitaQuery>,
) -> Risposta {
    // Un lock alla volta: si decide con la libreria, poi si accoda nel pool.
    let url = {
        let mut lib = stato.lib();
        match lib.get(&id).map(|v| v.state) {
            None => return Err(assente(format!("nessun video con id {id}"))),
            Some(State::Downloading) => return Err(conflitto("questo video è già in download")),
            Some(_) => {}
        }
        lib.retry(&id)?.unwrap_or_default()
    };
    if url.is_empty() {
        return Err(Errore(StatusCode::BAD_REQUEST, "questo video non ha un URL da riscaricare".into()));
    }
    let job = spinge(&stato, &url, q.max_height);
    Ok(Json(json!({ "id": id, "job": job })))
}

async fn rimuovi(
    AxState(stato): AxState<Arc<Stato>>,
    Path(id): Path<String>,
    Query(q): Query<RimuoviQuery>,
) -> Risposta {
    let anche_file = q.delete_files.unwrap_or(false);
    if !stato.lib().remove(&id, anche_file)? {
        return Err(assente(format!("nessun video con id {id}")));
    }
    Ok(Json(json!({ "id": id, "deletedFiles": anche_file })))
}

#[derive(Deserialize)]
pub struct RimuoviQuery {
    #[serde(rename = "deleteFiles")]
    delete_files: Option<bool>,
}

async fn coda(AxState(stato): AxState<Arc<Stato>>) -> Risposta {
    let lib = stato.lib();
    let coda: Vec<Value> = lib
        .queue()
        .iter()
        .map(|q| json!({ "url": q.url, "error": q.error, "at": q.at }))
        .collect();
    Ok(Json(json!({ "queue": coda })))
}

#[derive(Deserialize)]
pub struct NuovoLink {
    url: String,
    #[serde(rename = "maxHeight")]
    max_height: Option<u32>,
}

/// Accoda un link nuovo: è il «download singolo» dell'API originale.
async fn accoda(AxState(stato): AxState<Arc<Stato>>, Json(body): Json<NuovoLink>) -> Risposta {
    let url = body.url.trim().to_string();
    if url.is_empty() {
        return Err(Errore(StatusCode::BAD_REQUEST, "manca l'url".into()));
    }
    stato.lib().enqueue(&url)?;
    let job = spinge(&stato, &url, body.max_height);
    Ok(Json(json!({ "url": url, "job": job })))
}

#[derive(Deserialize)]
pub struct LinkDaTogliere {
    url: String,
}

async fn disaccoda(AxState(stato): AxState<Arc<Stato>>, Json(body): Json<LinkDaTogliere>) -> Risposta {
    let togliato = stato.lib().dequeue(&body.url)?;
    if !togliato {
        return Err(assente("quel link non è in coda"));
    }
    Ok(Json(json!({ "url": body.url, "removed": true })))
}

/// Accoda nel pool, con la qualità di questo download o quella predefinita.
fn spinge(stato: &Arc<Stato>, url: &str, max_height: Option<u32>) -> u64 {
    match max_height {
        Some(h) => stato.dl().push_with(url.to_string(), Some(h)),
        None => stato.dl().push(url.to_string()),
    }
}

// ── Impostazioni ────────────────────────────────────────────────────────────

async fn config_leggi(AxState(stato): AxState<Arc<Stato>>) -> Risposta {
    let lib = stato.lib();
    let c = lib.config();
    let js = ondo::config::js_runtime();
    Ok(Json(json!({
        "quality": qualita_json(c.quality),
        "parallel": c.parallel,
        "vlc": c.vlc.as_ref().map(|p| p.display().to_string()),
        "cookies": c.cookies.as_ref().map(|p| p.display().to_string()),
        "paths": {
            "root": c.root.display().to_string(),
            "videos": c.videos_dir().display().to_string(),
            "covers": c.covers_dir().display().to_string(),
            "metadata": c.metadata_dir().display().to_string(),
        },
        "tools": {
            "ytdlp": { "path": c.ytdlp.display().to_string(), "found": c.ytdlp.is_file() },
            "ffmpeg": { "path": c.ffmpeg.display().to_string(), "found": c.ffmpeg.is_file() },
            "ffprobe": { "path": c.ffprobe.display().to_string(), "found": c.ffprobe.is_file() },
            "jsRuntime": js.map(|(n, p)| json!({ "name": n, "path": p.display().to_string() })),
        },
    })))
}

fn qualita_json(q: Quality) -> Value {
    match q {
        Quality::Best => json!("best"),
        Quality::Ask => json!("ask"),
        Quality::Height(h) => json!(h),
    }
}

#[derive(Deserialize)]
pub struct ConfigPatch {
    /// `"best"`, `"ask"` oppure un numero (l'altezza massima).
    quality: Option<Value>,
    parallel: Option<usize>,
    /// Stringa vuota = dimentica il percorso.
    vlc: Option<String>,
    cookies: Option<String>,
}

async fn config_scrivi(AxState(stato): AxState<Arc<Stato>>, Json(p): Json<ConfigPatch>) -> Risposta {
    let mut parallelismo = None;
    {
        let mut lib = stato.lib();
        let cfg = lib.config_mut();
        if let Some(q) = &p.quality {
            cfg.quality = match q {
                Value::String(s) if s == "best" => Quality::Best,
                Value::String(s) if s == "ask" => Quality::Ask,
                Value::Number(n) => match n.as_u64() {
                    Some(h) if h >= 144 => Quality::Height(h as u32),
                    _ => return Err(Errore(StatusCode::BAD_REQUEST, "altezza non valida".into())),
                },
                _ => {
                    return Err(Errore(
                        StatusCode::BAD_REQUEST,
                        "quality: «best», «ask» o un numero".into(),
                    ))
                }
            };
        }
        if let Some(n) = p.parallel {
            if !(1..=16).contains(&n) {
                return Err(Errore(StatusCode::BAD_REQUEST, "parallel: da 1 a 16".into()));
            }
            cfg.parallel = n;
            parallelismo = Some(n);
        }
        if let Some(v) = &p.vlc {
            cfg.vlc = (!v.trim().is_empty()).then(|| std::path::PathBuf::from(v.trim()));
        }
        if let Some(c) = &p.cookies {
            cfg.cookies = (!c.trim().is_empty()).then(|| std::path::PathBuf::from(c.trim()));
        }
        lib.save_config()?;
    }
    // Il parallelismo si applica a caldo, come nella CLI.
    if let Some(n) = parallelismo {
        stato.dl().set_parallel(n);
    }
    config_leggi(AxState(stato)).await
}
