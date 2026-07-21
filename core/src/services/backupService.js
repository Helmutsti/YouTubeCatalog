// Backup e ripristino dei file dati del catalogo in un archivio .zip (M36).
// I file media (video/copertine) NON sono inclusi: il backup resta piccolo e
// portabile. Lo spostamento della cartella media fuori dal progetto è un punto
// separato del backlog.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { createZip, readZip } from '../lib/zip.js';

// Whitelist esplicita dei file inclusi nel backup. NON include config.json
// (contiene percorsi specifici della macchina, es. mediaRoot/vlcPath) né
// cookies.txt (dati di sessione sensibili). In ripristino non viene MAI scritto
// un nome di file diverso da questi, anche se presente nello zip (sicurezza:
// nessun path traversal / sovrascrittura arbitraria dallo zip).
const BACKUP_FILES = ['catalog.json', 'metadata.json', 'jobs.json'];

function dataFilePath(name) {
  return path.join(getPaths().dataDir, name);
}

// Timestamp filesystem-safe (niente ':' per Windows): 2026-07-21T14-30-05.
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Crea un backup .zip in memoria dei file dati esistenti (whitelist).
 * @returns {Buffer} i byte dell'archivio zip
 */
export function createBackup() {
  const entries = [];
  for (const name of BACKUP_FILES) {
    const p = dataFilePath(name);
    if (existsSync(p)) entries.push({ name, data: readFileSync(p) });
  }
  if (entries.length === 0) throw new Error('Nessun file da salvare nel backup.');
  return createZip(entries);
}

/**
 * Ripristina i file dati da un backup .zip. Prima copia i file attuali in una
 * cartella di sicurezza `data/pre-restore-<timestamp>/`, poi sostituisce
 * atomicamente solo i file in whitelist presenti nello zip. NON ricarica lo
 * stato in memoria: il processo (server/CLI) va riavviato per applicare.
 * @param {Buffer} zipBuffer
 * @returns {{restored: string[], backedUp: string[], safetyDir: string, requiresRestart: boolean}}
 */
export function restoreBackup(zipBuffer) {
  const entries = readZip(zipBuffer);
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  // Validazione: catalog.json obbligatorio; ogni file riconosciuto dev'essere
  // JSON valido (evita di sostituire i dati con spazzatura).
  if (!byName.has('catalog.json')) {
    throw new Error('Backup non valido: catalog.json mancante.');
  }
  for (const name of BACKUP_FILES) {
    if (!byName.has(name)) continue;
    try {
      JSON.parse(byName.get(name).toString('utf-8'));
    } catch {
      throw new Error(`Backup non valido: ${name} non è JSON valido.`);
    }
  }

  const { dataDir } = getPaths();

  // 1. Copia di sicurezza dei file attuali.
  const safetyDir = path.join(dataDir, `pre-restore-${timestamp()}`);
  mkdirSync(safetyDir, { recursive: true });
  const backedUp = [];
  for (const name of BACKUP_FILES) {
    const current = dataFilePath(name);
    if (existsSync(current)) {
      copyFileSync(current, path.join(safetyDir, name));
      backedUp.push(name);
    }
  }

  // 2. Sostituzione atomica (tmp + rename) dei soli file in whitelist.
  const restored = [];
  for (const name of BACKUP_FILES) {
    if (!byName.has(name)) continue;
    const dest = dataFilePath(name);
    const tmp = `${dest}.restore-tmp`;
    writeFileSync(tmp, byName.get(name));
    renameSync(tmp, dest);
    restored.push(name);
  }

  return { restored, backedUp, safetyDir, requiresRestart: true };
}
