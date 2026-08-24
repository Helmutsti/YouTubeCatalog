#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import * as core from '@catalog/core';

import { videoCommand } from '../src/commands/video.js';
import { authorCommand } from '../src/commands/author.js';
import { sourceCommand } from '../src/commands/source.js';
import { libraryCommand } from '../src/commands/library.js';
import { setupCommand } from '../src/commands/setup.js';
import { menuCommand, launchMenu } from '../src/commands/menu.js';
import { initCommand } from '../src/commands/init.js';

// Letta da package.json invece di essere hardcoded: la versione pubblicata
// nel .tgz della release viene scritta lì da scripts/package-ondo-cli.mjs
// (uguale al tag della release), quindi `ondo --version` la rispecchia sempre.
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

async function main() {
  // M96/M98 — quale applicazione siamo: decide il file di impostazioni. Prima di
  // tutto, menu compreso: sotto-comandi e menu sono lo stesso programma e
  // devono leggere le stesse impostazioni (`config/ondo.json`).
  core.setAppId('ondo');

  // `ondo` senza argomenti apre il menu: è quello che uno digita. Lo stesso menu
  // ha anche un comando esplicito (`ondo menu`), che lo rende scopribile in
  // `--help` e utilizzabile dentro uno script senza ambiguità.
  if (process.argv.length <= 2) {
    await launchMenu();
    return;
  }

  const program = new Command();
  program
    .name('ondo')
    .description('ondo — il catalogo video da terminale')
    .version(version)
    // M98 — la libreria è quella in cui ti trovi; questa opzione serve a
    // indicarne un'altra senza spostarsi (script, automazioni). Va sul programma
    // radice, così vale per ogni sotto-comando, e si applica in un `hook` prima
    // dell'azione: il core la deve sapere prima che qualcuno risolva un percorso.
    .option('--library <percorso>', 'lavora su questa libreria invece che sulla cartella corrente')
    .hook('preAction', (thisCommand) => {
      const { library } = thisCommand.opts();
      if (library) core.setLibraryOverride(library);
    });

  // Lock consultivo su data/ (M80/M92): si attiva da solo a ogni scrittura
  // vera e propria (dentro il core), non qui — un sotto-comando di sola
  // lettura (es. "video list") non tocca mai il lock, quante altre `ondo` o il
  // server siano aperti insieme. Qui si imposta solo il ruolo mostrato nel
  // messaggio a chi trova il lock occupato.
  core.setLockRole('ondo');

  program.addCommand(initCommand());
  program.addCommand(menuCommand());
  program.addCommand(videoCommand());
  program.addCommand(authorCommand());
  program.addCommand(sourceCommand());
  program.addCommand(libraryCommand());
  program.addCommand(setupCommand());

  await program.parseAsync(process.argv);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✗ ${err?.message ?? err}`);
    process.exit(1);
  });
