// M86 — traduzione di `cli/src/settings.rs`.
//
// Impostazioni: stato e percorsi, qualità predefinita, parallelismo.
// Tutto finisce in `data/config.json`.

import { existsSync, readFileSync } from 'node:fs';

import * as core from '@catalog/core';
import * as ui from './ui.js';
import { FILTER } from './ondo.js';

const BACK = Symbol('back');

export async function open(app) {
  while (true) {
    await app.pump();
    ui.screen('Impostazioni', app);

    const cfg = app.lib.config();
    const voci = [
      { name: 'Stato e percorsi', value: 'paths' },
      { name: `Qualità predefinita: ${core.qualityLabel(cfg.quality)}`, value: 'quality' },
      { name: `Download in parallelo: ${cfg.parallel}`, value: 'parallel' },
      { name: '← indietro', value: BACK }
    ];

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: 'paths', pageSize: voci.length });
    if (scelta === null || scelta === BACK) return;

    try {
      if (scelta === 'paths') await paths(app);
      else if (scelta === 'quality') await quality(app);
      else if (scelta === 'parallel') await parallel(app);
    } catch (e) {
      if (ui.isInterruzione(e)) throw e; // Ctrl-C attraversa (M89)
      ui.err(app, e);
    }
  }
}

async function quality(app) {
  ui.screen('Qualità predefinita', app);
  console.log(
    'Vale per i download futuri. «Chiedi ogni volta» fa comparire la scelta della\n' +
      'risoluzione appena lanci un download, link per link.\n\n' +
      'La qualità più alta viene comunque esclusa se è in AV1: alla stessa risoluzione\n' +
      'dava 403 sistematici.\n'
  );
  const attuale = app.lib.config().quality;
  const indiceAttuale = Math.max(0, ui.LIVELLI.findIndex((q) => core.sameQuality(q, attuale)));
  const voci = ui.LIVELLI.map((q, i) => ({ name: core.qualityLabel(q), value: i }));

  const scelta = await ui.selectOpt({ choices: voci, defaultValue: indiceAttuale, pageSize: voci.length });
  if (scelta === null) return;
  await app.lib.setQuality(ui.LIVELLI[scelta]);
  ui.ok(app, `qualità predefinita: ${voci[scelta].name}`);
}

/**
 * Un menu, non un campo di testo: da un campo con validazione non si esce senza
 * aver dato un valore valido, e uscire deve essere sempre possibile.
 */
async function parallel(app) {
  const SCELTE = [1, 2, 3, 4, 5, 6, 8, 12];

  ui.screen('Download in parallelo', app);
  console.log('Quanti download insieme. Vale subito.\n');

  const attuale = app.lib.config().parallel;
  const voci = [
    ...SCELTE.map((n) => ({ name: String(n), value: n })),
    { name: '← indietro', value: BACK }
  ];
  const predefinito = SCELTE.includes(attuale) ? attuale : SCELTE[2];

  const scelta = await ui.selectOpt({ choices: voci, defaultValue: predefinito, pageSize: voci.length });
  if (scelta === null || scelta === BACK) return;

  // A caldo: alzarlo fa partire subito altri download, abbassarlo non interrompe
  // niente — quelli in corso finiscono, semplicemente non vengono rimpiazzati.
  app.dl.setParallel(scelta);
  ui.ok(app, `${scelta} download in parallelo`);
}

