// M85 — la coda dei link non ancora risolti.
//
// Perché esiste: un link appena incollato **non è ancora un video**. Finché
// yt-dlp non l'ha risolto non ha id, titolo né autore, e `catalog.videos` è una
// mappa *per id*: non c'è posto dove metterlo. Prima di questa coda un link che
// falliva sulla risoluzione (rete giù, video privato, URL storto) spariva senza
// lasciare traccia — l'utente vedeva un errore di passaggio e non aveva più
// niente su cui riprovare.
//
// Un link esce di qui in un solo modo: quando diventa un video (risolto), o
// quando lo si toglie a mano.

import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';

// Normalizza per il confronto: lo stesso link incollato due volte non deve
// occupare due righe. Il confronto è sull'URL grezzo ripulito, non sull'id —
// che per definizione qui non c'è ancora.
function sameLink(a, b) {
  return String(a).trim() === String(b).trim();
}

/** I link in attesa, dal più recente. */
export async function listQueue() {
  const catalog = await readCatalog();
  return [...(catalog.queue ?? [])].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
}

/**
 * Mette un link in coda. Se c'è già, non lo duplica: aggiorna il tetto di
 * risoluzione e azzera l'errore, che è ciò che serve quando si riprova.
 * @returns {Promise<{queued: boolean}>}
 */
export async function enqueueLink(url, { maxHeight = null } = {}) {
  const link = String(url ?? '').trim();
  if (!link) throw new Error('Serve un link.');

  return updateCatalog((cat) => {
    if (!Array.isArray(cat.queue)) cat.queue = [];
    const existing = cat.queue.find((q) => sameLink(q.url, link));
    if (existing) {
      existing.maxHeight = maxHeight;
      existing.error = null;
      return { queued: false };
    }
    cat.queue.push({
      url: link,
      addedAt: new Date().toISOString(),
      attempts: 0,
      error: null,
      maxHeight
    });
    return { queued: true };
  });
}

/** Toglie un link dalla coda. Usata sia dall'utente sia da chi lo risolve. */
export async function dequeueLink(url) {
  const link = String(url ?? '').trim();
  return updateCatalog((cat) => {
    if (!Array.isArray(cat.queue)) cat.queue = [];
    const before = cat.queue.length;
    cat.queue = cat.queue.filter((q) => !sameLink(q.url, link));
    return { removed: before - cat.queue.length };
  });
}

/**
 * Annota un fallimento **di risoluzione** su un link in coda: il link resta,
 * con il suo motivo e il conteggio dei tentativi. È la differenza fra "sparito"
 * e "fallito": sul secondo si può riprovare.
 */
export async function markLinkFailed(url, message) {
  const link = String(url ?? '').trim();
  return updateCatalog((cat) => {
    if (!Array.isArray(cat.queue)) cat.queue = [];
    const entry = cat.queue.find((q) => sameLink(q.url, link));
    if (!entry) return { marked: false };
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.error = { message, occurredAt: new Date().toISOString() };
    return { marked: true };
  });
}

/** Svuota la coda dai soli link falliti (quelli in attesa restano). */
export async function clearFailedLinks() {
  return updateCatalog((cat) => {
    if (!Array.isArray(cat.queue)) cat.queue = [];
    const before = cat.queue.length;
    cat.queue = cat.queue.filter((q) => !q.error);
    return { removed: before - cat.queue.length };
  });
}
