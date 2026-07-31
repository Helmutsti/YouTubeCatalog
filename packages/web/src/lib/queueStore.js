import { useEffect, useState } from 'react';

// Coda di riproduzione effimera "alla Spotify/YouTube" (M52): creata
// istantaneamente al primo "Aggiungi alla coda", interamente in questo strato
// esterno — mai in core/schema/catalog.json (vedi PIANO.md M52: niente
// playlist nominate/persistenti, nessuna sync multi-dispositivo).
//
// Stato appeso a `globalThis` (non una `let` di modulo), stesso motivo di
// lib/toast.js e lib/downloadTracker.js: un modulo con stato singleton in
// scope proprio si duplica sotto Vite HMR quando questo file (o chi lo
// importa) viene ricaricato a caldo, disallineando chi scrive da chi legge.
//
// Backed da `sessionStorage`: sopravvive a un refresh nella stessa scheda,
// sparisce chiudendola — nessuna persistenza server-side, per scelta esplicita
// del piano (non è un dato di dominio, non deve mai finire in catalog.json).
const STORAGE_KEY = 'ondo:playbackQueue';

function loadInitial() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const STATE = (globalThis.__ondoQueueState ??= { items: loadInitial(), listeners: new Set() });

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.items));
  } catch {
    // sessionStorage non disponibile (es. modalità privata): la coda resta
    // comunque funzionante in memoria per la durata della scheda.
  }
}

function notify() {
  STATE.listeners.forEach((fn) => fn());
}

// Voce minimale (non l'intero oggetto video): solo i campi usati dal box
// coda/autoplay. Evita di congelare in sessionStorage dati che potrebbero
// invecchiare (es. thumbnail) — se lo stato del video cambia altrove nel
// frattempo, l'apertura della pagina di dettaglio lo scoprirà comunque.
function toQueueItem(video) {
  return {
    id: video.id,
    title: video.title ?? video.id,
    thumbnailUrl: video.thumbnailUrl ?? null,
    durationSeconds: video.durationSeconds ?? null,
    channelName: video.channel?.name ?? null
  };
}

export function addToQueue(video) {
  if (STATE.items.some((v) => v.id === video.id)) return false;
  STATE.items = [...STATE.items, toQueueItem(video)];
  persist();
  notify();
  return true;
}

export function removeFromQueue(id) {
  STATE.items = STATE.items.filter((v) => v.id !== id);
  persist();
  notify();
}

export function clearQueue() {
  STATE.items = [];
  persist();
  notify();
}

// Avanzamento NON distruttivo (M62): ritorna il video successivo a `id` nella
// coda SENZA rimuovere nulla, così i video già visti vi restano (rovescia la
// meccanica "consuma-e-scarta" di M52). Regole:
//  - coda vuota → null;
//  - `id` è nella coda → l'elemento dopo di esso (o null se è l'ultimo);
//  - `id` non è in coda (o è null) → il primo elemento.
// Non ritorna mai un elemento con lo stesso `id` di partenza (nessun replay).
export function getNextAfter(id) {
  const items = STATE.items;
  if (items.length === 0) return null;
  const idx = id ? items.findIndex((v) => v.id === id) : -1;
  if (idx === -1) return items[0];
  return items[idx + 1] ?? null;
}

export function isQueued(id) {
  return STATE.items.some((v) => v.id === id);
}

export function getQueue() {
  return STATE.items;
}

// Coda tipicamente piccola (pochi video): un solo hook che espone l'intero
// array, senza il livello di indirection per-id di useActiveDownloadJobId
// (lì serviva per non ri-renderizzare ogni card ad ogni cambio di un job
// qualunque; qui il costo di ricalcolare "è in coda?" su pochi elementi è
// trascurabile).
export function useQueue() {
  const [items, setItems] = useState(STATE.items);
  useEffect(() => {
    const listener = () => setItems(STATE.items);
    STATE.listeners.add(listener);
    listener();
    return () => STATE.listeners.delete(listener);
  }, []);
  return items;
}
