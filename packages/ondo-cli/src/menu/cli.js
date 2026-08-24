// M86 — traduzione di `cli/src/main.rs`.
//
// # ondo — la CLI
//
// Menu navigabili con le frecce sopra la libreria. Nessuna logica di dominio qui:
// ogni voce chiama una funzione del core e mostra il risultato.
//
//   Cerca · Libreria · Download rapido · Impostazioni · ← Esci
//
// Le otto voci che questa CLI aveva prima (fonti, sincronizza, novità, backup,
// riorganizza…) non ci sono per scelta: sono funzioni che il ramo Rust non aveva,
// e restano nel core e nella web app. Vedi M86 in docs/PIANO.md.

import { existsSync } from 'node:fs';

import * as core from '@catalog/core';
import * as ui from './ui.js';
import { Library, Downloader } from './ondo.js';
import * as library from './library.js';
import * as quick from './quick.js';
import * as search from './search.js';
import * as settings from './settings.js';

const BACK = Symbol('back');

/**
 * Lo stato dell'applicazione: la libreria, **un solo** pool di download che vive
 * quanto la CLI, e il messaggio da mostrare al prossimo ridisegno.
 */
class App {
  constructor(lib, dl) {
    this.lib = lib;
    this.dl = dl;
    this.message = null;
  }

  /**
   * Riallinea lo stato a quello che è successo da quando l'abbiamo chiesto
   * l'ultima volta. Non blocca.
   *
   * Va chiamata a ogni giro di menu: mentre un menu aspetta un tasto nessuno
   * guarda i job, quindi un download che finisce in quel momento si vede appena
   * l'utente si muove (o subito, se è aperta la console del Download rapido, che
   * invece pompa in continuazione).
   */
  async pump() {
    await this.lib.refresh();
  }

  /**
   * Accoda un link con la qualità predefinita: prima in libreria (così
   * sopravvive a una chiusura), poi al pool. Ritorna il numero del job, con cui
   * seguirlo negli aggiornamenti.
   */
  async enqueue(url) {
    return this.enqueueWith(url, core.maxHeightOf(this.lib.config().quality));
  }

  /**
   * Come `enqueue`, ma con la risoluzione decisa per **questo** download
   * (`null` = la migliore disponibile).
   */
  async enqueueWith(url, maxHeight) {
    try {
      await this.lib.enqueue(url);
    } catch (e) {
      ui.err(this, e);
      return null;
    }
    return this.dl.pushWith(url, maxHeight);
  }
}

function attivi(app) {
  const corso = app.dl.inFlight();
  const coda = app.dl.queued();
  return corso + coda === 0 ? '' : ` · ${corso} in corso, ${coda} in coda`;
}

/**
 * Uscire con dei download aperti è l'unico momento in cui la CLI deve insistere:
 * il pool muore con il processo.
 */
