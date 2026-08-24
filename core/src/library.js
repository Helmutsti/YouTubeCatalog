// M98 — cos'è una libreria, come si riconosce e come si crea.
//
// Prima non serviva: la libreria era una sola e stava sempre accanto al codice,
// quindi «trovarla» e «crearla» potevano essere la stessa cosa — chi risolveva i
// percorsi creava anche le cartelle mancanti, e chi leggeva le impostazioni le
// scriveva se non c'erano.
//
// Da quando la libreria è **quella in cui ti trovi**, quella coincidenza diventa
// una trappola: un `ondo` lanciato per sbaglio in Documenti vi fabbricherebbe una
// libreria vuota, che al giro dopo sarebbe indistinguibile da una vera — e il tuo
// archivio resterebbe invisibile a una cartella di distanza. Quindi qui dentro:
//
//   isLibrary()   guarda e riferisce, non tocca niente
//   initLibrary() l'UNICO punto del programma autorizzato a creare una libreria
//
// È la stessa divisione di `git`: `git status` in una cartella qualunque dice
// «non è un repository», non te lo crea.

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createEmptyCatalog } from './catalog/catalogSchema.js';
import { appConfigDir } from './appConfig.js';

// I nomi del layout, in un posto solo: li usano sia questo modulo sia getPaths().
export const DATA_DIR_NAME = 'data';
export const CATALOG_FILE_NAME = 'libreria.json';
export const LIBRARY_CONFIG_FILE_NAME = 'conf.json';

// Le cartelle di una libreria. I video sono qui dentro solo quando `videosRoot`
// è null (il caso autoportante); se punta altrove, quella cartella la crea/gestisce
// l'utente — noi non inventiamo cartelle su dischi altrui.
const LIBRARY_DIRS = ['videos', 'thumbnails', 'avatars'];

/**
 * Questa cartella è una libreria?
 *
 * Un solo criterio — la presenza del catalogo — e un solo posto guardato:
 * **questa** cartella, non i suoi genitori. Niente risalita e niente ricerca:
 * la regola deve essere spiegabile in una riga («lavora sulla libreria in cui
 * ti trovi») e non avere casi in cui lavora su una libreria inattesa.
 */
export function isLibrary(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return false;
  return existsSync(path.join(dir, DATA_DIR_NAME, CATALOG_FILE_NAME));
}

/**
 * Crea una libreria nuova in `dir`. È l'unico punto che lo fa.
 * @returns {{root: string, created: string[]}}
 */
