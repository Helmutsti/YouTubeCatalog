import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getPaths } from '../config.js';
import { acquireDataLock } from '../lock.js';

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
  const release = acquireDataLock();
  try {
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmpPath, metadataPath);
  } finally {
    release();
  }
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
// Rimuove i metadati grezzi di un video (usata dalla cancellazione totale,
// M-punto 11): a differenza di setMetadata non fallisce se l'id non c'è.
export async function deleteMetadata(id) {
  await ensureLoaded();
  let error;
  writeQueue = writeQueue.then(async () => {
    const release = acquireDataLock();
    try {
      // M92 — rilettura da disco dentro il lock, stesso motivo di
      // updateCatalog (catalogStore.js): il lock adesso si prende solo per la
      // scrittura, non per l'intera sessione, quindi un altro processo può
      // aver scritto metadata.json da quando questo processo l'ha caricato.
      metadata = readMetadataFromDisk();
      if (id in metadata) {
        delete metadata[id];
        persistToDisk(metadata);
      }
    } catch (err) {
      error = err;
    } finally {
      release();
    }
  });
  await writeQueue;
  if (error) throw error;
}

export async function setMetadata(id, info) {
  await ensureLoaded();
  // automatic_captions elenca URL di sottotitoli auto-tradotti in 150+ lingue:
  // quasi mai utile, gonfia il file di centinaia di KB per video. Rimosso qui,
  // punto unico di scrittura, così ogni chiamante ne beneficia senza doverci pensare.
  const { automatic_captions, ...trimmed } = info;
  let error;
  writeQueue = writeQueue.then(async () => {
    const release = acquireDataLock();
    try {
      // M92 — vedi il commento in deleteMetadata qui sopra.
      metadata = readMetadataFromDisk();
      metadata[id] = trimmed;
      persistToDisk(metadata);
    } catch (err) {
      error = err;
    } finally {
      release();
    }
  });
  await writeQueue;
  if (error) throw error;
}
