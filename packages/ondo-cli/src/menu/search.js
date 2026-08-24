// M86 — traduzione di `cli/src/search.rs`.
//
// Cerca: si scrive, si scelgono i risultati, si agisce. La ricerca la fa il core
// (`searchLibrary`) — qui non c'è nessuna regola di corrispondenza.

import * as ui from './ui.js';
import * as library from './library.js';

const BACK = Symbol('back');
const ALTRO = Symbol('altro');

// M88: Esc (come Ctrl-C) annulla la ricerca. Una query vuota è già il modo in cui
// questa schermata torna al menu, quindi "annullato" diventa la stringa vuota.
async function inputOpt(message, initial) {
  return (await ui.inputOpt({ message, initial })) ?? '';
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
