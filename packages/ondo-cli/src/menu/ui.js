// M86 — traduzione di `cli/src/ui.rs`.
//
// Le briciole comuni a tutti i menu: pulire lo schermo, un messaggio che
// sopravvive a un ridisegno, e come si scrive una riga di video.

import readline from 'node:readline';

import { select as inquirerSelect, input as inquirerInput, confirm as inquirerConfirm } from '@inquirer/prompts';

import * as core from '@catalog/core';

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
 * Quanto `readline` aspetta, dopo un `Esc`, per capire se è l'inizio di una
 * sequenza più lunga (M89). Il suo default è **500ms**, e sono i 500ms che si
 * sentivano come «Esc è un po' lento»: misurati, il byte `1b` arriva in 1ms e
 * l'evento `escape` 513ms dopo.
 *
 * Perché 20ms bastano: una freccia arriva in **un solo chunk** (`1b 5b 42`),
 * non spezzata — verificato — quindi la finestra serve solo a coprire una
 * sequenza divisa in due letture, che su un terminale locale non capita. Se un
 * giorno la CLI girasse su un collegamento molto lento (SSH), una freccia
 * spezzata con più di 20ms di ritardo verrebbe letta come Esc + `[B`: è il
 * prezzo consapevole di questa scelta, e il numero sta qui per poterlo alzare.
 */
const ESCAPE_TIMEOUT_MS = 20;

/**
 * Installa il decoder dei tasti su `stdin` **prima** di chiunque altro.
 *
 * `readline.emitKeypressEvents` esce subito se il decoder c'è già, e il timeout
 * lo cattura chi lo installa: quindi il primo che chiama decide per tutto il
 * processo. Chiamandolo noi al caricamento di questo modulo — che è il primo che
 * la CLI importa — sia i prompt di `@inquirer` sia la schermata in raw mode del
 * Download rapido ereditano la finestra corta senza saperne niente.
 */
readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: ESCAPE_TIMEOUT_MS });

export const KEYPRESS_OPTS = { escapeCodeTimeout: ESCAPE_TIMEOUT_MS };

/**
 * `Ctrl-C` **non** è «indietro» (M89): in un terminale significa «interrompi
 * adesso», e ora che `Esc` fa da indietro non c'è più motivo di prestargli quel
 * significato (in M86 gliel'avevamo dato perché era l'unico tasto disponibile).
 *
 * Non è un errore dell'operazione in corso: è una richiesta che deve
 * **attraversare** i `catch` intermedi e arrivare in cima. Per questo è un tipo
 * a sé e ogni `catch` della CLI la rilancia invece di mostrarla come «✗ …».
 */
export class Interruzione extends Error {
  constructor() {
    super('Interrotto.');
    this.name = 'Interruzione';
  }
}

export function isInterruzione(e) {
  return e?.name === 'Interruzione';
}

/**
 * Rende **annullabile con Esc** un prompt di `@inquirer` (M88).
 *
 * `@inquirer` non ha un tasto "annulla": `dialoguer` sì (`interact_opt`), e la
 * CLI è la sua traduzione, quindi il tasto va aggiunto. Come: un `AbortSignal`
 * passato al prompt (che alla sua cancellazione esce con `AbortPromptError`) e
 * un ascoltatore `keypress` su `stdin` che lo cancella quando arriva `escape`.
 *
 * Perché `keypress` e non i byte grezzi: un `Esc` da solo (`0x1b`) e una freccia
 * (`0x1b [ A`) cominciano con lo **stesso** byte. Distinguerli a mano vorrebbe
 * dire riscrivere il parser delle sequenze ANSI; `readline` — che `@inquirer`
 * tiene già acceso sullo stdin per conto suo — lo ha già fatto e chiama `escape`
 * solo l'Esc vero. Verificato sul campo prima di scriverlo: durante un `select`
 * l'ascoltatore vede `down | escape`, mai un `escape` per una freccia.
 *
 * L'ascoltatore si stacca **sempre** (`finally`): lasciarlo attaccato terrebbe
 * `stdin` in flowing mode e il prompt successivo si mangerebbe dei tasti.
 */
export async function annullabile(run) {
  const controller = new AbortController();
  const onKey = (_ch, key) => {
    if (key?.name === 'escape') controller.abort();
  };
  process.stdin.on('keypress', onKey);
  try {
    return await run(controller.signal);
  } catch (err) {
    // Esc → «niente scelto», e chi chiama decide cosa vuol dire.
    if (err?.name === 'AbortPromptError') return null;
    // Ctrl-C → si esce dal programma: la si rilancia perché arrivi in cima.
    if (err?.name === 'ExitPromptError') throw new Interruzione();
    throw err;
  } finally {
    process.stdin.off('keypress', onKey);
  }
}

/**
 * Un `Select` a frecce che si può **annullare**, come `interact_opt` di
 * dialoguer: Esc o Ctrl-C danno `null` invece di terminare il processo. È così
 * che nell'originale si torna indietro da un menu senza scegliere niente.
 */
export async function selectOpt({ message = '', choices, defaultValue, pageSize = PAGE }) {
  return annullabile((signal) =>
    inquirerSelect(
      {
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
      },
      { signal }
    )
  );
}

/** Un campo di testo annullabile con Esc: `null` = annullato (M88). */
export async function inputOpt({ message, initial }) {
  return annullabile((signal) => inquirerInput({ message, default: initial }, { signal }));
}

/** Una conferma annullabile con Esc: `null` = annullato, diverso da `false` (M88). */
export async function confirmOpt({ message, defaultValue = false }) {
  return annullabile((signal) => inquirerConfirm({ message, default: defaultValue }, { signal }));
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

/**
 * Una riga d'elenco: stato, durata, autore, titolo.
 *
 * `autore: false` (M88) toglie la colonna dell'autore: in una vista **centrata su
 * un autore** quel nome è già nell'intestazione e ripeterlo su ogni riga occupa
 * 24 colonne per non dire niente — colonne che qui servono al titolo, che è
 * l'unica cosa che distingue una riga dall'altra.
 */
export function videoLine(v, { autore = true } = {}) {
  const durata = padStart(core.durationLabel(v.durationSeconds), 7);
  if (!autore) return `${glyph(v)} ${durata}  ${v.title}`;
  return `${glyph(v)} ${durata}  ${padTruncate(v.author, 22)}  ${v.title}`;
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
