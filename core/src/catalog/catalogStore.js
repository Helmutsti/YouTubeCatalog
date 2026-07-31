import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getPaths } from '../config.js';
import { createEmptyCatalog, DOWNLOAD_STATE, migrateVideoToFlags, migrateVideoToSources } from './catalogSchema.js';

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
    // Migrazione una tantum (M25) dal vecchio `status` singolo ai flag ortogonali.
    if (migrateVideoToFlags(video)) changed = true;
    // Migrazione una tantum (M41) dal vecchio `source` singolo a `sources` (array).
    if (migrateVideoToSources(video, cat.sources)) changed = true;
    // Reconciliation: un download interrotto a metà (processo morto durante
    // il download) va riportato a "none" e rifatto da zero al prossimo trigger.
    if (video.download === DOWNLOAD_STATE.DOWNLOADING) {
      video.download = DOWNLOAD_STATE.NONE;
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
  // Migrazione: la coda dei link non ancora risolti (M85) non esiste nei
  // cataloghi precedenti. Un array vuoto è lo stato normale, non un caso
  // speciale da gestire altrove.
  if (!Array.isArray(cat.queue)) {
    cat.queue = [];
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

// ⚠️ Restituisce l'oggetto **vivo** in memoria, non una copia: va letto dentro
// un turno, non tenuto da parte attraverso degli `await`. Chi deve *decidere*
// sulla base di uno stato e poi scriverlo non può usare questa (vedi
// claimVideosForDownload): fra la lettura e la scrittura un altro job può aver
// cambiato tutto. Una copia profonda non risolverebbe niente — renderebbe la
// decisione stabilmente vecchia invece che casualmente vecchia — e costerebbe a
// ogni richiesta dell'API, quindi il rimedio giusto è mutare dentro il mutex.
export async function readCatalog() {
  return ensureLoaded();
}

// Prende in carico dei video per il download, **in una sola mutazione atomica**.
//
// Esiste perché "controlla se è già in download, poi marcalo" fatto in due
// tempi è una decisione presa su dati che nel frattempo possono cambiare:
// finché la coda era single-worker non poteva succedere, con N download in
// parallelo due job prenderebbero in carico lo stesso id e lo scaricherebbero
// due volte. Qui il controllo e la marcatura stanno dentro `updateCatalog`,
// cioè dentro il mutex, quindi nessuno può infilarsi in mezzo.
//
// Ritorna **una fotografia** (id/titolo/url) dei soli video effettivamente
// presi in carico, catturata dentro il mutex: chi la usa dopo non rilegge lo
// stato vivo e quindi non ha niente di vecchio in mano.
//
// `allowRedownload` distingue i due chiamanti senza cambiare il comportamento
// di nessuno dei due: il download singolo può ri-scaricare un video già
// scaricato (è così che si riprova a una qualità più alta), il download in
// blocco no — salta sia i `downloaded` sia i `downloading`, come ha sempre
// fatto. In entrambi i casi un `downloading` non viene mai preso due volte.
export async function claimVideosForDownload(ids, { allowRedownload = false } = {}) {
  const claimed = [];
  await updateCatalog((cat) => {
    for (const id of ids) {
      const video = cat.videos[id];
      if (!video) continue;
      if (video.download === DOWNLOAD_STATE.DOWNLOADING) continue;
      if (!allowRedownload && video.download === DOWNLOAD_STATE.DOWNLOADED) continue;
      video.download = DOWNLOAD_STATE.DOWNLOADING;
      video.error = null;
      video.updatedAt = new Date().toISOString();
      claimed.push({ id, title: video.title ?? null, webpageUrl: video.webpageUrl ?? null });
    }
  });
  return claimed;
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
