import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';
import * as core from '@catalog/core';

import { printTable, style } from '../format.js';

const FILTER_VALUES = Object.values(core.FILTER);

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^s(i|ì)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printVideoRows(rows, opts) {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printTable(rows, [
    { header: 'ID', value: (v) => v.id },
    { header: 'Titolo', value: (v) => v.title },
    { header: 'Autore', value: (v) => v.author },
    { header: 'Stato', value: (v) => core.stateLabel(v.state) },
    { header: 'Preferito', value: (v) => (v.favorite ? '★' : '') }
  ]);
}

export function videoCommand() {
  const cmd = new Command('video').description('gestisci i video del catalogo');

  cmd
    .command('list')
    .description('elenca i video in libreria')
    .option('-f, --filter <filtro>', `stato (${FILTER_VALUES.join('|')})`, core.FILTER.ALL)
    .option('-a, --author <nome>', 'limita a un autore/canale')
    .option('--json', 'stampa come JSON')
    .action(async (opts) => {
      if (!FILTER_VALUES.includes(opts.filter)) {
        throw new Error(`filtro sconosciuto: "${opts.filter}" (valori: ${FILTER_VALUES.join(', ')})`);
      }
      const videos = await core.libraryVideos();
      let rows = core.listByFilter(videos, opts.filter);
      if (opts.author) rows = rows.filter((v) => v.author === opts.author);
      printVideoRows(rows, opts);
    });

  cmd
    .command('search <query>')
    .description('cerca video per titolo/autore/tag/descrizione')
    .option('--json', 'stampa come JSON')
    .action(async (query, opts) => {
      const videos = await core.libraryVideos();
      printVideoRows(core.searchLibrary(videos, query), opts);
    });

  cmd
    .command('show <id>')
    .description('mostra il dettaglio di un video')
    .option('--json', 'stampa come JSON')
    .action(async (id, opts) => {
      const video = await core.getVideo(id);
      if (opts.json) {
        console.log(JSON.stringify(video, null, 2));
        return;
      }
      console.log(`${style.bold(video.title || video.id)}  (${video.id})`);
      console.log(`Autore:     ${video.channel?.name ?? 'Sconosciuto'}`);
      console.log(`URL:        ${video.webpageUrl || '-'}`);
      console.log(`Download:   ${video.download}`);
      console.log(`Presenza:   ${video.presence}`);
      console.log(`Nascosto:   ${video.hidden ? 'sì' : 'no'}`);
      console.log(`Preferito:  ${video.favorite ? 'sì' : 'no'}`);
    });

  cmd
    .command('play <id>')
    .description('riproduce un video scaricato con VLC')
    .option('-m, --mode <modo>', 'video|audio', core.PLAYBACK_MODE.VIDEO)
    .action(async (id, opts) => {
      const result = await core.playVideo(id, { mode: opts.mode });
      console.log(`${style.green('▶')} ${result.file}`);
    });

  cmd
    .command('favorite <id> <stato>')
    .description('imposta o toglie il preferito (stato: on|off)')
    .action(async (id, stato) => {
      if (stato !== 'on' && stato !== 'off') throw new Error('stato non valido: usa "on" oppure "off"');
      await core.setVideoFavorite(id, stato === 'on');
      console.log(`${style.green('✓')} preferito: ${stato}`);
    });

  cmd
    .command('hide <id> <stato>')
    .description('nasconde o mostra un video in libreria (stato: on|off)')
    .action(async (id, stato) => {
      if (stato !== 'on' && stato !== 'off') throw new Error('stato non valido: usa "on" oppure "off"');
      await core.setVideoHidden(id, stato === 'on');
      console.log(`${style.green('✓')} nascosto: ${stato}`);
    });

  cmd
    .command('retry <id>')
    .description('rimette in coda un video fallito o con file mancante')
    .action(async (id) => {
      const url = await core.retryVideo(id);
      if (url === null) throw new Error(`video non trovato: ${id}`);
      console.log(`${style.green('✓')} rimesso in coda`);
    });

  cmd
    .command('remove <id>')
    .description('toglie un video dalla libreria (la scheda; opzionalmente anche il file)')
    .option('--files', 'cancella anche il file scaricato', false)
    .action(async (id, opts) => {
      const removed = await core.removeVideoFromLibrary(id, { deleteFiles: opts.files });
      if (!removed) throw new Error(`video non trovato: ${id}`);
      console.log(`${style.green('✓')} rimosso${opts.files ? ' (file compreso)' : ''}`);
    });

  cmd
    .command('delete <id>')
    .description('cancella DEFINITIVAMENTE scheda, file e metadati (il video deve essere già nascosto/archiviato)')
    .option('-y, --yes', 'salta la conferma', false)
    .action(async (id, opts) => {
      if (!opts.yes && !(await confirm(`Cancellare DEFINITIVAMENTE "${id}"? Scrivi "sì" per confermare: `))) {
        console.log('Annullato.');
        return;
      }
      await core.deleteVideoCompletely(id);
      console.log(`${style.green('✓')} cancellato definitivamente`);
    });

  cmd
    .command('refresh-metadata <id>')
    .description('ri-scarica metadati e copertina di un video')
    .action(async (id) => {
      const video = await core.refreshVideoMetadata(id);
      console.log(`${style.green('✓')} metadati aggiornati: ${video?.title ?? id}`);
    });

  cmd
    .command('missing')
    .description('elenca i video scaricati il cui file non è più sul disco')
    .option('--json', 'stampa come JSON')
    .action(async (opts) => {
      const ids = await core.missingFiles();
      if (opts.json) {
        console.log(JSON.stringify(ids, null, 2));
        return;
      }
      if (ids.length === 0) {
        console.log(style.dim('(nessun file mancante)'));
        return;
      }
      for (const id of ids) console.log(id);
    });

  cmd
    .command('download <url>')
    .description('scarica un video al volo, senza passare da una fonte')
    .option('-q, --quality <altezza>', 'tetto di risoluzione in pixel (es. 1080); omesso = migliore disponibile')
    .action(async (url, opts) => {
      let maxHeight = null;
      if (opts.quality) {
        maxHeight = Number.parseInt(opts.quality, 10);
        if (!Number.isFinite(maxHeight)) throw new Error(`qualità non valida: "${opts.quality}"`);
      }

      await core.enqueueLink(url, { maxHeight });
      const { jobId } = core.triggerJob('quickDownload', { url, maxHeight });
      console.log(`In coda: ${url}`);

      await new Promise((resolve, reject) => {
        const offProgress = core.onJobProgress(jobId, (pct) => {
          process.stdout.write(`\r${style.cyan(`${pct}%`)}   `);
        });
        const offStatus = core.onJobStatus(jobId, (status) => {
          if (status !== 'success' && status !== 'failed') return;
          offStatus();
          offProgress();
          if (status === 'failed') {
            const job = core.getJob(jobId);
            reject(new Error(job?.error?.message ?? 'download fallito'));
          } else {
            resolve();
          }
        });
      });
      process.stdout.write('\n');
      console.log(`${style.green('✓')} fatto`);
    });

  return cmd;
}
