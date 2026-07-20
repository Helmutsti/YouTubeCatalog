import { readCatalog } from '../catalog/catalogStore.js';

// Campi cercati fuzzy (tollerano piccoli errori di battitura) — restano brevi
// e specifici, quindi la corrispondenza a finestra scorrevole è economica e
// significativa. La descrizione, spesso lunga centinaia/migliaia di caratteri,
// è cercata solo per sottostringa esatta: una ricerca fuzzy su un testo così
// lungo troverebbe corrispondenze "sparse" quasi ovunque, senza reale senso.
const FUZZY_FIELDS = { title: 4, channel: 3, tags: 2 };
const EXACT_ONLY_FIELDS = { description: 1 };

function fieldText(video, field) {
  switch (field) {
    case 'title': return video.title ?? '';
    case 'channel': return video.channel?.name ?? '';
    case 'tags': return (video.tags ?? []).join(' ');
    case 'description': return video.description ?? '';
    default: return '';
  }
}

// Distanza di Levenshtein classica (iterativa, due righe invece di una matrice
// completa: sufficiente per stringhe corte come titoli/tag, nessuna dipendenza).
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function maxEditDistanceFor(wordLength) {
  if (wordLength <= 3) return 0; // parole molto corte: solo corrispondenza esatta, altrimenti troppo rumore
  if (wordLength <= 6) return 1;
  return 2;
}

// Cerca la miglior corrispondenza di "word" scorrendo finestre di testo di
// lunghezza vicina a quella della parola, invece di una sottosequenza libera
// su tutto il testo — più corretto semanticamente ("vicino per distanza di
// modifica a un tratto di testo", non "lettere sparse ovunque in ordine") e
// comunque economico per campi brevi come titolo/canale/tag.
function fuzzyWordScore(word, text) {
  if (!word || !text) return 0;
  if (text.includes(word)) return word.length * 3;

  const maxDist = maxEditDistanceFor(word.length);
  if (maxDist === 0) return 0;

  let best = Infinity;
  const minLen = Math.max(1, word.length - maxDist);
  const maxLen = word.length + maxDist;
  for (let len = minLen; len <= maxLen && best > 0; len++) {
    for (let start = 0; start + len <= text.length; start++) {
      const dist = editDistance(word, text.slice(start, start + len));
      if (dist < best) best = dist;
      if (best === 0) break;
    }
  }

  return best <= maxDist ? (word.length - best) * 2 : 0;
}

function exactWordScore(word, text) {
  return text.includes(word) ? word.length : 0;
}

// Ricerca multi-campo, senza dipendenze esterne: ogni parola della query deve
// trovare una corrispondenza da qualche parte (titolo/canale/tag fuzzy,
// descrizione per sottostringa esatta) — semantica AND tra le parole.
export async function searchVideos(query, { limit = 20 } = {}) {
  const words = (query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const catalog = await readCatalog();
  const scored = [];

  for (const video of Object.values(catalog.videos)) {
    let total = 0;
    for (const word of words) {
      let bestForWord = 0;
      for (const [field, weight] of Object.entries(FUZZY_FIELDS)) {
        const score = fuzzyWordScore(word, fieldText(video, field).toLowerCase()) * weight;
        if (score > bestForWord) bestForWord = score;
      }
      for (const [field, weight] of Object.entries(EXACT_ONLY_FIELDS)) {
        const score = exactWordScore(word, fieldText(video, field).toLowerCase()) * weight;
        if (score > bestForWord) bestForWord = score;
      }
      if (bestForWord === 0) {
        total = 0;
        break; // questa parola non trova match in nessun campo: il video non è un risultato
      }
      total += bestForWord;
    }
    if (total > 0) scored.push({ video, score: total });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => r.video);
}
