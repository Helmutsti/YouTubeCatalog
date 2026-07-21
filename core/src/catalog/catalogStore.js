import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getPaths } from '../config.js';
import { createEmptyCatalog, VIDEO_STATUS } from './catalogSchema.js';

let catalog = null;
let loadPromise = null;
let writeQueue = Promise.resolve();

function readCatalogFromDisk() {
  const { catalogPath } = getPaths();
  if (!existsSync(catalogPath)) {
    return createEmptyCatalog();
  }
  return JSON.parse(readFileSync(catalogPath, 'utf-8'));
}

function reconcileOnLoad(cat) {
  let changed = false;
  for (const video of Object.values(cat.videos)) {
    if (video.status === VIDEO_STATUS.DOWNLOADING) {
      video.status = VIDEO_STATUS.PENDING;
      video.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  // Migrazione: cataloghi scritti prima dell'introduzione delle foto profilo
  // dei canali (M14) non hanno ancora questo campo.
  if (!cat.channelAvatars) {
    cat.channelAvatars = {};
    changed = true;
  }
  return changed;
}

function persistToDisk(cat) {
  const { catalogPath } = getPaths();
  const tmpPath = `${catalogPath}.tmp`;
  cat.meta.lastUpdated = new Date().toISOString();
  writeFileSync(tmpPath, JSON.stringify(cat, null, 2), 'utf-8');
  renameSync(tmpPath, catalogPath);
}

async function ensureLoaded() {
  if (catalog) return catalog;
  if (!loadPromise) {
    loadPromise = (async () => {
      const loaded = readCatalogFromDisk();
      if (reconcileOnLoad(loaded)) {
        persistToDisk(loaded);
      }
      catalog = loaded;
      return catalog;
    })();
  }
  return loadPromise;
}

export async function readCatalog() {
  return ensureLoaded();
}

// Serializza tutte le mutazioni su un'unica coda (mutex asincrono): garantisce
// che due mutazioni concorrenti non si sovrascrivano a vicenda. Se il mutator
// lancia un errore, viene catturato qui e ri-lanciato al solo chiamante che lo
// ha causato, senza "avvelenare" la coda per le mutazioni successive.
export async function updateCatalog(mutator) {
  await ensureLoaded();
  let result;
  let error;
  writeQueue = writeQueue.then(async () => {
    try {
      result = await mutator(catalog);
      persistToDisk(catalog);
    } catch (err) {
      error = err;
    }
  });
  await writeQueue;
  if (error) throw error;
  return result;
}
