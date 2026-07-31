// M80 — un lock su `data/`, invece di una regola che l'utente deve ricordare.
//
// Il problema, che succede davvero: ogni processo tiene `catalog.json` in
// memoria e **riscrive tutto** quando salva. Server e CLI aperti insieme si
// sovrascrivono a vicenda — l'ultimo che salva cancella il lavoro dell'altro.
// Finora era documentato come regola in `progetto.md` («quel processo va
// riavviato»), il che vuol dire che il danno dipendeva dalla memoria di chi usa
// l'app. Un file di lock lo trasforma in un messaggio chiaro.
//
// È un lock **consultivo**: non impedisce fisicamente la scrittura (nessun
// blocco del sistema operativo), dice a chi arriva secondo che c'è già qualcuno.
// Basta, perché tutti i processi che scrivono il catalogo sono nostri.

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from './config.js';

// Ogni quanto il proprietario dichiara di essere vivo, e dopo quanto silenzio
// il lock si considera abbandonato. La finestra è larga (tre battiti) perché un
// falso "è morto" è il caso peggiore: due processi che scrivono insieme è
// esattamente ciò che stiamo evitando. Un processo sospeso dal sistema
// operativo per qualche secondo non deve perdere il lock.
const HEARTBEAT_MS = 10_000;
const STALE_AFTER_MS = HEARTBEAT_MS * 3;

let held = null;

function lockPath() {
  return path.join(getPaths().dataDir, '.lock');
}

// Un pid esiste ancora? `kill(pid, 0)` non invia niente, controlla solo.
// EPERM = il processo c'è ma non è nostro (utente diverso): vivo, quindi il
// lock è valido. ESRCH = non esiste.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    // Illeggibile o troncato (scrittura interrotta a metà): non dice niente di
    // utile, quindi vale come lock abbandonato. Non è un caso da far esplodere.
    return null;
  }
}

// Un lock è abbandonato **solo se il processo che lo teneva non esiste più**.
//
// La prima versione considerava abbandonato anche un lock col battito fermo da
// più di mezzo minuto, *anche con il processo vivo* — e la verifica fra due
// processi ha mostrato che quel lock si lasciava rubare. È il difetto peggiore
// possibile qui, perché il caso in cui succede è concreto: il proprietario che
// non batte è tipicamente uno che ha l'event loop occupato da qualcosa di lungo
// e sincrono (lo zip del backup su ~94GB), cioè **proprio mentre sta scrivendo**.
// Portargli via la libreria in quel momento è esattamente il danno che questo
// file esiste per prevenire.
//
// Il battito quindi non decide più: serve solo a *raccontare* la situazione. Il
// prezzo è che un pid riciclato (il sistema lo riassegna a un programma
// qualunque) tiene il lock finché non si cancella il file a mano — ma allora
// l'utente riceve un messaggio che glielo dice, che è un guaio recuperabile,
// mentre un catalogo sovrascritto non lo è.
function isStale(info) {
  if (!info) return true;
  return !processAlive(info.pid);
}

// Da quanto il proprietario non dà segni di vita. `null` se non si sa.
function silentFor(info) {
  const last = Date.parse(info?.heartbeatAt ?? info?.startedAt ?? '');
  return Number.isFinite(last) ? Date.now() - last : null;
}

function describe(info) {
  if (!info) return 'un altro processo';
  const who = info.role ? `"${info.role}"` : 'un processo';
  const when = info.startedAt ? ` avviato ${info.startedAt}` : '';
  return `${who} (pid ${info.pid})${when}`;
}

/**
 * Prende il lock sulla cartella `data/`.
 *
 * @param {string} role a cosa serve, per il messaggio d'errore ("server", "CLI")
 * @param {{force?: boolean}} options force = prendilo comunque (ultima spiaggia)
 * @returns {() => void} la funzione per rilasciarlo (idempotente)
 * @throws se un altro processo vivo lo tiene
 */
export function acquireDataLock(role, { force = false } = {}) {
  if (held) return held.release;

  const file = lockPath();
  const payload = () => JSON.stringify({
    pid: process.pid,
    role,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  }, null, 2);

  // `wx` = crea e fallisci se esiste: è la creazione atomica, ed è ciò che rende
  // il lock una vera esclusione invece di un "guarda se c'è, poi scrivi" che due
  // processi possono superare insieme.
  try {
    writeFileSync(file, payload(), { flag: 'wx', encoding: 'utf-8' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    const existing = readLock(file);
    if (!force && !isStale(existing)) {
      const silenzio = silentFor(existing);
      // Un proprietario vivo ma zitto da un pezzo è l'unico caso in cui l'utente
      // può avere ragione a insistere: o quel processo è occupato in qualcosa di
      // lungo, o il pid è stato riciclato e il lock è di nessuno. Non lo si
      // indovina per lui — gli si dice come uscirne.
      const sospetto = silenzio !== null && silenzio > STALE_AFTER_MS
        ? `\n  Quel processo non dà segni di vita da ${Math.round(silenzio / 1000)}s: se sei sicuro che\n` +
          `  nessun Ondo sia aperto, cancella ${file} e riprova.`
        : '';
      throw new Error(
        `La libreria in ${getPaths().dataDir} è già in uso da ${describe(existing)}.\n` +
        '  Due processi sulla stessa libreria si sovrascrivono a vicenda: chiudi\n' +
        '  quello aperto (server o CLI) e riprova.' + sospetto
      );
    }

    // Abbandonato: si rimuove e si riprova **una volta sola**. Se anche il
    // secondo tentativo trova il file occupato, significa che un altro processo
    // l'ha preso in questo istante — e allora ha vinto lui, non si insiste.
    try { unlinkSync(file); } catch { /* l'ha già tolto qualcun altro */ }
    try {
      writeFileSync(file, payload(), { flag: 'wx', encoding: 'utf-8' });
    } catch (retryErr) {
      if (retryErr.code !== 'EEXIST') throw retryErr;
      throw new Error(
        `La libreria in ${getPaths().dataDir} è stata appena presa da un altro processo.\n` +
        '  Riprova fra un momento.'
      );
    }
  }

  const beat = setInterval(() => {
    try {
      // Si riscrive solo se il file è ancora **nostro**: se qualcuno ce l'ha
      // portato via (o l'ha cancellato a mano), non lo si ricrea a sua insaputa.
      const current = readLock(file);
      if (current?.pid !== process.pid) return;
      writeFileSync(file, JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }, null, 2), 'utf-8');
    } catch { /* il battito è un'informazione, non un'operazione critica */ }
  }, HEARTBEAT_MS);
  // Il lock non deve tenere in piedi il processo: senza unref, un CLI che ha
  // finito resterebbe aperto per via del timer.
  beat.unref?.();

  const release = () => {
    clearInterval(beat);
    if (!held) return;
    held = null;
    try {
      if (existsSync(file) && readLock(file)?.pid === process.pid) unlinkSync(file);
    } catch { /* niente da fare: al prossimo avvio verrà visto come abbandonato */ }
  };

  held = { release };
  // Rilascio all'uscita, anche su Ctrl-C. `exit` copre la fine normale e
  // `process.exit()`; i due segnali coprono la chiusura da terminale, che
  // altrimenti salterebbe `exit` lasciando il lock lì (recuperabile come
  // abbandonato dopo mezzo minuto, ma è meglio non farglielo aspettare).
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });

  return release;
}
