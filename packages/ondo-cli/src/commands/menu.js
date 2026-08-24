// M98 — `ondo menu`: l'interfaccia a frecce, che da questa milestone vive dentro
// lo stesso pacchetto dei sotto-comandi (era `@catalog/cli`, un package a sé).
//
// `launchMenu` è esportata anche a parte perché `ondo` senza argomenti apre il
// menu: è quello che uno digita, e continuare a farlo funzionare non costa
// niente. Il comando esplicito serve a renderlo scopribile in `ondo --help`.

import { Command } from 'commander';

/**
 * Carica e avvia il menu.
 *
 * L'import è DINAMICO, e non per abitudine: `@inquirer/prompts` (dentro ui.js)
 * installa un decoder di tasti su stdin appena viene importato. Per un
 * `ondo video list`, che stampa una tabella e muore, sarebbe inutile e dannoso.
 *
 * Non c'è più il ramo "menu non incluso in questo pacchetto": prima il menu
 * poteva mancare, ed è proprio quel messaggio gentile che per mesi ha fatto
 * sembrare voluto un artifact rotto. Ora è sempre qui, quindi un import che
 * fallisce è un guasto vero e deve risalire.
 */
export async function launchMenu() {
  const { run } = await import('../menu/cli.js');
  const ui = await import('../menu/ui.js');
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

export function menuCommand() {
  return new Command('menu')
    .description("apre l'interfaccia a frecce sulla libreria in cui ti trovi")
    .action(async () => {
      await launchMenu();
    });
}
