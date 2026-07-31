// M86 — traduzione di `cli/src/quick.rs`.
//
// Download rapido: l'unica schermata che prende il terminale in mano.
//
// Il prompt resta attivo mentre i download vanno, e le righe sopra si aggiornano
// da sole. Perché funzioni servono due cose: leggere i tasti **senza bloccare**
// (in Rust era `event::poll` con un timeout; qui sono gli eventi `keypress` di
// Node, che l'event loop consegna fra un ridisegno e l'altro) e non lasciare
// niente attaccato allo stdin quando si esce — è così che una console del genere
// finisce per mangiarsi i tasti del menu in cui si torna dopo.
//
// Questa schermata **non ha stato proprio**: a ogni ridisegno rilegge i job dal
// pool (`Downloader.statuses`). Uscire e rientrare quindi non perde niente,
// perché non c'era niente da perdere.

import readline from 'node:readline';

import * as core from '../../core/src/index.js';
import * as ui from './ui.js';

const RIDISEGNO_MS = 120;

const ESC = String.fromCharCode(27);
const term = {
  write: (s) => process.stdout.write(s),
  clearAll: () => `${ESC}[2J`,
  clearLine: () => `${ESC}[2K`,
  clearDown: () => `${ESC}[J`,
  moveTo: (row, col = 0) => `${ESC}[${row + 1};${col + 1}H`,
  hideCursor: () => `${ESC}[?25l`,
  showCursor: () => `${ESC}[?25h`
};

/** Come si scrive una riga: i cinque passi che l'utente vede. */
function label(s) {
  const chi = s.title ? `«${s.title}»` : s.url;
  if (s.error) return `✗  ${chi} — ${s.error}`;
  if (s.done) return `✓  fatto, in libreria — ${chi}`;
  switch (s.phase) {
    case null:
    case undefined:
      return `…  in coda — ${chi}`;
    case 'resolve':
      return `…  risolvendo ${s.url}`;
    case 'metadata':
      return `…  recupero metadati — ${chi}`;
    case 'video':
      return s.percent === null || s.percent === undefined
        ? `…  scarico — ${chi}`
        : `${ui.bar(s.percent, 24)} ${s.percent.toFixed(1).padStart(5)}%  ${chi}`;
    default:
      return `…  ${chi}`;
  }
}

export async function open(app) {
  // Lo stato della schermata: si scrive un link (`prompt`), oppure si sceglie la
  // risoluzione per il link appena incollato (`quality`).
  //
  // La scelta della risoluzione la disegniamo noi e non un menu esterno: qui il
  // terminale è in raw mode e i tasti li leggiamo noi, quindi un prompt che
  // vuole lo stdin per sé non può entrarci in mezzo.
  let focus = { kind: 'prompt' };
  let input = '';
  let uscita = null;

  const stdin = process.stdin;
  const eraRaw = stdin.isRaw;
  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  term.write(term.clearAll());

  const disegna = () => {
    const rows = app.dl.statuses();
    draw(app, rows, input, focus);
  };

  const onKeypress = (str, key) => {
    if (!key) return;
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      uscita?.();
      return;
    }

    if (focus.kind === 'prompt') {
      if (key.name === 'escape') {
        uscita?.();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        input = '';
      } else if (key.name === 'backspace') {
        input = [...input].slice(0, -1).join('');
      } else if (key.name === 'return' || key.name === 'enter') {
        const url = input.trim();
        input = '';
        if (url) {
          if (app.lib.config().quality.kind === core.QUALITY_ASK) {
            // Il download è "lanciato", ma prima si decide con che risoluzione:
            // è questa la scelta di «chiedi ogni volta».
            focus = { kind: 'quality', url, sel: 0 };
          } else {
            // Niente da aggiungere a mano: il job compare da sé al prossimo
            // ridisegno, perché il pool sa già che esiste.
            void app.enqueue(url);
          }
        }
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
        input += str;
      }
    } else if (focus.kind === 'quality') {
      const n = ui.PER_DOWNLOAD.length;
      if (key.name === 'up' || key.name === 'k') {
        focus.sel = (focus.sel - 1 + n) % n;
      } else if (key.name === 'down' || key.name === 'j') {
        focus.sel = (focus.sel + 1) % n;
      } else if (key.name === 'return' || key.name === 'enter') {
        const cap = core.maxHeightOf(ui.PER_DOWNLOAD[focus.sel]);
        const url = focus.url;
        focus = { kind: 'prompt' };
        void app.enqueueWith(url, cap);
      } else if (key.name === 'escape') {
        // Annullare rimette il link nel prompt: si è già preso la briga di
        // incollarlo, non gli si fa ricominciare da capo.
        input = focus.url;
        focus = { kind: 'prompt' };
      }
    }
    disegna();
  };

  stdin.on('keypress', onKeypress);

  // Qui si pompa in continuazione: è la differenza fra questa schermata e un
  // menu, dove nessuno rilegge lo stato mentre si aspetta un tasto.
  const battito = setInterval(async () => {
    await app.pump();
    disegna();
  }, RIDISEGNO_MS);

  await app.pump();
  disegna();

  await new Promise((resolve) => {
    uscita = resolve;
  });

  clearInterval(battito);
  stdin.off('keypress', onKeypress);
  if (stdin.isTTY) stdin.setRawMode(!!eraRaw);
  stdin.pause();
  term.write(`${term.clearAll()}${term.moveTo(0, 0)}${term.showCursor()}`);
}

