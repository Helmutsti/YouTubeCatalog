// Backup e ripristino dello stato del catalogo in un archivio .zip (M36, esteso
// in M61). Contiene TUTTO lo stato ricostruibile TRANNE i file video grezzi (i
// pesanti): i file dati JSON, le impostazioni (config.json) e le immagini
// (copertine + avatar). NON include i video (ri-scaricabili) né
// core/cookies.txt (dati di sessione sensibili, lo zip non è cifrato).

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { acquireDataLock } from '../lock.js';
import { createZip, readZip } from '../lib/zip.js';

// Whitelist esplicita dei file dati JSON inclusi nel backup. Da M61 include
// anche config.json (impostazioni: l'utente accetta che un ripristino su
// un'altra macchina sovrascriva anche i percorsi macchina-specifici). In
// ripristino non viene MAI scritto un nome di file diverso da questi, anche se
// presente nello zip (sicurezza: nessun path traversal / sovrascrittura
// arbitraria dallo zip). cookies.txt resta escluso (dati di sessione sensibili).
const BACKUP_JSON_FILES = ['catalog.json', 'metadata.json', 'jobs.json', 'config.json'];

// Cartelle immagini incluse nel backup: prefisso nello zip → cartella su disco.
// Sono copertine (thumbnails) e avatar dei canali: immagini, non video, quindi
// dentro "tutto tranne i video grezzi". I nomi nello zip sono `<prefisso>/<file>`.
const IMAGE_DIRS = ['thumbnails', 'avatars'];

function dataFilePath(name) {
  return path.join(getPaths().dataDir, name);
}

// Mappa prefisso zip → cartella su disco, risolta al momento (getPaths crea le
// cartelle se mancano).
function imageDirPath(prefix) {
  const paths = getPaths();
  return prefix === 'thumbnails' ? paths.thumbnailsDir : paths.avatarsDir;
}

// Timestamp filesystem-safe (niente ':' per Windows): 2026-07-21T14-30-05.
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Elenca i soli file (non le sottocartelle) di una cartella, vuoto se assente.
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Crea un backup .zip in memoria: file dati JSON (whitelist) + impostazioni +
 * immagini (copertine/avatar). Esclude i video grezzi e i cookie.
 * @returns {Buffer} i byte dell'archivio zip
 */
export function createBackup() {
  const entries = [];

  for (const name of BACKUP_JSON_FILES) {
    const p = dataFilePath(name);
    if (existsSync(p)) entries.push({ name, data: readFileSync(p) });
  }

  for (const prefix of IMAGE_DIRS) {
    const dir = imageDirPath(prefix);
    for (const file of listFiles(dir)) {
      entries.push({ name: `${prefix}/${file}`, data: readFileSync(path.join(dir, file)) });
    }
  }

  if (entries.length === 0) throw new Error('Nessun file da salvare nel backup.');
  return createZip(entries);
}

// Riconosce un'entry immagine valida (`thumbnails/<basename>` o
// `avatars/<basename>`, un solo livello, nessun path traversal). Ritorna
// { prefix, base } se valida, altrimenti null.
function parseImageEntryName(name) {
  const m = /^(thumbnails|avatars)\/([^/\\]+)$/.exec(name);
  if (!m) return null;
  const base = m[2];
  if (base === '.' || base === '..' || base.includes('/') || base.includes('\\')) return null;
  return { prefix: m[1], base };
}

/**
 * Ripristina i file da un backup .zip. Prima copia i file dati JSON attuali in
 * una cartella di sicurezza `data/pre-restore-<timestamp>/`, poi sostituisce
 * atomicamente i soli file JSON in whitelist presenti nello zip e riscrive le
 * immagini (copertine/avatar) nelle rispettive cartelle. Le immagini vengono
 * sovrascritte/aggiunte, mai cancellate: per questo non entrano nella copia di
 * sicurezza. NON ricarica lo stato in memoria: il processo (server/CLI) va
 * riavviato per applicare (config.json compreso).
 * @param {Buffer} zipBuffer
 * @returns {{restored: string[], restoredImages: number, backedUp: string[], safetyDir: string, requiresRestart: boolean}}
 */
export function restoreBackup(zipBuffer) {
  const entries = readZip(zipBuffer);
  const jsonByName = new Map();
  const imageEntries = [];
  for (const e of entries) {
    if (BACKUP_JSON_FILES.includes(e.name)) {
      jsonByName.set(e.name, e.data);
    } else {
      const img = parseImageEntryName(e.name);
      if (img) imageEntries.push({ ...img, data: e.data });
      // Qualunque altro nome (fuori whitelist / prefisso sconosciuto / path
      // traversal) viene ignorato: nessuna scrittura arbitraria dallo zip.
    }
  }

  // Validazione: catalog.json obbligatorio; ogni file JSON riconosciuto
  // dev'essere JSON valido (evita di sostituire i dati con spazzatura).
  if (!jsonByName.has('catalog.json')) {
    throw new Error('Backup non valido: catalog.json mancante.');
  }
  for (const name of BACKUP_JSON_FILES) {
    if (!jsonByName.has(name)) continue;
    try {
      JSON.parse(jsonByName.get(name).toString('utf-8'));
    } catch {
      throw new Error(`Backup non valido: ${name} non è JSON valido.`);
    }
  }

  const { dataDir } = getPaths();

  // M92 — un lock solo, tenuto per tutto il ripristino: qui non c'è un
  // mutator sincero da riproteggere in mezzo (a differenza di
  // catalogStore/metadataStore), è direttamente una sostituzione fisica di
  // file su disco — quindi tutta l'operazione va trattata come una singola
  // scrittura. `restoreBackup` avvisa già il chiamante che il processo va
  // riavviato per applicare, quindi non serve rileggere nulla dopo.
  const release = acquireDataLock();
  let safetyDir, backedUp, restored, restoredImages;
  try {
    // 1. Copia di sicurezza dei soli file dati JSON attuali.
    safetyDir = path.join(dataDir, `pre-restore-${timestamp()}`);
    mkdirSync(safetyDir, { recursive: true });
    backedUp = [];
    for (const name of BACKUP_JSON_FILES) {
      const current = dataFilePath(name);
      if (existsSync(current)) {
        copyFileSync(current, path.join(safetyDir, name));
        backedUp.push(name);
      }
    }

    // 2. Sostituzione atomica (tmp + rename) dei soli file JSON in whitelist.
    restored = [];
    for (const name of BACKUP_JSON_FILES) {
      if (!jsonByName.has(name)) continue;
      const dest = dataFilePath(name);
      const tmp = `${dest}.restore-tmp`;
      writeFileSync(tmp, jsonByName.get(name));
      renameSync(tmp, dest);
      restored.push(name);
    }

    // 3. Immagini (copertine/avatar): scrittura atomica nel basename validato.
    restoredImages = 0;
    for (const img of imageEntries) {
      const dir = imageDirPath(img.prefix); // getPaths (dentro) crea la cartella se manca
      const dest = path.join(dir, img.base);
      const tmp = `${dest}.restore-tmp`;
      writeFileSync(tmp, img.data);
      renameSync(tmp, dest);
      restoredImages++;
    }
  } finally {
    release();
  }

  return { restored, restoredImages, backedUp, safetyDir, requiresRestart: true };
}
