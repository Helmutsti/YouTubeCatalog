// Client sottile su ondo-api: una funzione per endpoint, nessuna logica
// applicativa — solo fetch e propagazione dell'errore.
//
// I nomi delle funzioni sono rimasti quelli dell'API Express: le pagine non
// dovevano cambiare per un rinominamento. Quello che è cambiato è dietro (percorsi
// e corpi), e le funzioni che non hanno più un endpoint sotto **non ci sono**:
// meglio un errore di importazione a build-time che una schermata che chiama il
// vuoto. L'elenco completo di cosa è sparito e perché sta in ../../../DIFFERENZE.md.
import { apiUrl, resolveMediaUrls } from '../lib/apiBase.js';

async function request(path, options) {
  const res = await fetch(apiUrl(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Richiesta fallita (${res.status})`);
  }
  // Riscrive i path /media/... assoluti verso API_BASE_URL quando impostato
  // (default: nessun cambiamento, vedi lib/apiBase.js).
  return resolveMediaUrls(body);
}

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

// ── Lettura ────────────────────────────────────────────────────────────────

// L'API risponde { videos: [...] }; le pagine vogliono l'elenco, come prima.
export const listVideos = (filter) => request(`/api/videos${qs({ filter })}`).then((r) => r.videos);
export const getVideo = (id) => request(`/api/videos/${encodeURIComponent(id)}`);
export const searchVideos = (q) => request(`/api/search${qs({ q })}`).then((r) => r.videos);

// Il core parla di **autori**, non di canali: un video può venire da un sito
// qualunque. `key` resta il nome dell'autore, e l'endpoint accetta anche il suo id.
export const listChannels = () =>
  request('/api/authors').then((r) => r.authors.map((a) => ({ ...a, key: a.name, avatarUrl: null })));
export const listVideosByChannel = (key) =>
  request(`/api/authors/${encodeURIComponent(key)}/videos`).then((r) => r.videos);

// I job sono quelli di questa sessione: il pool non tiene uno storico su disco.
export const listJobs = () => request('/api/jobs');
export const getStats = () => request('/api/stats');

// I link incollati che non hanno ancora un id (prima non erano rappresentabili).
export const listQueue = () => request('/api/queue').then((r) => r.queue);

// ── Scrittura ──────────────────────────────────────────────────────────────

// Nel core il flag si chiama `archived`; il frontend lo chiama ancora "hidden".
export const setHidden = (id, hidden) =>
  request(`/api/videos/${encodeURIComponent(id)}/archived`, {
    method: 'POST',
    body: JSON.stringify({ value: hidden })
  });

export const setFavorite = (id, favorite) =>
  request(`/api/videos/${encodeURIComponent(id)}/favorite`, {
    method: 'POST',
    body: JSON.stringify({ value: favorite })
  });

// Un endpoint invece di due: `deleteFiles` decide se portarsi via anche il file.
export const deleteVideo = (id, deleteFiles = true) =>
  request(`/api/videos/${encodeURIComponent(id)}${qs({ deleteFiles })}`, { method: 'DELETE' });

// Un link nuovo: entra in coda e parte subito. `maxHeight` è il tetto di
// risoluzione per **questo** download (null = la migliore disponibile).
export const downloadSingle = (url, { maxHeight } = {}) =>
  request('/api/queue', { method: 'POST', body: JSON.stringify({ url, maxHeight }) });

// Rimette in coda un video già in libreria (fallito, o da riscaricare).
export const downloadVideoById = (id, { maxHeight } = {}) =>
  request(`/api/videos/${encodeURIComponent(id)}/download${qs({ maxHeight })}`, { method: 'POST' });

export const removeFromQueue = (url) =>
  request('/api/queue', { method: 'DELETE', body: JSON.stringify({ url }) });

// ── Impostazioni ───────────────────────────────────────────────────────────

export const getConfig = () => request('/api/config');
// Un endpoint per tutto: `quality` ('best' | 'ask' | numero), `parallel`, `vlc`,
// `cookies` (un **percorso**; stringa vuota = dimentica).
export const patchConfig = (partial) =>
  request('/api/config', { method: 'PATCH', body: JSON.stringify(partial) });
