import { useEffect, useState } from 'react';

// Bridge lato client sullo stream SSE di /api/jobs/:id/stream. Chiude
// esplicitamente la EventSource a fine job (success/failed): il server
// termina la risposta da sé a quel punto, ma senza un close() esplicito
// EventSource ritenterebbe la connessione all'infinito, rigiocando ogni
// volta lo storico già ricevuto.
export function useJobStream(jobId) {
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    setStatus(null);
    setLogLines([]);
    setProgress(null);
    if (!jobId) return undefined;

    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);

    source.addEventListener('log', (e) => {
      setLogLines((prev) => [...prev, JSON.parse(e.data)]);
    });
    source.addEventListener('progress', (e) => {
      setProgress(JSON.parse(e.data));
    });
    source.addEventListener('status', (e) => {
      const value = JSON.parse(e.data);
      setStatus(value);
      if (value === 'success' || value === 'failed') {
        source.close();
      }
    });

    return () => source.close();
  }, [jobId]);

  return { status, logLines, progress };
}
