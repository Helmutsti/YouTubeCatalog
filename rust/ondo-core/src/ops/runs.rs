//! Storico delle operazioni lunghe, in `data/jobs.json`.
//!
//! Non è una coda: è un registro scritto **una volta sola**, a operazione conclusa.
//! Nel JS lo storico veniva riscritto ogni 25 righe di log mentre il job girava, e
//! poteva quindi contenere righe di job che non erano mai terminati. Qui un record
//! esiste solo se l'operazione è finita, in un modo o nell'altro.
//!
//! I `logLines` non si conservano: sono già passati a schermo mentre l'operazione
//! girava, e tenerne migliaia per ogni download gonfiava il file senza che nessuno
//! le rileggesse.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::config::get_paths;
use crate::error::Result;
use crate::lock::FileLock;
use crate::time::now_iso8601;

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub finished_at: Option<String>,
    pub summary: Value,
    pub error: Option<String>,
}

fn read_store() -> Value {
    get_paths()
        .ok()
        .and_then(|p| std::fs::read_to_string(&p.runs_path).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({ "version": 1, "jobs": {} }))
}

fn write_store(store: &Value) -> Result<()> {
    let paths = get_paths()?;
    let tmp = paths.runs_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(store)?)?;
    std::fs::rename(&tmp, &paths.runs_path)?;
    Ok(())
}

/// Registra l'esito. Non fallisce mai in modo visibile: perdere una riga di storico
/// non deve far fallire l'operazione che l'ha appena portata a termine con successo.
pub fn record(kind: &str, params: Value, ok: bool, summary: Value, started_at: &str, error: Option<&str>) {
    let Ok(paths) = get_paths() else { return };
    let Ok(_guard) = FileLock::acquire(paths.data_dir.join("runs.lock")) else { return };

    // Id univoco senza generatore di UUID: timestamp + pid + contatore basta come chiave.
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let id = format!("{}-{}-{n}", now_iso8601().replace([':', '.'], "-"), std::process::id());

    let mut store = read_store();
    if let Some(jobs) = store.get_mut("jobs").and_then(Value::as_object_mut) {
        jobs.insert(
            id.clone(),
            json!({
                "id": id,
                "type": kind,
                "params": params,
                "status": if ok { "success" } else { "failed" },
                "queuedAt": started_at,
                "startedAt": started_at,
                "finishedAt": now_iso8601(),
                "logLines": [],
                "summary": summary,
                "error": error.map(|m| json!({ "message": m })).unwrap_or(Value::Null)
            }),
        );
    }
    let _ = write_store(&store);
}

pub fn list_runs(limit: usize) -> Result<Vec<RunRecord>> {
    let store = read_store();
    let mut runs: Vec<RunRecord> = store
        .get("jobs")
        .and_then(Value::as_object)
        .map(|m| {
            m.values()
                .map(|j| RunRecord {
                    id: j.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: j.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
                    status: j.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                    finished_at: j.get("finishedAt").and_then(Value::as_str).map(str::to_string),
                    summary: j.get("summary").cloned().unwrap_or(Value::Null),
                    error: j
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default();
    runs.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    runs.truncate(limit);
    Ok(runs)
}

pub fn clear_runs() -> Result<usize> {
    let paths = get_paths()?;
    let _guard = FileLock::acquire(paths.data_dir.join("runs.lock"))?;
    let removed = read_store()
        .get("jobs")
        .and_then(Value::as_object)
        .map(|m| m.len())
        .unwrap_or(0);
    write_store(&json!({ "version": 1, "jobs": {} }))?;
    Ok(removed)
}
