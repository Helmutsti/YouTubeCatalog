import { Command } from 'commander';
import * as core from '@catalog/core';

import { style } from '../format.js';

export function libraryCommand() {
  const cmd = new Command('library').description('gestione della libreria (fusione)');

  cmd
    .command('merge <sourcePath>')
    .description('fonde una libreria sorgente (cartella data/+media/) nella libreria corrente — mai i video fisici')
    .option('--dry-run', 'simula senza scrivere né copiare nulla')
    .action(async (sourcePath, opts) => {
      const result = await core.mergeLibrary(sourcePath, { dryRun: !!opts.dryRun });
      const prefix = result.dryRun ? style.dim('[dry-run] ') : '';

      console.log(`${prefix}${style.green('✓')} sorgente: ${result.sourceRoot}`);
      console.log(
        `  video: +${result.videos.added} nuovi, ${result.videos.updated} aggiornati, ${result.videos.unchanged} invariati`
      );
      console.log(`  fonti: +${result.sources.added} nuove, ${result.sources.updated} aggiornate`);
      console.log(`  avatar canali: +${result.channelAvatars.added} nuovi, ${result.channelAvatars.updated} aggiornati`);
      console.log(`  copertine copiate: ${result.thumbnailsCopied}, avatar copiati: ${result.avatarsCopied}`);
      console.log(`  metadati grezzi aggiunti: ${result.metadataEntriesAdded}, coda link: +${result.queueAdded}`);
      if (result.safetyBackupPath) {
        console.log(style.dim(`  backup di sicurezza pre-merge: ${result.safetyBackupPath}`));
      }
    });

  return cmd;
}
