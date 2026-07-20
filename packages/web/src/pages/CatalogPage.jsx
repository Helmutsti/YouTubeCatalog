import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listVideos, decideVideo, triggerJob } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { StatusChips } from '../components/StatusChips.jsx';

export function CatalogPage() {
  const [videos, setVideos] = useState(null);
  const [status, setStatus] = useState(null);
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

  const filtered = useMemo(() => {
    if (!videos) return [];
    return status ? videos.filter((v) => v.status === status) : videos;
  }, [videos, status]);

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
