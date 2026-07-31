// M86 — traduzione di `cli/src/ui.rs`.
//
// Le briciole comuni a tutti i menu: pulire lo schermo, un messaggio che
// sopravvive a un ridisegno, e come si scrive una riga di video.

import { select as inquirerSelect } from '@inquirer/prompts';

import * as core from '../../core/src/index.js';

// I colori del crate `console` a mano, con i codici ANSI: la CLI non prende una
// dipendenza per sei sequenze di escape. Si spengono da sé quando l'output non è
// un terminale (output rediretto, pipe), come faceva `console`.
const COLORED = process.stdout.isTTY;
const ESC = String.fromCharCode(27);
const wrap = (open) => (text) => (COLORED ? `${ESC}[${open}m${text}${ESC}[0m` : String(text));

export const style = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36)
};

/** I livelli offerti nelle impostazioni, «Chiedi ogni volta» compreso. */
export const LIVELLI = core.QUALITY_LEVELS;

/** Gli stessi livelli senza «Chiedi ogni volta»: qui la domanda è già stata fatta. */
export const PER_DOWNLOAD = core.QUALITY_PER_DOWNLOAD;

// Quante voci per pagina negli elenchi lunghi: il `max_length(15)` dell'originale.
export const PAGE = 15;

/**
 * Un `Select` a frecce che si può **annullare**, come `interact_opt` di
 * dialoguer: Esc o Ctrl-C danno `null` invece di terminare il processo. È così
 * che nell'originale si torna indietro da un menu senza scegliere niente.
 */
export async function selectOpt({ message = '', choices, defaultValue, pageSize = PAGE }) {
  try {
    return await inquirerSelect({
      message,
      choices,
      default: defaultValue,
      pageSize,
      loop: false,
      // Un elenco di dialoguer non ha né un `?` davanti né una riga di aiuto in
      // fondo ("↑↓ navigate • ⏎ select"): le voci cominciano subito sotto
      // l'intestazione della schermata. Prefisso e messaggio vuoti fanno cadere
      // la prima riga per intero (il prompt la filtra se resta vuota), e la riga
      // di aiuto passa da `style.keysHelpTip`, che qui non stampa niente.
      theme: { prefix: '', style: { keysHelpTip: () => '' } }
    });
  } catch (err) {
    if (err?.name === 'ExitPromptError') return null;
    throw err;
  }
}

/**
 * Chiede la risoluzione con un menu a frecce.
 *
 * `null` = l'utente ha annullato; `{ maxHeight }` = scelto (`null` dentro = la
 * migliore disponibile).
 */
export async function askQuality(prompt) {
  console.log(`${style.dim(prompt)}\n`);
  const scelta = await selectOpt({
    choices: PER_DOWNLOAD.map((q, i) => ({ name: core.qualityLabel(q), value: i })),
    defaultValue: 0,
    pageSize: PER_DOWNLOAD.length
  });
  if (scelta === null) return null;
  return { maxHeight: core.maxHeightOf(PER_DOWNLOAD[scelta]) };
}

/**
 * Il tetto da usare per un download che parte adesso: se la config dice
 * «chiedi», si chiede; altrimenti si usa quello che dice. `null` = annullato.
 */
export async function resolveQuality(quality, prompt) {
  if (quality.kind === core.QUALITY_ASK) return askQuality(prompt);
  return { maxHeight: core.maxHeightOf(quality) };
}

/**
 * Pulisce e ristampa l'intestazione, più l'eventuale messaggio in sospeso.
 *
 * I menu vivono in cicli: senza questo, ogni versione precedente di un elenco
 * resta stampata sopra la nuova e dopo pochi giri lo schermo è illeggibile.
 */
export function screen(title, holder) {
  if (process.stdout.isTTY) console.clear();
  console.log(style.bold(style.dim(`── ${title} `)));
  if (holder?.message) {
    console.log(`${holder.message}\n`);
    holder.message = null;
  }
}

/** Un messaggio che va letto: comparirà dopo il prossimo `screen`, una volta sola. */
export function ok(holder, text) {
  holder.message = `${style.green('✓')} ${text}`;
}

export function err(holder, text) {
  holder.message = `${style.red('✗')} ${text?.message ?? text}`;
}

/** Il simbolo dello stato: si riconosce a colpo d'occhio in un elenco lungo. */
export function glyph(v) {
  const s =
    v.state === core.STATE.DOWNLOADED ? style.green('●') :
    v.state === core.STATE.DOWNLOADING ? style.cyan('↓') :
    v.state === core.STATE.FAILED ? style.red('✗') :
    style.yellow('○');
  const fav = v.favorite ? style.yellow(' ★') : '';
  const arch = v.archived ? style.dim(' ▤') : '';
  const rem = v.removed ? style.red(' ⚑') : '';
  return `${s}${fav}${arch}${rem}`;
}

// `{:>7}` e `{:<22.22}` dell'originale: allineamento e troncatura in caratteri.
function padStart(text, width) {
  const s = String(text ?? '');
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function padTruncate(text, width) {
  const s = [...String(text ?? '')];
  if (s.length > width) return s.slice(0, width).join('');
  return s.join('') + ' '.repeat(width - s.length);
}

/** Una riga d'elenco: stato, durata, autore, titolo. */
export function videoLine(v) {
  return `${glyph(v)} ${padStart(core.durationLabel(v.durationSeconds), 7)}  ${padTruncate(v.author, 22)}  ${v.title}`;
}

/**
 * Come `videoLine`, ma con un'etichetta in coda: serve dove lo stato va detto a
 * parole e non basta il simbolo (per esempio «In download» fra gli in attesa).
 */
export function videoLineTagged(v, tag) {
  return `${videoLine(v)}  ${style.cyan(tag)}`;
}

export function sizeLabel(bytes) {
  const mb = Number(bytes ?? 0) / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/** La barra di avanzamento del Download rapido. */
export function bar(percent, width) {
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Il tetto scelto per un download, in breve: `1080p`, o niente se è la massima. */
export function capLabel(maxHeight) {
  return maxHeight ? `${maxHeight}p` : '';
}
