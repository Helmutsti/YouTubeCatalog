import { useEffect, useState } from 'react';

// Collega videoId -> jobId del download in corso, così VideoCard (che
// conosce solo il video, non il job che l'ha avviato) può agganciarsi allo
// stream SSE di progresso reale (useJobStream) senza che ogni pagina debba
// propagarlo esplicitamente. Store a singleton su `globalThis`, stesso
// motivo di lib/toast.js: sopravvive all'HMR di Vite (un modulo ricaricato a
// caldo si duplicherebbe altrimenti, disallineando chi scrive da chi legge).
//
// Popolato da downloadActions.startDownload (l'unico punto che avvia
// downloadSingle dalle griglie di VideoCard) subito dopo aver ottenuto il
// jobId, e rimosso a fine job. Se un video risulta 'downloading' senza una
// entry qui (pagina ricaricata a metà download, o avviato da altrove), il
// chiamante non ha un jobId da seguire e ricade su un'animazione indeterminata.
const STATE = (globalThis.__ondoDownloadTrackerState ??= { jobIds: new Map(), listeners: new Map() });

function notify(videoId) {
  STATE.listeners.get(videoId)?.forEach((fn) => fn());
}

export function trackVideoDownload(videoId, jobId) {
  STATE.jobIds.set(videoId, jobId);
  notify(videoId);
}

export function untrackVideoDownload(videoId) {
  STATE.jobIds.delete(videoId);
  notify(videoId);
}

export function useActiveDownloadJobId(videoId) {
  const [jobId, setJobId] = useState(() => STATE.jobIds.get(videoId) ?? null);

  useEffect(() => {
    setJobId(STATE.jobIds.get(videoId) ?? null);
    const listener = () => setJobId(STATE.jobIds.get(videoId) ?? null);
    if (!STATE.listeners.has(videoId)) STATE.listeners.set(videoId, new Set());
    STATE.listeners.get(videoId).add(listener);
    return () => {
      const set = STATE.listeners.get(videoId);
      set?.delete(listener);
      if (set && set.size === 0) STATE.listeners.delete(videoId);
    };
  }, [videoId]);

  return jobId;
}
