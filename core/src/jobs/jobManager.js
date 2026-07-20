import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from '../config.js';

const emitter = new EventEmitter();
const jobs = new Map();
const queue = [];
const handlers = new Map(); // type -> async (params, ctx) => summary
let processing = false;

export function registerJobHandler(type, handler) {
  handlers.set(type, handler);
}

function jobFilePath(id) {
  return path.join(getPaths().jobsDir, `${id}.json`);
}

function persistJob(job) {
  writeFileSync(jobFilePath(job.id), JSON.stringify(job, null, 2), 'utf-8');
}

export function triggerJob(type, params = {}) {
  if (!handlers.has(type)) throw new Error(`Tipo di job sconosciuto: "${type}"`);

  const job = {
    id: randomUUID(),
    type,
    params,
    status: 'queued',
    startedAt: null,
    finishedAt: null,
    logLines: [],
    summary: null,
    error: null
  };
  jobs.set(job.id, job);
  persistJob(job);
  queue.push(job.id);
  emitter.emit(`job:${job.id}:status`, job.status);
  processQueue();
  return { jobId: job.id };
}

export function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const filePath = jobFilePath(id);
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf-8')) : null;
}

export function listJobs(limit = 50) {
  const dir = getPaths().jobsDir;
  const onDiskIds = existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '')) : [];
  const allIds = new Set([...jobs.keys(), ...onDiskIds]);
  return [...allIds]
    .map((id) => getJob(id))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, limit);
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
  persistJob(job);
  emitter.emit(`job:${job.id}:status`, job.status);

  let linesSinceFlush = 0;
  const log = (line) => {
    job.logLines.push(line);
    emitter.emit(`job:${job.id}:log`, line);
    linesSinceFlush += 1;
    if (linesSinceFlush >= 25) {
      persistJob(job);
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
    persistJob(job);
    emitter.emit(`job:${job.id}:status`, job.status);
    processing = false;
    processQueue();
  }
}
