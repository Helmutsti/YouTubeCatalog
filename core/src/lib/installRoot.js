// M96 — la radice dell'INSTALLAZIONE, cioè dove sta il codice.
//
// Estratta da config.js perché ora serve a due moduli che non possono
// dipendere l'uno dall'altro: config.js (percorsi della libreria) e
// appConfig.js (impostazioni dell'applicazione, che config.js importa).
//
// Da qui in avanti "installazione" e "libreria" sono due cose distinte:
//
//   installazione → il codice, tools/ con i binari, core/cookies.txt
//   libreria      → data/ (catalogo, config, media) e i video
//
// Coincidono nel caso normale (una libreria dentro il progetto, il default), ma
// non necessariamente: la libreria è quella in cui ti trovi, e può stare
// altrove; in quel caso i binari restano dove sta il codice — sono
// una proprietà dell'installazione, non dell'archivio.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Radice dell'installazione: due livelli sopra core/src/lib → core/ → radice. */
export const INSTALL_ROOT = path.resolve(__dirname, '../../..');

/** La cartella `core/` dell'installazione. */
export const CORE_DIR = path.resolve(__dirname, '../..');