async function paths(app) {
  while (true) {
    await app.pump();
    ui.screen('Stato e percorsi', app);
    await stato(app);

    console.log(`${ui.style.dim("Invio senza cambiare niente lascia il valore com'è.")}\n`);
    const cfg = app.lib.config();
    // M95 — l'unico percorso ancora impostabile è la cartella dei video: VLC,
    // yt-dlp e ffmpeg si cercano da soli, e il file cookie ha una posizione
    // fissa (si importa, non si indica). Le due voci restanti sono di sola
    // lettura, mostrate da stato(): qui si agisce solo su ciò che è una scelta.
    const voci = [
      { name: `Cartella video: ${cfg.videos}`, value: 'videos' },
      { name: 'Importa un file cookie…', value: 'cookies' },
      { name: '← indietro', value: BACK }
    ];

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: 'videos', pageSize: voci.length });
    if (scelta === null || scelta === BACK) return;

    try {
      if (scelta === 'videos') {
        const attuale = core.loadLibraryConfig().videosRoot ?? cfg.videos;
        const nuovo = await chiedi('Cartella video (relativa alla radice, o assoluta)', attuale);
        if (nuovo === null) {
          ui.ok(app, 'invariata');
        } else if (nuovo === '') {
          ui.err(app, 'la cartella dei video non può essere vuota');
        } else {
          core.setVideosRoot(nuovo);
          ui.ok(app, 'cambiata. I file già scaricati NON vengono spostati: spostali a mano se serve.');
        }
      } else if (scelta === 'cookies') {
        // Si COPIA il file nella sua posizione fissa invece di memorizzarne il
        // percorso: così il catalogo non dipende da un file che sta altrove sul
        // disco e che l'utente può spostare senza saperlo.
        const sorgente = await chiedi('File cookie da importare (formato Netscape)', '');
        if (sorgente === null || sorgente === '') {
          ui.ok(app, 'invariato');
        } else if (!existsSync(sorgente)) {
          ui.err(app, `non c'è niente in ${sorgente}`);
        } else {
          core.saveCookiesFile(readFileSync(sorgente, 'utf-8'));
          ui.ok(app, 'cookie importati. Si usano solo come ripiego, dopo un primo tentativo senza.');
        }
      }
    } catch (e) {
      if (ui.isInterruzione(e)) throw e; // Ctrl-C attraversa (M89)
      ui.err(app, e);
    }
  }
}

/**
 * Chiede un percorso, partendo da quello attuale. `null` = non è stato cambiato
 * niente: serve perché un campo di testo non sa annullare, e senza questo entrare
 * per sbaglio in una voce vorrebbe dire non poterne uscire senza scrivere qualcosa.
 */
async function chiedi(prompt, attuale) {
  // M88: Esc (come Ctrl-C) esce dal campo senza cambiare niente.
  const risposta = await ui.inputOpt({ message: prompt, initial: attuale });
  if (risposta === null) return null;
  const nuovo = String(risposta).trim();
  return nuovo === String(attuale ?? '').trim() ? null : nuovo;
}

/** Il pannello informativo: dove sono le cose e se esistono davvero. */
async function stato(app) {
  const cfg = app.lib.config();
  const riga = (k, p) => {
    const segno = p && existsSync(p) ? ui.style.green('●') : ui.style.red('○');
    console.log(`  ${segno} ${ui.style.dim(String(k).padEnd(12))} ${p}`);
  };

  console.log(ui.style.bold('percorsi'));
  riga('radice', cfg.root);
  riga('video', cfg.videos);
  riga('copertine', cfg.covers);
  riga('metadati', cfg.metadata);
  console.log(ui.style.bold('binari'));
  riga('yt-dlp', cfg.ytdlp);
  riga('ffmpeg', cfg.ffmpeg);
  riga('ffprobe', cfg.ffprobe);
  // Il runtime JavaScript è un requisito di yt-dlp, non nostro: si mostra quale
  // ha trovato, perché va bene uno qualunque dei quattro.
  const js = core.findJsRuntime();
  if (js) {
    riga(`js (${js.name})`, js.path);
  } else {
    console.log(
      `  ${ui.style.red('○')} ${ui.style.dim('js'.padEnd(12))} ` +
        ui.style.red(
          `nessun runtime fra ${core.JS_RUNTIME_NAMES.join(', ')} — yt-dlp non potrà scaricare da YouTube`
        )
    );
  }
  // M95 — VLC non è più configurabile: o lo si trova o no, quindi la riga si
  // mostra sempre (prima appariva solo se impostata, e la sua assenza era
  // indistinguibile da "non c'è la voce").
  if (cfg.vlc) riga('vlc', cfg.vlc);
  else {
    console.log(
      `  ${ui.style.red('○')} ${ui.style.dim('vlc'.padEnd(12))} ` +
        ui.style.red('non installato — la riproduzione non è disponibile')
    );
  }

  console.log(ui.style.bold('libreria'));
  console.log(
    `    ${app.lib.len()} video · ${app.lib.count(FILTER.DOWNLOADED)} scaricati · ` +
      `${app.lib.count(FILTER.PENDING)} da scaricare · ${app.lib.count(FILTER.FAILED)} falliti · ` +
      `${app.lib.queue().length} link in coda`
  );
  const mancanti = (await app.lib.missingFiles()).length;
  if (mancanti > 0) {
    console.log(`    ${ui.style.red(`${mancanti} file dati per scaricati non sono al loro posto`)}`);
  }
  console.log();
}
