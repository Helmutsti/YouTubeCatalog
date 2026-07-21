import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { listVideosByChannel } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { formatDuration, videoDisplayDate } from '../lib/format.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';

// Pagina del creator: TUTTI i suoi video (scaricati e non), non solo gli
// scaricati — così un creator appena aggiunto mostra subito i suoi video
// "disponibili". Esclude solo i nascosti (visibili unicamente in Libreria).
export function ChannelPage() {
  const { key } = useParams();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('addedAt');

  useEffect(() => {
    setVideos(null);
    listVideosByChannel(key).then(setVideos).catch((e) => setError(e.message));
  }, [key]);

  const sorted = useMemo(
    () => (videos ? sortVideos(videos.filter((v) => !v.hidden), sort) : []),
    [videos, sort]
  );

  if (error) return <div className="notice error">{error}</div>;
  if (!videos) return <div className="empty-state"><span className="spinner"></span></div>;

  const name = videos[0]?.channel?.name ?? decodeURIComponent(key);
  const avatarUrl = videos[0]?.channel?.avatarUrl ?? null;

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
      <div className="banner" style={{ marginTop: 16 }}></div>
      <div className="chan-head">
        <div className="chan-avatar">
          {avatarUrl ? <img className="avatar-photo" src={avatarUrl} alt="" /> : name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="chan-name">{name}</div>
          <div className="chan-count">{sorted.length} video</div>
        </div>
      </div>
      {sorted.length > 0 && (
        <div className="filter-bar">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="empty-state">Nessun video per questo creator.</div>
      ) : (
        <div className="grid">
          {sorted.map((v) => (
            <Link key={v.id} to={`/videos/${v.id}`} className="card">
              <div className="thumb">
                {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" />}
                <StatusBadge category={v.category} />
                {formatDuration(v.durationSeconds) && <div className="dur">{formatDuration(v.durationSeconds)}</div>}
              </div>
              <div className="card-title">{v.title ?? v.id}</div>
              <div className="card-meta">{videoDisplayDate(v)}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
