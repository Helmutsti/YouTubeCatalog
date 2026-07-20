import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Download, Archive, RotateCcw } from 'lucide-react';
import { searchVideos, decideVideo } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { reviewActionsFor } from '../lib/reviewActions.js';
import { formatDuration } from '../lib/format.js';

const ICONS = { download: Download, exclude: Archive, undecided: RotateCcw };

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => setInput(q), [q]);

  // Ricerca fuzzy multi-campo (M7): stesso motore usato dal CLI, filtro dal
  // vivo con un piccolo debounce invece del prompt `search` a frecce.
  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    let cancelled = false;
    searchVideos(trimmed)
      .then((r) => !cancelled && setResults(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [q]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (input.trim() !== q) setParams(input.trim() ? { q: input.trim() } : {});
    }, 300);
    return () => clearTimeout(timeout);
  }, [input]);

  async function handleDecide(id, decision) {
    try {
      await decideVideo(id, decision);
      const r = await searchVideos(q.trim());
      setResults(r);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Cerca</h1></div>
      <div className="search-box" style={{ maxWidth: 560, margin: '0 0 20px' }}>
        <Search size={16} />
        <input
          autoFocus
          placeholder="Titolo, canale, tag, descrizione…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      {error && <div className="notice error">{error}</div>}
      {!q.trim() ? (
        <div className="empty-state">Scrivi qualcosa per cercare nel catalogo.</div>
      ) : results === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : results.length === 0 ? (
        <div className="empty-state">Nessun risultato per "{q}".</div>
      ) : (
        <div className="list">
          {results.map((v) => {
            const actions = reviewActionsFor(v.status);
            return (
              <div key={v.id} className="list-row">
                <Link to={`/videos/${v.id}`} className="res-thumb">
                  {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" />}
                  {formatDuration(v.durationSeconds) && <div className="dur">{formatDuration(v.durationSeconds)}</div>}
                </Link>
                <Link to={`/videos/${v.id}`} style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{v.title ?? v.id}</div>
                  <div className="card-meta" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusBadge status={v.status} inline />
                    {v.channel?.name ?? 'Canale sconosciuto'}
                  </div>
                </Link>
                {actions.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                    {actions.map((a) => {
                      const Icon = ICONS[a.decision] ?? Download;
                      return (
                        <button key={a.decision} className="btn small" title={a.label} onClick={() => handleDecide(v.id, a.decision)}>
                          <Icon size={13} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
