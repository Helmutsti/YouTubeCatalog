import { Command } from 'commander';
import * as core from '@catalog/core';

// M91 — procura yt-dlp/ffmpeg/ffprobe in tools/. Esiste come sotto-comando (e
// non solo come script npm) perché il pacchetto standalone di ondo-cli può
// essere installato globalmente (npm install -g <tarball>), dove non c'è un
// package.json locale da cui lanciare "npm run setup".
export function setupCommand() {
  return new Command('setup')
    .description('scarica yt-dlp/ffmpeg/ffprobe in tools/ (per il tuo sistema)')
    .option('--force', 'riscarica tutto, anche se già presente')
    .action(async (opts) => {
      const { ok } = await core.setupTools({ force: opts.force });
      if (!ok) process.exitCode = 1;
    });
}
