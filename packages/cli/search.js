// M86 — traduzione di `cli/src/search.rs`.
//
// Cerca: si scrive, si scelgono i risultati, si agisce. La ricerca la fa il core
// (`searchLibrary`) — qui non c'è nessuna regola di corrispondenza.

import { input } from '@inquirer/prompts';

import * as ui from './ui.js';
import * as library from './library.js';

const BACK = Symbol('back');
const ALTRO = Symbol('altro');

async function inputOpt(message, initial) {
  try {
    return await input({ message, default: initial });
  } catch (err) {
    if (err?.name === 'ExitPromptError') return '';
    throw err;
  }
}

export async function open(app) {
  let query = '';
  while (true) {
    await app.pump();
    ui.screen('Cerca', app);

    query = await inputOpt('Cerca', query);
    if (!query.trim()) return;

    while (true) {
      await app.pump();
      const risultati = app.lib.search(query);
      ui.screen(`Cerca · «${query}» — ${risultati.length} risultati`, app);

      const voci = [
        ...risultati.map((v) => ({ name: ui.videoLine(v), value: v.id })),
        { name: 'Cerca altro', value: ALTRO },
        { name: '← indietro', value: BACK }
      ];

      const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value });
      if (scelta === null || scelta === BACK) return;
      // "Cerca altro" torna al prompt tenendo la query, così si corregge invece
      // di riscriverla.
      if (scelta === ALTRO) break;
      await library.actions(app, scelta);
    }
  }
}
