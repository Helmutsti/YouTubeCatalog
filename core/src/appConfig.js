// M96 — impostazioni dell'APPLICAZIONE, distinte da quelle della LIBRERIA.
//
// La divisione è questa, e la regola per decidere dove va un campo è una sola:
//
//   libreria     (<libreria>/data/conf.json)  →  dove sono i video
//   applicazione (questo file)                →  tutto il resto
//
// «Dove sono i video» è l'unica cosa che descrive *quell'archivio* e che
// nessuno può dedurre. Qualità predefinita, parallelismo, formato di download,
// porta, percorso di VLC sono invece scelte di chi usa il programma su *questa*
// macchina: messe nella libreria la rendevano intrasportabile, perché
// viaggiavano con essa anche quando non avevano più senso (un percorso di VLC
// copiato su un altro PC, la porta di un container dentro un archivio letto
// dalla CLI).
//
// UN file per applicazione: `config/ondo.json` per la CLI, `config/web.json`
// per la web app. Sono due programmi con esigenze diverse (la porta esiste solo
// per una) e possono legittimamente avere preferenze diverse sulla stessa
// macchina.
//
// M98 — qui NON c'è la libreria: quella è «la cartella in cui ti trovi», e la
// decide library.js. Un percorso salvato qui sarebbe una libreria predefinita,
// cioè il ripiego «se non è qui, vai a prenderla là» che si è scelto di non
// avere.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { INSTALL_ROOT } from './lib/installRoot.js';
import { deepMerge } from './lib/deepMerge.js';
// isPackagedInstall vive in library.js insieme a toolsRoot, che segue la stessa
// regola: library.js non importa questo modulo, quindi nessun ciclo.
import { isPackagedInstall } from './library.js';

const DEFAULT_APP_CONFIG = {
  // M98 — niente `libraryPath`: la libreria è quella in cui ti trovi (vedi
  // library.js). Una libreria predefinita salvata qui sarebbe esattamente il
  // ripiego "se non è qui vai a prenderla là" che si è deciso di non avere.
  // null = VLC si cerca da sé (PATH + posizioni standard d'installazione).
  // Un percorso lo impone, per chi lo tiene in un posto non standard.
  vlcPath: null,
  // Qualità predefinita: "best" | "ask" | { height: N }.
  quality: 'best',
  jobs: {
    maxAttempts: 3,
    // Quanti job insieme. 1 = un download per volta, il comportamento storico.
    parallel: 1
  },
  ytdlp: {
    format: 'bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b',
    mergeOutputFormat: 'mp4',
    maxHeight: null
  }
};

// Campi che hanno senso solo per una certa applicazione. La porta è dell'API:
// nel file della CLI sarebbe una riga che non fa niente, e una riga che non fa
// niente in un file di impostazioni è una domanda a cui qualcuno prima o poi
// risponderà sbagliando.
const APP_EXTRA_DEFAULTS = {
  web: { port: 3001 }
};

function defaultsForApp() {
  return deepMerge(DEFAULT_APP_CONFIG, APP_EXTRA_DEFAULTS[appId] ?? {});
}

// Quale applicazione siamo: decide il NOME del file. Stesso schema di
// setLockRole() — un'informazione che solo il punto d'ingresso conosce e che
// dichiara all'avvio. Il default neutro serve agli script che usano il core
// direttamente: non ruba il file della CLI né quello della web.
let appId = 'ondo';
let cached = null;

/** Dichiara l'applicazione corrente: 'cli', 'web', o un nome proprio. */
export function setAppId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('appId non valido.');
  const next = id.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (next === appId) return;
  appId = next;
  cached = null; // il file cambia: la cache di prima non vale più
}

export function getAppId() {
  return appId;
}

/**
 * Cartella dei file di configurazione delle applicazioni: `config/` DENTRO
 * l'installazione (M97).
 *
 * Sta con il codice e con i binari perché è roba dell'applicazione: duplicare
 * un'installazione ne duplica anche le impostazioni, che è il comportamento
 * voluto — due installazioni sulla stessa macchina sono due programmi
 * indipendenti, non due viste sulle stesse preferenze.
 *
 * In una sottocartella e non nella radice perché nel repo la CLI e la web app
 * girano dalla STESSA cartella d'installazione: `config/ondo.json` e
 * `config/web.json` restano due file distinti, come devono.
 *
 * `ONDO_CONFIG_DIR` la sposta, e serve in due casi: il container (dove il
 * codice sta in un'immagine di sola lettura e il file deve stare su un volume)
 * e un'installazione la cui cartella non è scrivibile — vedi il ripiego sotto.
 */
export function appConfigDir() {
  const override = process.env.ONDO_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());

  // M98 — se siamo un pacchetto installato con `npm install -g`, la cartella
  // dell'installazione sta dentro node_modules: npm la riscrive a ogni
  // aggiornamento, quindi le impostazioni ci vivrebbero fino al primo `npm
  // update` e poi spariscono. Il controllo di scrivibilità qui sotto NON basta a
  // coprire questo caso — node_modules è perfettamente scrivibile, ed è proprio
  // il motivo per cui il problema passava inosservato.
  if (isPackagedInstall()) return userConfigDir();

  const inInstall = path.join(INSTALL_ROOT, 'config');
  if (isUsable(inInstall)) return inInstall;

  // Ripiego diverso: la cartella dell'installazione non è scrivibile (installazione
  // di sistema, permessi). Meglio le impostazioni nella cartella utente che
  // nessuna impostazione.
  const fallback = userConfigDir();
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `\n⚠  ${inInstall} non è scrivibile: le impostazioni vanno in ${fallback}.\n` +
      '   Per deciderne tu la posizione, imposta ONDO_CONFIG_DIR.\n'
    );
  }
  return fallback;
}

let warnedFallback = false;

// Scrivibile? Si prova a crearla: `access` su una cartella che non esiste
// ancora non dice nulla di utile, e crearla è comunque ciò che serve.
function isUsable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function userConfigDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'ondo');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ondo');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ondo');
}

export function appConfigPath() {
  return path.join(appConfigDir(), `${appId}.json`);
}

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

export function loadAppConfig() {
  if (cached) return cached;

  const file = appConfigPath();
  const defaults = defaultsForApp();
  let userConfig;
  if (existsSync(file)) {
    userConfig = JSON.parse(readFileSync(file, 'utf-8'));
  } else {
    userConfig = {};
    writeAtomic(file, defaults);
  }

  cached = deepMerge(defaults, userConfig);
  return cached;
}

/**
 * Applica `patch` (deep-merge) al file dell'applicazione e invalida la cache.
 * Scrittura atomica (tmp+rename) come per il catalogo: un'interruzione a metà
 * non lascia un JSON troncato, che al riavvio sarebbe illeggibile.
 *
 * Nessun lock: il lock del progetto protegge `data/` della libreria, dove più
 * processi (server e CLI) scrivono lo stesso catalogo. Questo file è invece di
 * una singola applicazione.
 */
export function updateAppConfig(patch) {
  const file = appConfigPath();
  let userConfig = {};
  if (existsSync(file)) {
    userConfig = JSON.parse(readFileSync(file, 'utf-8'));
  }
  const updated = deepMerge(userConfig, patch);
  writeAtomic(file, updated);
  cached = null;
  return loadAppConfig();
}
