import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { searchVideos, setHidden, setFavorite, deleteVideo, refreshMetadata, triggerJob } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { startDownload } from '../lib/downloadActions.js';
import { showToast } from '../lib/toast.js';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useTitle(q.trim() ? `Cerca: ${q.trim()}` : 'Cerca');

  // Ricerca fuzzy multi-campo (M7): stesso motore usato dal CLI. La query
  // arriva dall'URL (`?q=`), impostata dall'unica barra in topbar (punto 10).
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

  async function reSearch() {
    const r = await searchVideos(q.trim());
    setResults(r);
  }
  const { requestHide, modal } = useHideWithPrompt({ onDone: reSearch, onError: setError });

  // Copre tutte le azioni del menu ⋮ (M53), non più solo download/occhio: lo
  // stesso ventaglio di CatalogPage, qui instradato sui risultati di ricerca.
  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const title = (results ?? []).find((v) => v.id === id)?.title;
        await startDownload(id, { triggerJob, onSettled: reSearch, title });
        return;
      }
      if (kind === 'hide') {
        requestHide((results ?? []).find((v) => v.id === id));
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(id);
        await reSearch();
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(id, kind === 'favorite');
        await reSearch();
        return;
      }
      if (kind === 'deletevideo') {
        await deleteVideo(id);
        showToast('Video cancellato definitivamente.', 'success');
        await reSearch();
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
      {error && <div className="notice error">{error}</div>}
      {!q.trim() ? (
        <div className="empty-state">Scrivi qualcosa per cercare nel catalogo.</div>
      ) : results === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : results.length === 0 ? (
        <div className="empty-state">Nessun risultato per "{q}".</div>
      ) : (
        <div className="list">
          {results.map((v) => (
            <VideoCard key={v.id} video={v} layout="row" onDecide={handleAction} />
          ))}
        </div>
      )}
      {modal}
    </>
  );
}