function draw(app, rows, input, focus) {
  const cols = Math.max(40, process.stdout.columns ?? 100);
  const altezza = Math.max(8, process.stdout.rows ?? 30);

  let out = `${term.hideCursor()}${term.moveTo(0, 0)}${term.clearLine()}`;
  out += `── Download rapido · ${app.dl.inFlight()} in corso, ${app.dl.queued()} in coda\r\n`;
  out += term.clearLine();
  const aiuto =
    focus.kind === 'prompt'
      ? '   Invio accoda · Esc torna al menu (i download continuano)'
      : '   ↑↓ scegli · Invio conferma · Esc rimetti il link nel prompt';
  out += `${aiuto}\r\n`;
  out += `${term.clearLine()}\r\n`;

  // Le righe visibili sono le ultime: sono quelle che stanno succedendo. Quando
  // si sta scegliendo la risoluzione ne cedono lo spazio, invece di sparire.
  const promptY = altezza - 2;
  const altaScelta = focus.kind === 'prompt' ? 0 : ui.PER_DOWNLOAD.length + 1;
  const fineRighe = Math.max(0, promptY - (altaScelta + 1));
  const spazio = Math.max(0, fineRighe - 3);
  const da = Math.max(0, rows.length - spazio);

  const visibili = rows.slice(da);
  visibili.forEach((row, i) => {
    out += term.moveTo(3 + i) + term.clearLine();
    const cap = ui.capLabel(row.maxHeight);
    const suffisso = cap ? ` [${cap}]` : '';
    let testo = `  ${label(row)}${suffisso}`;
    const chars = [...testo];
    if (chars.length > cols) testo = chars.slice(0, cols - 1).join('');
    out += testo;
  });
  out += term.moveTo(3 + visibili.length) + term.clearDown();

  if (focus.kind === 'quality') {
    const y0 = promptY - altaScelta;
    out += term.moveTo(y0) + term.clearLine();
    const breve = [...focus.url].slice(0, Math.max(0, cols - 24)).join('');
    out += `  Che risoluzione per ${breve}?`;
    ui.PER_DOWNLOAD.forEach((q, i) => {
      out += term.moveTo(y0 + 1 + i) + term.clearLine();
      out += `  ${i === focus.sel ? '❯' : ' '} ${core.qualityLabel(q)}`;
    });
  }

  if (focus.kind === 'prompt') {
    const prompt = 'Incolla il link: ';
    out += term.moveTo(promptY) + term.clearLine();
    out += `${prompt}${input}`;
    const x = Math.min(cols - 1, [...prompt].length + [...input].length);
    out += term.moveTo(promptY, x) + term.showCursor();
  } else {
    out += term.moveTo(promptY) + term.clearLine();
    out += '  Invio per far partire il download';
  }

  term.write(out);
}
