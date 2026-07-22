import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from '../config.js';

const emitter = new EventEmitter();
const jobs = new Map();
const queue = [];
const handlers = new Map(); // type -> async (params, ctx) => summary
let processing = false;
let loaded = false;

export function registerJobHandler(type, handler) {
  handlers.set(type, handler);
}

function storeFilePath() {
  return path.join(getPaths().dataDir, 'jobs.json');
}

// Carica lo storico in memoria una sola volta. Se data/jobs.json non esiste ma
// c'è ancora il vecchio layout "un file per job" (data/jobs/<id>.json), lo
// consolida in un colpo solo e rimuove i vecchi file: migrazione una tantum
// trasparente, senza perdere nessun job già registrato.
function ensureLoaded() {
  if (loaded) return;

  const file = storeFilePath();
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    for (const [id, job] of Object.entries(data.jobs ?? {})) jobs.set(id, job);
    loaded = true;
    return;
  }

  const dir = getPaths().jobsDir;
  const migratedFiles = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const job = JSON.parse(readFileSync(full, 'utf-8'));
        if (job && job.id) {
          jobs.set(job.id, job);
          migratedFiles.push(full);
        }
      } catch {
        // File corrotto: lo si salta, non deve bloccare la migrazione.
      }
    }
  }
  loaded = true;
  persistStore();
  for (const f of migratedFiles) {
    try { rmSync(f); } catch { /* best-effort: il consolidato è già scritto */ }
  }
}

// Scrittura atomica dell'intero storico (tmp + rename, atomico su NTFS). Le
// mutazioni avvengono sempre in modo sincrono dentro il worker single-thread
// (nessun await tra la modifica della Map in memoria e il persist), quindi non
// serve il mutex asincrono di catalogStore: due persist non possono
// interlacciarsi nello stesso processo.
function persistStore() {
  const file = storeFilePath();
  const tmp = `${file}.tmp`;
  const data = { version: 1, jobs: Object.fromEntries(jobs) };
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, file);
}

export function triggerJob(type, params = {}) {
  if (!handlers.has(type)) throw new Error(`Tipo di job sconosciuto: "${type}"`);
  ensureLoaded();

  const job = {
    id: randomUUID(),
    type,
    params,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    logLines: [],
    summary: null,
    error: null
  };
  jobs.set(job.id, job);
  persistStore();
  queue.push(job.id);
  emitter.emit(`job:${job.id}:status`, job.status);
  processQueue();
  return { jobId: job.id };
}

export function getJob(id) {
  ensureLoaded();
  return jobs.get(id) ?? null;
}

// Ordine più recenti prima. Un job appena messo in coda non ha ancora
// `startedAt` (parte solo quando il worker single-thread lo raggiunge): senza
// ripiego su `queuedAt` finirebbe in fondo alla lista invece che in cima,
// vanificando l'aggiunta "istantanea" (l'item deve comparire subito, non solo
// quando il worker lo prende in carico).
export function listJobs(limit = 50) {
  ensureLoaded();
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt || b.queuedAt || '').localeCompare(a.startedAt || a.queuedAt || ''))
    .slice(0, limit);
}

// Cancella un job dallo storico: rimuove solo il record (il video, i file su
// disco e la voce di catalogo restano intatti). Un job `running`/`queued` non è
// cancellabile — non esiste un meccanismo di abort, quindi cancellarne il record
// lascerebbe il worker a girare "orfano".
export function deleteJob(id) {
  ensureLoaded();
  const job = jobs.get(id);
  if (!job) throw new Error(`Job non trovato: "${id}"`);
  if (job.status === 'running' || job.status === 'queued') {
    throw new Error('Non puoi cancellare un job in corso o in coda: attendi che finisca.');
  }
  jobs.delete(id);
  persistStore();
  return { deleted: 1 };
}

// Svuota lo storico: cancella tutti i job terminati (`success`/`failed`),
// lasciando intatti gli eventuali `running`/`queued`. Un solo persist a fine
// giro. Ritorna quanti ne ha rimossi.
export function clearJobs() {
  ensureLoaded();
  let deleted = 0;
  for (const job of [...jobs.values()]) {
    if (job.status === 'running' || job.status === 'queued') continue;
    jobs.delete(job.id);
    deleted += 1;
  }
  if (deleted) persistStore();
  return { deleted };
}

export function onJobLog(id, callback) {
  emitter.on(`job:${id}:log`, callback);
  return () => emitter.off(`job:${id}:log`, callback);
}

export function onJobStatus(id, callback) {
  emitter.on(`job:${id}:status`, callback);
  return () => emitter.off(`job:${id}:status`, callback);
}

export function onJobProgress(id, callback) {
  emitter.on(`job:${id}:progress`, callback);
  return () => emitter.off(`job:${id}:progress`, callback);
}

async function processQueue() {
  if (processing) return;
  const nextId = queue.shift();
  if (!nextId) return;

  processing = true;
  const job = jobs.get(nextId);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  persistStore();
  emitter.emit(`job:${job.id}:status`, job.status);

  let linesSinceFlush = 0;
  const log = (line) => {
    job.logLines.push(line);
    emitter.emit(`job:${job.id}:log`, line);
    linesSinceFlush += 1;
    if (linesSinceFlush >= 25) {
      persistStore();
      linesSinceFlush = 0;
    }
  };
  const progress = (pct) => emitter.emit(`job:${job.id}:progress`, pct);

  try {
    const handler = handlers.get(job.type);
    job.summary = await handler(job.params, { log, progress });
    job.status = 'success';
  } catch (err) {
    job.status = 'failed';
    job.error = { message: err.message };
    log(`✘ Job fallito: ${err.message}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    persistStore();
    emitter.emit(`job:${job.id}:status`, job.status);
    processing = false;
    processQueue();
  }
}
