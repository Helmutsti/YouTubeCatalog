import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Download, EyeOff, Eye } from 'lucide-react';
import { searchVideos, setHidden, triggerJob } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { actionsFor } from '../lib/reviewActions.js';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { formatDuration } from '../lib/format.js';

const ICONS = { download: Download, hide: EyeOff, unhide: Eye };

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

  async function reSearch() {
    const r = await searchVideos(q.trim());
    setResults(r);
  }
  const { requestHide, modal } = useHideWithPrompt({ onDone: reSearch, onError: setError });

  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        await triggerJob('downloadSingle', { videoId: id });
        await reSearch();
        return;
      }
      if (kind === 'hide') {
        requestHide((results ?? []).find((v) => v.id === id));
        return;
      }
      await setHidden(id, false); // unhide
      await reSearch();
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
          placeholder="Titolo, creator, tag, descrizione…"
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
            const actions = actionsFor(v);
            return (
              <div key={v.id} className="list-row">
                <Link to={`/videos/${v.id}`} className="res-thumb">
                  {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" />}
                  {formatDuration(v.durationSeconds) && <div className="dur">{formatDuration(v.durationSeconds)}</div>}
                </Link>
                <Link to={`/videos/${v.id}`} style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{v.title ?? v.id}</div>
                  <div className="card-meta" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusBadge video={v} inline />
                    {v.channel?.name ?? 'Creator sconosciuto'}
                  </div>
                </Link>
                {actions.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                    {actions.map((a) => {
                      const Icon = ICONS[a.kind] ?? Download;
                      return (
                        <button key={a.kind} className="btn small" title={a.label} onClick={() => handleAction(v.id, a.kind)}>
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
      {modal}
    </>
  );
}
