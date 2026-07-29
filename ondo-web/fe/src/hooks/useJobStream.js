import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/apiBase.js';

// Bridge lato client su /api/events.
//
// Prima c'era uno stream per job (`/api/jobs/:id/stream`) con eventi tipizzati
// (`log`, `progress`, `status`). Adesso il server ha **un solo** flusso con gli
// eventi di tutti i download, ognuno etichettato col numero del job: sono gli stessi
// che la console della CLI disegna. Quindi qui si apre una sola EventSource, e si
// filtra per job.
//
// Non si chiude a fine job: il flusso è condiviso e continua a vivere: se ne
// occupa il cleanup di React quando il componente sparisce.
export function useJobStream(jobId) {
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [progress, setProgress] = useState(null);
  const [phase, setPhase] = useState(null);

  useEffect(() => {
    setStatus(null);
    setLogLines([]);
    setProgress(null);
    setPhase(null);
    if (jobId === null || jobId === undefined) return undefined;

    const source = new EventSource(apiUrl('/api/events'));
    const atteso = String(jobId);

    source.onmessage = (e) => {
      let update;
      try {
        update = JSON.parse(e.data);
      } catch {
        return;
      }
      if (String(update.job) !== atteso) return;

      const ev = update.event ?? {};
      switch (ev.event) {
        case 'log':
          setLogLines((prev) => [...prev, ev.line]);
          break;
        case 'progress':
          setProgress({ percent: ev.percent });
          break;
        case 'phase':
          setPhase(ev.phase);
          break;
        case 'done':
          setStatus('success');
          break;
        case 'error':
          setStatus('failed');
          setLogLines((prev) => [...prev, ev.message]);
          break;
        default:
          break;
      }
    };

    return () => source.close();
  }, [jobId]);

  return { status, logLines, progress, phase };
}