export function initLibrary(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Percorso non valido.');
  const root = path.resolve(dir);

  if (isLibrary(root)) {
    throw new Error(`${root} è già una libreria.`);
  }

  const created = [];
  const dataDir = path.join(root, DATA_DIR_NAME);
  mkdirSync(dataDir, { recursive: true });
  created.push(DATA_DIR_NAME);
  for (const name of LIBRARY_DIRS) {
    mkdirSync(path.join(root, name), { recursive: true });
    created.push(name);
  }

  // Scrittura atomica come per il catalogo a regime (tmp+rename): un'interruzione
  // a metà non deve lasciare un `libreria.json` troncato, che al giro dopo
  // sarebbe una libreria riconosciuta ma illeggibile — il peggiore dei due stati.
  writeJsonAtomic(path.join(dataDir, CATALOG_FILE_NAME), createEmptyCatalog());
  created.push(`${DATA_DIR_NAME}/${CATALOG_FILE_NAME}`);
  writeJsonAtomic(path.join(dataDir, LIBRARY_CONFIG_FILE_NAME), { videosRoot: null });
  created.push(`${DATA_DIR_NAME}/${LIBRARY_CONFIG_FILE_NAME}`);

  return { root, created };
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

// ── Quale libreria stiamo usando ────────────────────────────────────────────

// `--library <percorso>`: lo imposta il punto d'ingresso, come setAppId e
// setLockRole. Un argomento della riga di comando non può arrivare fin qui da
// solo, e il core non deve conoscere commander.
let override = null;

/** Imposta la libreria per questo processo (da `--library`). */
export function setLibraryOverride(dir) {
  if (dir == null || dir === '') {
    override = null;
    return;
  }
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Percorso non valido.');
  override = path.resolve(dir.trim());
}

/**
 * La libreria su cui lavorare, in ordine:
 *
 *   1. `--library` (setLibraryOverride)
 *   2. `ONDO_LIBRARY` — così il container indica /library, dove la cartella
 *      corrente (/app) non è una libreria
 *   3. **la cartella corrente, e solo quella**
 *
 * Nient'altro: niente risalita ai genitori, nessuna libreria predefinita
 * salvata, nessun ripiego sull'installazione. La regola si spiega in una riga —
 * «lavora sulla libreria in cui ti trovi» — e non ha casi in cui lavora su una
 * libreria che non ti aspetti. Se non c'è, **lancia**: chi chiama non riceve un
 * percorso plausibile su cui poi creare cose per sbaglio.
 *
 * Nei casi 1 e 2 il percorso è preso per buono anche se la libreria non è ancora
 * inizializzata: è un'indicazione esplicita, e serve a `ondo init --library` e al
 * primo avvio del container su un volume vuoto.
 */
export function libraryRoot() {
  if (override) return override;

  const fromEnv = process.env.ONDO_LIBRARY;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());

  const cwd = process.cwd();
  if (isLibrary(cwd)) return cwd;

  throw new NotALibraryError(cwd);
}

/**
 * Errore con un messaggio che **nomina la cartella guardata**. Senza risalita,
 * l'inciampo più probabile è essere un livello troppo in basso (dentro
 * `videos/` invece che nella libreria): «non trovo la libreria» farebbe pensare
 * a un guasto, «<questa cartella> non è una libreria» si capisce in un secondo.
 */
export class NotALibraryError extends Error {
  constructor(dir) {
    super(
      `${dir} non è una libreria.\n` +
      `  Creane una qui con "ondo init", oppure spostati nella cartella della tua libreria.\n` +
      '  (una libreria è una cartella che contiene data/' + CATALOG_FILE_NAME + ')'
    );
    this.name = 'NotALibraryError';
    this.dir = dir;
  }
}

/** La libreria attiva senza lanciare: `null` se non ce n'è una. */
export function currentLibrary() {
  try {
    return libraryRoot();
  } catch (e) {
    if (e instanceof NotALibraryError) return null;
    throw e;
  }
}

/**
 * La cartella dei binari esterni (yt-dlp, ffmpeg, ffprobe): **accanto al file di
 * configurazione dell'applicazione**, in `<cartella config>/tools`.
 *
 * Appartengono all'INSTALLAZIONE, non alla libreria: dieci librerie condividono
 * un solo yt-dlp. E stanno insieme alle impostazioni perché sono la stessa
 * categoria di cosa — «il programma su questa macchina» — e perché tenerli in
 * due posti diversi voleva dire due posti da ricordare quando cerchi un file.
 *
 * M98.1 — prima i binari andavano in una cartella *dati* separata
 * (%LOCALAPPDATA% su Windows, ~/.local/share su Linux) per non trascinare 130 MB
 * di eseguibili nei profili utente mobili dei domini. Beneficio reale ma
 * strettissimo, pagato da tutti con la confusione di due percorsi: la web app in
 * container ha i suoi binari nell'immagine, quindi nessun altro programma
 * condivide questa cartella e non c'è niente da guadagnare tenendola distinta.
 *
 * Segue quindi `appConfigDir()`, override `ONDO_CONFIG_DIR` compreso: nel
 * container diventa /config/tools, che è già su un volume montato.
 */
export function toolsRoot() {
  return path.join(appConfigDir(), 'tools');
}
