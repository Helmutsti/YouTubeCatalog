import { Command } from 'commander';
import * as core from '@catalog/core';

import { printTable, style } from '../format.js';

export function sourceCommand() {
  const cmd = new Command('source').description('gestisci le fonti (playlist)');

  cmd
    .command('list')
    .description('elenca le fonti')
    .option('--json', 'stampa come JSON')
    .action(async (opts) => {
      const sources = await core.listSources();
      if (opts.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }
      printTable(sources, [
        { header: 'ID', value: (s) => s.id },
        { header: 'Nome', value: (s) => s.name },
        { header: 'Video', value: (s) => s.videoCount }
      ]);
    });

  cmd
    .command('add <url>')
    .description('aggiunge una fonte (playlist YouTube: l\'URL deve contenere "list=")')
    .action(async (url) => {
      const result = await core.addSource(url);
      if (result.alreadyExists) {
        console.log(`${style.dim('già presente')}: ${result.name} (${result.sourceId})`);
        return;
      }
      console.log(`${style.green('✓')} ${result.name} — ${result.newCount} nuovi video`);
    });

  cmd
    .command('remove <id>')
    .description('rimuove una fonte (i video restano in libreria)')
    .action(async (id) => {
      await core.removeSource(id);
      console.log(`${style.green('✓')} fonte rimossa: ${id}`);
    });

  cmd
    .command('sync <id>')
    .description('sincronizza una fonte con YouTube')
    .action(async (id) => {
      const result = await core.syncSource(id);
      console.log(
        `${style.green('✓')} +${result.newCount} nuovi, ${result.healedCount} recuperati, ` +
        `${result.removedCount} rimossi, ${result.restoredCount} ripristinati`
      );
    });

  return cmd;
}
