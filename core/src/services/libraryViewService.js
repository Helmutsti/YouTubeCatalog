// M86 — le viste della libreria come le vedeva la CLI Rust. Traduzione della
// parte di lettura di `ondo-core/src/lib.rs` (`Filter`, `list`, `count`,
// `authors`, `by_author`, `missing_files`, `retry`) e di `ondo-core/src/search.rs`.
//
// Sono filtri su campi già presenti: nessun elenco separato da tenere allineato.
// La corrispondenza fra i `Filter` di Rust e gli assi ortogonali di questo core
// (M25: presence/download/hidden + favorite) è **tutta qui**, in un posto solo,
// così CLI e web non se la reimplementano ognuna a modo suo.

import { existsSync } from 'node:fs';

import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import { videoFilePath } from './playbackService.js';

/** Dove è arrivato un video nel suo percorso verso il disco (`State` in Rust). */
export const STATE = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed'
});

const STATE_LABEL = Object.freeze({
  [STATE.PENDING]: 'da scaricare',
  [STATE.DOWNLOADING]: 'in corso',
  [STATE.DOWNLOADED]: 'scaricato',
  [STATE.FAILED]: 'fallito'
});

export function stateLabel(state) {
  return STATE_LABEL[state] ?? state;
}

export const FILTER = Object.freeze({
  /** Tutto tranne gli archiviati: archiviare serve appunto a togliere di mezzo. */
  ALL: 'all',
  DOWNLOADED: 'downloaded',
  /** Risolti ma non ancora sul disco. */
  PENDING: 'pending',
  FAILED: 'failed',
  FAVORITES: 'favorites',
  ARCHIVED: 'archived',
  REMOVED: 'removed'
});

const FILTER_LABEL = Object.freeze({
  [FILTER.ALL]: 'tutti i video',
  [FILTER.DOWNLOADED]: 'scaricati',
  [FILTER.PENDING]: 'da scaricare',
  [FILTER.FAILED]: 'falliti',
  [FILTER.FAVORITES]: 'preferiti',
  [FILTER.ARCHIVED]: 'archiviati',
  [FILTER.REMOVED]: 'rimossi da YouTube'
});

export function filterLabel(filter) {
  return FILTER_LABEL[filter] ?? filter;
}

// `download` (questo core) → `State` (Rust). L'asse è lo stesso, cambiano i nomi:
// "none" là era "pending", cioè deciso e non ancora sul disco.
function stateOf(video) {
  switch (video.download) {
    case DOWNLOAD_STATE.DOWNLOADING:
      return STATE.DOWNLOADING;
    case DOWNLOAD_STATE.DOWNLOADED:
      return STATE.DOWNLOADED;
    case DOWNLOAD_STATE.FAILED:
      return STATE.FAILED;
    default:
      return STATE.PENDING;
  }
}

/**
 * Se un video (già tradotto da `libraryVideo`) appartiene a una vista. È
 * l'unica forma su cui i filtri lavorano: tenere la stessa regola su due forme
 * diverse sarebbe il modo sicuro di farle divergere.
 */
export function matchesFilter(v, filter) {
  switch (filter) {
    case FILTER.ALL:
      return !v.archived;
    case FILTER.DOWNLOADED:
      return v.state === STATE.DOWNLOADED && !v.archived;
    case FILTER.PENDING:
      return v.state === STATE.PENDING || v.state === STATE.DOWNLOADING;
    case FILTER.FAILED:
      return v.state === STATE.FAILED;
    case FILTER.FAVORITES:
      return v.favorite;
    case FILTER.ARCHIVED:
      return v.archived;
    case FILTER.REMOVED:
      return v.removed;
    default:
      return false;
  }
}

