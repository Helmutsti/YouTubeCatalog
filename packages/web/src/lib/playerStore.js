import { useEffect, useState } from 'react';

// Store del player globale (M54): sostiene il mini-player persistente "alla
// YouTube". Vive interamente in questo strato client — mai in
// core/schema/catalog.json — esattamente come lib/queueStore.js.
//
// Nodo architetturale della milestone: esiste UN SOLO elemento <video> nella
// GUI (montato da components/MiniPlayer.jsx, sopra il router). Questo store è
// il ponte fra quel <video> e le pagine che lo comandano (VideoDetailPage per
// lo speed/PiP/autoplay; la coda M52 per la prosecuzione a fine video).
//
// Stato appeso a `globalThis` (non una `let` di modulo): un singleton in scope
// di modulo si duplica sotto Vite HMR quando questo file — o chi lo importa —
// viene ricaricato a caldo, disallineando chi scrive da chi legge (stesso
// motivo di queueStore.js/toast.js).
//
// Cosa persiste e cosa no:
// - `enabled` (preferenza on/off del mini-player) → localStorage, sopravvive a
//   refresh e chiusura scheda (è una preferenza utente, default ON).
// - `current`/`playing`/`started` → solo in memoria: lo stato di riproduzione
//   non ha senso persistito (un refresh ricarica comunque la pagina daccapo).
const ENABLED_KEY = 'ondo:miniPlayerEnabled';
// Preferenza client gemella di `enabled` (M60): avvio automatico della
// riproduzione all'apertura manuale di un video scaricato. Solo localStorage,
// default ON. Non tocca l'avanzamento della coda (che resta indipendente).
const AUTOPLAY_ON_OPEN_KEY = 'ondo:autoplayOnOpen';

function loadEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    // Default ON: assente = attivo (scelta di scope M54).
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function loadAutoplayOnOpen() {
  try {
    const raw = localStorage.getItem(AUTOPLAY_ON_OPEN_KEY);
    // Default ON: assente = attivo (scelta di scope M60).
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

const STATE = (globalThis.__ondoPlayerState ??= {
  current: null,       // { id, videoUrl, title, thumbnailUrl, channelName, durationSeconds }
  playing: false,
  started: false,      // il video corrente è mai stato avviato (per la copertina "clicca per riprodurre")
  detached: false,     // il player è "staccato" nel riquadro flottante (persiste anche in pausa)
  minimized: false,    // "minimizza" manuale: forza il flottante ANCHE sulla pagina del video (senza cambiare route)
  enabled: loadEnabled(),
  autoplayOnOpen: loadAutoplayOnOpen(),
  videoEl: null,       // il vero <video>, registrato da MiniPlayer (non reattivo)
  pendingPlay: null,   // id di cui MiniPlayer deve avviare il play appena l'elemento è pronto
  listeners: new Set()
});

function notify() {
  STATE.listeners.forEach((fn) => fn());
}

// Voce minimale (non l'intero oggetto video): solo i campi usati dal player e
// dal riquadro flottante.
function toCurrent(video) {
  return {
    id: video.id,
    videoUrl: video.videoUrl ?? null,
    title: video.title ?? video.id,
    thumbnailUrl: video.thumbnailUrl ?? null,
    channelName: video.channel?.name ?? null,
    durationSeconds: video.durationSeconds ?? null
  };
}

// Imposta il video corrente del player globale. Se è lo stesso id già
// corrente non azzera started/playing (evita di far ricomparire la copertina o
// di interrompere la riproduzione quando la pagina di dettaglio si ri-renderizza
// e richiama setCurrent con gli stessi dati). `play: true` chiede a MiniPlayer
// di avviare la riproduzione appena l'elemento <video> è pronto (autoplay coda
// + arrivo su una pagina con state.autoplay).
export function setCurrent(video, { play = false } = {}) {
  const next = toCurrent(video);
  const sameId = STATE.current?.id === next.id;
  STATE.current = next;
  if (!sameId) {
    STATE.started = false;
    STATE.playing = false;
  }
  if (play) STATE.pendingPlay = next.id;
  notify();
}

// Chiude il player: ferma la riproduzione (l'unmount del <video> interrompe
// comunque l'audio) e azzera il corrente → il mini-player sparisce.
export function clear() {
  STATE.current = null;
  STATE.playing = false;
  STATE.started = false;
  STATE.detached = false;
  STATE.minimized = false;
  STATE.pendingPlay = null;
  notify();
}

// "Staccato" nel riquadro flottante: deciso quando si lascia la pagina del
// video mentre è in riproduzione, poi persiste (anche mettendo in pausa) finché
// non si chiude col tasto X o si torna alla pagina del video.
export function setDetached(v) {
  if (STATE.detached === v) return;
  STATE.detached = v;
  notify();
}

// "Minimizza" manuale: contrae il player nel riquadro flottante restando sulla
// pagina corrente (nessuna navigazione). A differenza di `detached`, forza il
// flottante anche quando si è sulla pagina del video (scavalca l'aggancio).
export function setMinimized(v) {
  if (STATE.minimized === v) return;
  STATE.minimized = v;
  notify();
}

export function setPlaying(v) {
  if (STATE.playing === v) return;
  STATE.playing = v;
  notify();
}

export function setStarted(v) {
  if (STATE.started === v) return;
  STATE.started = v;
  notify();
}

// Registrazione del vero <video> (callback ref di MiniPlayer). Non reattivo:
// chi lo usa (speed/PiP in VideoDetailPage) lo legge al momento del click.
export function setVideoEl(el) {
  STATE.videoEl = el;
}
export function getVideoEl() {
  return STATE.videoEl;
}

// Consuma la richiesta di autoplay per `id` (true una sola volta). MiniPlayer
// la chiama quando l'elemento con quel src è montato, per far partire il play.
export function consumePendingPlay(id) {
  if (STATE.pendingPlay !== id) return false;
  STATE.pendingPlay = null;
  return true;
}

// Intento di autoplay ancora pendente per `id`? (sola lettura, non consuma).
// Usato da MiniPlayer per (ri)tentare il play quando l'elemento <video> è
// pronto — l'intento resta finché la riproduzione non parte davvero (onPlay lo
// consuma), così sopravvive al remount dell'elemento durante l'avanzamento di
// coda (M60-fix).
export function getPendingPlay() {
  return STATE.pendingPlay;
}

export function getPlayerState() {
  return STATE;
}

export function isMiniPlayerEnabled() {
  return STATE.enabled;
}

export function setMiniPlayerEnabled(v) {
  STATE.enabled = !!v;
  try {
    localStorage.setItem(ENABLED_KEY, String(STATE.enabled));
  } catch {
    // localStorage non disponibile (es. modalità privata): la preferenza resta
    // valida per la durata della scheda.
  }
  notify();
}

// Preferenza client "autoplay all'apertura" (M60), gemella di quella del
// mini-player: stessa forma (STATE + localStorage), stesso pattern di hook.
export function isAutoplayOnOpenEnabled() {
  return STATE.autoplayOnOpen;
}

export function setAutoplayOnOpen(v) {
  STATE.autoplayOnOpen = !!v;
  try {
    localStorage.setItem(AUTOPLAY_ON_OPEN_KEY, String(STATE.autoplayOnOpen));
  } catch {
    // localStorage non disponibile (es. modalità privata): la preferenza resta
    // valida per la durata della scheda.
  }
  notify();
}

// Hook per lo stato di riproduzione (current/playing/started). Un solo hook che
// espone tutto: le transizioni sono poche e il ricalcolo è banale.
export function usePlayer() {
  const [snap, setSnap] = useState(() => ({ current: STATE.current, playing: STATE.playing, started: STATE.started, detached: STATE.detached, minimized: STATE.minimized }));
  useEffect(() => {
    const listener = () => setSnap({ current: STATE.current, playing: STATE.playing, started: STATE.started, detached: STATE.detached, minimized: STATE.minimized });
    STATE.listeners.add(listener);
    listener();
    return () => STATE.listeners.delete(listener);
  }, []);
  return snap;
}

export function useMiniPlayerEnabled() {
  const [enabled, setEnabled] = useState(STATE.enabled);
  useEffect(() => {
    const listener = () => setEnabled(STATE.enabled);
    STATE.listeners.add(listener);
    listener();
    return () => STATE.listeners.delete(listener);
  }, []);
  return enabled;
}

export function useAutoplayOnOpen() {
  const [enabled, setEnabled] = useState(STATE.autoplayOnOpen);
  useEffect(() => {
    const listener = () => setEnabled(STATE.autoplayOnOpen);
    STATE.listeners.add(listener);
    listener();
    return () => STATE.listeners.delete(listener);
  }, []);
  return enabled;
}
