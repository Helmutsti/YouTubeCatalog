// M98 — `ondo init`: crea una libreria. È l'UNICO comando che lo fa.
//
// Prima non serviva: la libreria nasceva da sé, come effetto collaterale del
// primo comando che ne risolvesse i percorsi. Con la libreria presa dalla
// cartella corrente quella comodità diventa una trappola — un `ondo` lanciato
// per sbaglio in Documenti vi fabbricherebbe una libreria vuota, che al giro
// dopo è indistinguibile da una vera, mentre il tuo archivio resta invisibile a
// una cartella di distanza. Da qui la divisione: tutto il resto guarda, solo
// questo comando crea.

import { Command } from 'commander';
import * as core from '@catalog/core';

import { style } from '../format.js';

export function initCommand() {
  return new Command('init')
    .description('crea una libreria nuova (per default nella cartella corrente)')
    .argument('[percorso]', 'dove crearla', '.')
    .action(async (percorso) => {
      const { root, created } = core.initLibrary(percorso);
      console.log(`${style.green('✓')} libreria creata in ${root}`);
      for (const name of created) console.log(`  ${style.dim(name)}`);
      console.log(`\nDa qui dentro i comandi lavorano su questa libreria. Prova: ${style.dim('ondo menu')}`);
    });
}
