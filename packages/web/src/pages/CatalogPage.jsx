import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listVideos, decideVideo, triggerJob } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { StatusChips } from '../components/StatusChips.jsx';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { channelKey } from '../lib/format.js';

export function CatalogPage() {
  const [videos, setVideos] = useState(null);
  const [status, setStatus] = useState(null);
  const [sort, setSort] = useState('addedAt');
  const [channel, setChannel] = useState('');
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  function reload() {
    listVideos().then(setVideos).catch((e) => setError(e.message));
  }

  useEffect(reload, []);

  const counts = useMemo(() => {
    const acc = {};
    for (const v of videos ?? []) acc[v.status] = (acc[v.status] ?? 0) + 1;
    return acc;
  }, [videos]);

  // Elenco canali derivato dai video già caricati, non da listChannels() (che
  // di default considera solo i downloaded) — qui serve poter filtrare la
  // Home anche per i "nuovi"/"in coda" di un canale specifico, cosa che
  // ChannelPage non permette (mostra solo i downloaded di quel canale).
  const channelOptions = useMemo(() => {
    const byKey = new Map();
    for (const v of videos ?? []) {
      const key = channelKey(v);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, v.channel?.name ?? key);
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it', { sensitivity: 'base' }));
  }, [videos]);

  const filtered = useMemo(() => {
    if (!videos) return [];
    let list = status ? videos.filter((v) => v.status === status) : videos;
    if (channel) list = list.filter((v) => channelKey(v) === channel);
    return sortVideos(list, sort);
  }, [videos, status, channel, sort]);

  async function handleDecide(id, decision) {
    try {
      await decideVideo(id, decision);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function startQueuedDownload() {
    try {
      const { jobId } = await triggerJob('downloadPending');
      navigate(`/jobs?highlight=${jobId}`);
    } catch (e) {
      setError(e.message);
    }
  }

  const pendingCount = counts.pending ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Catalogo</h1>
      </div>
      {error && <div className="notice error">{error}</div>}
      <StatusChips value={status} counts={counts} onChange={setStatus} />
      <div className="filter-bar">
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Filtra per creator">
          <option value="">Tutti i creator</option>
          {channelOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
      </div>
      {pendingCount > 0 && (
        <div className="banner-cta">
          <div className="label"><b>{pendingCount}</b> video in coda, pronti per il download.</div>
          <button className="btn btn-primary" onClick={startQueuedDownload}>Scarica in coda ({pendingCount})</button>
        </div>
      )}
      {videos === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nessun video in questo stato.</div>
      ) : (
        <div className="grid">
          {filtered.map((v) => (
            <VideoCard key={v.id} video={v} onDecide={handleDecide} />
          ))}
        </div>
      )}
    </>
  );
}
