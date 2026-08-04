import { Command } from 'commander';
import * as core from '@catalog/core';

import { printTable, style } from '../format.js';

// Nel core l'autore non è un'entità a sé: è derivato da video.channel
// (core/src/services/videoService.js). "name" e "key" possono coincidere o no
// (key preferisce l'id canale quando c'è), quindi il lookup accetta entrambi.
async function findChannel(nameOrKey) {
  const channels = await core.listChannels();
  const channel = channels.find((c) => c.name === nameOrKey || c.key === nameOrKey);
  if (!channel) throw new Error(`autore non trovato: "${nameOrKey}"`);
  return channel;
}

export function authorCommand() {
  const cmd = new Command('author').description('gestisci gli autori/canali (derivati dai video)');

  cmd
    .command('list')
    .description('elenca gli autori/canali')
    .option('--json', 'stampa come JSON')
    .action(async (opts) => {
      const channels = await core.listChannels();
      if (opts.json) {
        console.log(JSON.stringify(channels, null, 2));
        return;
      }
      printTable(channels, [
        { header: 'Nome', value: (c) => c.name },
        { header: 'Video', value: (c) => c.count }
      ]);
    });

  cmd
    .command('show <nome>')
    .description('elenca i video di un autore')
    .option('--json', 'stampa come JSON')
    .action(async (nome, opts) => {
      const channel = await findChannel(nome);
      const videos = await core.listVideosByChannel(channel.key);
      if (opts.json) {
        console.log(JSON.stringify(videos, null, 2));
        return;
      }
      printTable(videos, [
        { header: 'ID', value: (v) => v.id },
        { header: 'Titolo', value: (v) => v.title },
        { header: 'Download', value: (v) => v.download }
      ]);
    });

  cmd
    .command('sync-avatars [nome]')
    .description('sincronizza le foto profilo dei canali (tutti, o uno solo se indicato)')
    .option('--force', 'ri-scarica anche quelle già presenti', false)
    .action(async (nome, opts) => {
      const channelKey = nome ? (await findChannel(nome)).key : null;
      const result = await core.syncChannelAvatars({ force: opts.force, channelKey });
      console.log(
        `${style.green('✓')} ${result.fetchedCount} scaricate, ` +
        `${result.skippedCount} già a posto, ${result.failedCount} fallite`
      );
      for (const err of result.errors) console.log(`  ${style.red('✗')} ${err.name}: ${err.error}`);
    });

  return cmd;
}