/** Durata in `h:mm:ss` (o `m:ss`), per chi deve solo mostrarla. */
export function durationLabel(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '–';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function errorMessage(error) {
  if (!error) return null;
  return typeof error === 'string' ? error : (error.message ?? null);
}

/**
 * Un video del catalogo nella forma che la CLI si aspetta (il `Video` di
 * `model.rs`). Un solo punto di traduzione: i moduli tradotti dal Rust leggono
 * questi campi e restano riga per riga confrontabili con l'originale.
 */
export function libraryVideo(video) {
  return {
    id: video.id,
    title: video.title || video.id,
    author: video.channel?.name || 'Sconosciuto',
    authorId: video.channel?.id ?? null,
    url: video.webpageUrl || '',
    extractor: video.extractor || '',
    description: video.description || '',
    durationSeconds: video.durationSeconds ?? null,
    uploadDate: video.uploadDate ?? null,
    tags: Array.isArray(video.tags) ? video.tags : [],
    width: video.resolution?.width ?? null,
    height: video.resolution?.height ?? null,
    fps: video.resolution?.fps ?? null,
    file: video.video?.localPath ?? '',
    sizeBytes: video.video?.sizeBytes ?? 0,
    addedAt: video.addedAt ?? null,
    state: stateOf(video),
    error: errorMessage(video.error),
    attempts: video.attempts ?? 0,
    favorite: !!video.favorite,
    archived: !!video.hidden,
    removed: video.presence === PRESENCE.REMOVED
  };
}

// Ordinamento di `Library::list`: dall'ultimo pubblicato; chi non ha una data di
// pubblicazione va **in fondo**, ordinato per data di ingresso.
function byRecency(a, b) {
  if (a.uploadDate && b.uploadDate) {
    if (a.uploadDate !== b.uploadDate) return b.uploadDate.localeCompare(a.uploadDate);
  } else if (a.uploadDate && !b.uploadDate) {
    return -1;
  } else if (!a.uploadDate && b.uploadDate) {
    return 1;
  }
  const addedA = a.addedAt ?? '';
  const addedB = b.addedAt ?? '';
  if (addedA !== addedB) return addedB.localeCompare(addedA);
  return (a.title ?? '').localeCompare(b.title ?? '');
}

/** Tutti i video, già tradotti: la fotografia su cui la CLI disegna una schermata. */
export async function libraryVideos() {
  const catalog = await readCatalog();
  return Object.values(catalog.videos).map(libraryVideo);
}

export function listByFilter(videos, filter) {
  return videos.filter((v) => matchesFilter(v, filter)).sort(byRecency);
}

export function countByFilter(videos, filter) {
  return videos.reduce((n, v) => n + (matchesFilter(v, filter) ? 1 : 0), 0);
}

/** Gli autori presenti, con quanti video ciascuno, in ordine alfabetico. */
export function authors(videos) {
  const counts = new Map();
  for (const v of videos) {
    if (v.archived) continue;
    counts.set(v.author, (counts.get(v.author) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => a.author.localeCompare(b.author));
}

/** I video di un autore, dall'ultimo pubblicato. */
export function byAuthor(videos, author) {
  return videos.filter((v) => v.author === author && !v.archived).sort(byRecency);
}

/** Gli id dati per scaricati il cui file è sparito dal disco. */
export async function missingFiles() {
  const catalog = await readCatalog();
  return Object.values(catalog.videos)
    .filter((v) => v.download === DOWNLOAD_STATE.DOWNLOADED)
    .filter((v) => {
      const file = videoFilePath(v);
      return !file || !existsSync(file);
    })
    .map((v) => v.id);
}

/**
 * Rimette in coda un video fallito (o uno il cui file è sparito). Ritorna
 * l'URL da dare al pool, oppure `null` se quell'id non c'è.
 */
export async function retryVideo(id) {
  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) return null;
    // Un `downloaded` non si tocca: rimetterlo a "none" perderebbe il fatto che
    // il file c'è. Per gli altri stati questo è il ritorno in coda.
    if (video.download !== DOWNLOAD_STATE.DOWNLOADED) {
      video.download = DOWNLOAD_STATE.NONE;
      video.error = null;
      video.updatedAt = new Date().toISOString();
    }
    return video.webpageUrl ?? '';
  });
}

// ── Ricerca ───────────────────────────────────────────────────────────────────
//
// Traduzione di `ondo-core/src/search.rs`: deliberatamente semplice e
// prevedibile. Semantica **AND** (ogni parola deve trovarsi da qualche parte) e
// sottostringa esatta, **senza** tolleranza agli errori di battitura: era la
// parte che, su descrizioni lunghe, restituiva risultati quasi casuali. La
// `searchVideos` fuzzy resta e la usa la web app: sono due ricerche diverse di
// proposito, non una che ha sostituito l'altra.

const TITLE = 8;
const AUTHOR = 5;
const TAG = 3;
const DESCRIPTION = 1;

export function searchTerms(query) {
  return String(query ?? '')
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** `null` se anche una sola parola non trova posto. */
export function searchScore(view, terms) {
  if (terms.length === 0) return null;
  const title = (view.title ?? '').toLowerCase();
  const author = (view.author ?? '').toLowerCase();
  const tags = (view.tags ?? []).map((t) => String(t).toLowerCase());
  const description = (view.description ?? '').toLowerCase();

  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (title.includes(term)) best = Math.max(best, TITLE);
    if (author.includes(term)) best = Math.max(best, AUTHOR);
    if (tags.some((t) => t.includes(term))) best = Math.max(best, TAG);
    if (description.includes(term)) best = Math.max(best, DESCRIPTION);
    if (best === 0) return null;
    total += best;
  }
  // Un titolo che comincia con la query è quasi sempre quello cercato.
  if (title.startsWith(terms.join(' '))) total += TITLE;
  return total;
}

/**
 * I video che rispondono alla query, dal più pertinente. Cerca in tutta la
 * libreria, archiviati compresi: si cerca proprio quando non si sa dov'è.
 */
export function searchLibrary(videos, query) {
  const terms = searchTerms(query);
  return videos
    .map((v) => ({ score: searchScore(v, terms), v }))
    .filter((hit) => hit.score !== null)
    .sort((a, b) => b.score - a.score || a.v.title.localeCompare(b.v.title))
    .map((hit) => hit.v);
}
