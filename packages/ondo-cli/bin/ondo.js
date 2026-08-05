#!/usr/bin/env node
import { Command } from 'commander';
import * as core from '@catalog/core';

import { videoCommand } from '../src/commands/video.js';
import { authorCommand } from '../src/commands/author.js';
import { sourceCommand } from '../src/commands/source.js';

// `ondo` senza argomenti resta il menu interattivo di sempre (@catalog/cli);
// gli import di quel package restano dinamici perché caricano @inquirer/prompts
// e installano un decoder di tasti su stdin — inutile, e da evitare, per una
// singola chiamata a sotto-comando.
async function launchMenu() {
  let mod;
  let uiMod;
  try {
    mod = await import('@catalog/cli/cli.js');
    uiMod = await import('@catalog/cli/ui.js');
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('Il menu interattivo non è incluso in questo pacchetto. Usa: ondo --help');
      process.exit(0);
    }
    throw e;
  }
  const { run } = mod;
  const ui = uiMod;
  try {
    await run();
  } catch (e) {
    if (ui.isInterruzione(e)) {
      console.log(`\n${ui.style.dim('Interrotto.')}`);
      process.exit(130);
    }
    throw e;
  }
}

async function main() {
  if (process.argv.length <= 2) {
    await launchMenu();
    return;
  }

  const program = new Command();
  program
    .name('ondo')
    .description('ondo — il catalogo video da terminale')
    .version('0.1.0');

  // Lock consultivo su data/ (M80), preso una volta prima di qualunque
  // sotto-comando che tocchi il catalogo — stesso lock del menu interattivo.
  program.hook('preAction', () => core.acquireDataLock('ondo'));

  program.addCommand(videoCommand());
  program.addCommand(authorCommand());
  program.addCommand(sourceCommand());

  await program.parseAsync(process.argv);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✗ ${err?.message ?? err}`);
    process.exit(1);
  });
