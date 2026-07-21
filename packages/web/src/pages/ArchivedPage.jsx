import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listVideos, setHidden, triggerJob, refreshMetadata, deleteVideoFile } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { channelKey } from '../lib/format.js';

// Pagina "Archiviati" (ex Libreria): mostra SOLO i video archiviati/nascosti,
// con le copertine in bianco e nero. Da qui si ripristinano (menu ⋮ →
// Ripristina), si scaricano o si va al profilo del creator.
export function ArchivedPage() {
  const [videos, setVideos] = useState(null);
  const [creator, setCreator] = useState('');
  const [sort, setSort] = useState('addedAt');
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const { requestHide, modal } = useHideWithPrompt({ onDone: reload, onError: setError });
  useTitle('Archiviati');

  function reload() {
    listVideos().then(setVideos).catch((e) => setError(e.message));
  }
  useEffect(reload, []);

  const archived = useMemo(() => (videos ?? []).filter((v) => v.hidden), [videos]);

  const channelOptions = useMemo(() => {
    const byKey = new Map();
    for (const v of archived) {
      const key = channelKey(v);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, v.channel?.name ?? key);
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it', { sensitivity: 'base' }));
  }, [archived]);

  const filtered = useMemo(() => {
    let list = archived;
    if (creator) list = list.filter((v) => channelKey(v) === creator);
    return sortVideos(list, sort);
  }, [archived, creator, sort]);

  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const { jobId } = await triggerJob('downloadSingle', { videoId: id });
        navigate(`/jobs?highlight=${jobId}`);
        return;
      }
      if (kind === 'hide') {
        requestHide(archived.find((v) => v.id === id));
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(id);
        reload();
        return;
      }
      if (kind === 'deletefile') {
        if (!window.confirm('Cancellare il file scaricato dal disco? Metadati e copertina restano, il video resta in libreria.')) return;
        await deleteVideoFile(id);
        reload();
        return;
      }
      await setHidden(id, false); // Ripristina (togli dall'archivio)
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Archiviati</h1></div>
      {error && <div className="notice error">{error}</div>}

      {archived.length > 0 && (
        <div className="filter-bar">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={creator} onChange={(e) => setCreator(e.target.value)} aria-label="Filtra per creator">
            <option value="">Tutti i creator</option>
            {channelOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
      )}

      {videos === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nessun video archiviato.</div>
      ) : (
        <div className="grid grayscale-grid">
          {filtered.map((v) => (
            <VideoCard key={v.id} video={v} onDecide={handleAction} />
          ))}
        </div>
      )}
      {modal}
    </>
  );
}
