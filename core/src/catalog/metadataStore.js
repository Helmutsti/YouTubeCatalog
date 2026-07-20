import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getPaths } from '../config.js';

let metadata = null;
let loadPromise = null;
let writeQueue = Promise.resolve();

function readMetadataFromDisk() {
  const { metadataPath } = getPaths();
  if (!existsSync(metadataPath)) return {};
  return JSON.parse(readFileSync(metadataPath, 'utf-8'));
}

function persistToDisk(store) {
  const { metadataPath } = getPaths();
  const tmpPath = `${metadataPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, metadataPath);
}

async function ensureLoaded() {
  if (metadata) return metadata;
  if (!loadPromise) {
    loadPromise = (async () => {
      metadata = readMetadataFromDisk();
      return metadata;
    })();
  }
  return loadPromise;
}

export async function readMetadata(id) {
  await ensureLoaded();
  return metadata[id] ?? null;
}

// Stessa strategia di mutex di catalogStore.js: coda di promise, errori isolati
// al chiamante che li ha causati senza bloccare le scritture successive.
export async function setMetadata(id, info) {
  await ensureLoaded();
  // automatic_captions elenca URL di sottotitoli auto-tradotti in 150+ lingue:
  // quasi mai utile, gonfia il file di centinaia di KB per video. Rimosso qui,
  // punto unico di scrittura, così ogni chiamante ne beneficia senza doverci pensare.
  const { automatic_captions, ...trimmed } = info;
  let error;
  writeQueue = writeQueue.then(async () => {
    try {
      metadata[id] = trimmed;
      persistToDisk(metadata);
    } catch (err) {
      error = err;
    }
  });
  await writeQueue;
  if (error) throw error;
}
