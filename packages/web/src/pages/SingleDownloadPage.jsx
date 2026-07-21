import { useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadSingle } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';
import { JobHistory } from '../components/JobHistory.jsx';

// Equivalente di "Scarica video singolo" nel CLI: un link incollato, scaricato
// subito senza passare da una fonte/sync di playlist. Qualunque sito
// supportato da yt-dlp (YouTube, Rumble, ecc.), non solo YouTube.
//
// L'utente resta sulla pagina dopo aver avviato un download (nessun redirect):
// l'input resta disponibile per accodare altri video, l'avanzamento del job
// attivo è mostrato con la sola barra di caricamento (niente box di log), e lo
// storico completo è sempre visibile sotto.
export function SingleDownloadPage() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const live = useJobStream(activeJobId);

  const downloading = !!activeJobId && live.status !== 'success' && live.status !== 'failed';

  async function handleSubmit(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await downloadSingle(url.trim());
      if (r.action === 'download') {
        setActiveJobId(r.jobId);
        setUrl(''); // l'input resta, pronto per il prossimo link da accodare
        return;
      }
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Scarica video singolo</h1></div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>URL (o id) del video</label>
          <input
            placeholder="https://www.youtube.com/watch?v=… oppure un id di 11 caratteri"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <div className="hint">Qualunque sito supportato da yt-dlp — non solo YouTube.</div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner"></span> : 'Scarica'}
        </button>
      </form>

      {error && <div className="notice error" style={{ marginTop: 16 }}>{error}</div>}

      {result && (
        <div className="notice" style={{ marginTop: 16 }}>
          {result.action === 'already-downloaded' && (
            <>"{result.title}" è già in archivio. <Link to={`/videos/${result.videoId}`}>Vai al video</Link></>
          )}
          {result.action === 'already-downloading' && (
            <>"{result.title}" è già in download.</>
          )}
          {result.action === 'already-present' && (
            <>"{result.title}" è già in libreria. <Link to={`/videos/${result.videoId}`}>Vai al video</Link></>
          )}
          {result.action === 'added' && (
            <>"{result.title}" aggiunto alla libreria. <Link to={`/videos/${result.videoId}`}>Vai al video</Link></>
          )}
        </div>
      )}

      {downloading && (
        <div className="progress-bar" style={{ marginTop: 20 }}>
          <div style={{ width: `${live.progress ?? 0}%` }}></div>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <JobHistory
          excludeId={downloading ? activeJobId : undefined}
          refreshKey={`${activeJobId ?? ''}:${live.status ?? ''}`}
        />
      </div>
    </>
  );
}