async function esci(app) {
  if (!app.dl.busy()) return true;

  const voci = [
    { name: 'Aspetta che finiscano', value: 'wait' },
    { name: 'Interrompi e esci (i file parziali restano, yt-dlp riprende)', value: 'stop' },
    { name: '← Torna al menu', value: BACK }
  ];
  ui.screen('Ci sono download in corso', app);
  const scelta = await ui.selectOpt({ choices: voci, defaultValue: 'wait', pageSize: voci.length });

  if (scelta === 'wait') {
    console.log('\nAspetto…  (i download finiscono, poi si esce)');
    const visti = new Set();
    while (app.dl.busy()) {
      await app.pump();
      for (const s of app.dl.statuses()) {
        if (s.done && s.id && !visti.has(s.id)) {
          visti.add(s.id);
          console.log(`  ✓ ${s.id}`);
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await app.pump();
    return true;
  }
  if (scelta === 'stop') {
    app.dl.interruptAll();
    return true;
  }
  return false;
}

export async function run() {
  // Lock sulla libreria (M80/M92): si attiva da solo a ogni scrittura vera e
  // propria (dentro il core), non all'avvio del menu — si può sfogliare la
  // libreria da quanti terminali si vuole, in parallelo a un server o a un'altra
  // `ondo`, finché nessuno dei due scrive nello stesso istante. Qui si imposta
  // solo il ruolo mostrato nel messaggio a chi trova il lock occupato.
  core.setLockRole('CLI');
  // M96/M98 — quale applicazione siamo: decide il file di impostazioni
  // (`config/ondo.json`, distinto dal `web.json` della web app). Idempotente:
  // `bin/ondo.js` l'ha già chiamata, ma `run()` è anche il punto d'ingresso di
  // `npm run cli`, quindi deve valere da sola.
  core.setAppId('ondo');

  // M98 — la libreria è quella in cui ti trovi. Se non c'è, `getPaths()` lancia
  // un NotALibraryError che nomina la cartella guardata: lo si lascia risalire
  // così com'è, perché il messaggio è già quello giusto da mostrare — aprire il
  // menu su una libreria inventata sarebbe molto peggio di non aprirlo.
  const root = core.getPaths().libraryRoot;
  const lib = new Library();
  const dl = new Downloader(lib);
  const app = new App(lib, dl);

  // I binari esterni si controllano una volta all'avvio: scoprire che manca
  // yt-dlp a metà del primo download è un modo inutilmente crudele di dirlo.
  const cfg = lib.config();
  const mancanti = [];
  for (const [nome, percorso] of [
    ['yt-dlp', cfg.ytdlp],
    ['ffmpeg', cfg.ffmpeg],
    ['ffprobe', cfg.ffprobe]
  ]) {
    if (!percorso || !existsSync(percorso)) mancanti.push(`${nome} (${percorso})`);
  }
  // Non un binario nostro e non un runtime in particolare: yt-dlp ha bisogno di
  // eseguire il JavaScript del player di YouTube, e gli va bene uno qualunque fra
  // deno, node, quickjs e bun. Senza nessuno dei quattro i download YouTube
  // muoiono a metà con 403, che è la causa più frequente di fallimenti
  // inspiegabili — meglio dirlo all'avvio.
  if (!core.findJsRuntime()) {
    mancanti.push(`un runtime JavaScript per yt-dlp (${core.JS_RUNTIME_NAMES.join(', ')})`);
  }
  if (mancanti.length > 0) {
    ui.err(app, `non trovo: ${mancanti.join(', ')}. I download falliranno.`);
  }

  while (true) {
    await app.pump();
    // M98 — «libreria: <percorso>» invece del solo percorso: da quando le
    // librerie possono essere quante ne vuoi, un programma che non dice su
    // quale sta lavorando è un programma che ti farà scaricare venti video nel
    // posto sbagliato.
    ui.screen(`ondo · ${app.lib.len()} video · libreria: ${root}${attivi(app)}`, app);

    const voci = [
      { name: 'Cerca', value: 'search' },
      { name: 'Libreria', value: 'library' },
      { name: 'Download rapido', value: 'quick' },
      { name: 'Impostazioni', value: 'settings' },
      { name: '← Esci', value: 'exit' }
    ];
    const scelta = await ui.selectOpt({ choices: voci, defaultValue: 'search', pageSize: voci.length });

    try {
      if (scelta === 'search') await search.open(app);
      else if (scelta === 'library') await library.open(app);
      else if (scelta === 'quick') await quick.open(app);
      else if (scelta === 'settings') await settings.open(app);
      // `null` (Esc/Ctrl-C) passa da qui come «← Esci»: è il comportamento
      // dell'originale, dove annullare il menu principale voleva dire uscire.
      else if (await esci(app)) {
        dl.dispose();
        return;
      }
    } catch (e) {
      // Ctrl-C non è un errore di questa voce di menu: esce dal programma, e per
      // farlo deve attraversare questo `catch` invece di finirci dentro (M89).
      if (ui.isInterruzione(e)) {
        dl.dispose();
        throw e;
      }
      ui.err(app, e);
    }
  }
}

// Guardia sull'auto-invocazione: `node src/menu/cli.js` deve continuare a
// partire da solo, ma `ondo-cli` deve poter importare `run` senza farlo
// scattare due volte (una all'import, una alla chiamata esplicita).
if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      // Ctrl-C: uscita voluta, non un guasto. 130 è il codice convenzionale per
      // "terminato da SIGINT", così anche uno script che invoca la CLI lo distingue
      // da un errore vero. Il lock su data/ lo rilascia l'hook di `exit`.
      if (ui.isInterruzione(e)) {
        console.log(`\n${ui.style.dim('Interrotto.')}`);
        process.exit(130);
      }
      console.error(`${ui.style.red('✗')} ${e?.message ?? e}`);
      process.exit(1);
    });
}
