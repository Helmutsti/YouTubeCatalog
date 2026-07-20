import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { downloadSingle } from '../api/client.js';
import { STATUS_LABEL } from '../lib/status.js';

// Equivalente di "Scarica video singolo" nel CLI: un link incollato, scaricato
// subito senza passare da una fonte/sync di playlist. Qualunque sito
// supportato da yt-dlp (YouTube, Rumble, ecc.), non solo YouTube.
export function SingleDownloadPage() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await downloadSingle(url.trim());
      if (r.action === 'download') {
        navigate(`/jobs?highlight=${r.jobId}`);
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
            <>"{result.title}" è già in download. <Link to="/jobs">Vai ai job</Link></>
          )}
          {result.action === 'already-tracked' && (
            <>
              "{result.title}" è già tracciato tramite una fonte esistente (stato: {STATUS_LABEL[result.status] ?? result.status}).{' '}
              <Link to={`/videos/${result.videoId}`}>Rivedilo qui</Link>
            </>
          )}
        </div>
      )}
    </>
  );
}
