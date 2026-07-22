import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { listVideosByChannel, syncChannelAvatars } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { formatDuration, videoDisplayDate } from '../lib/format.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { showToast } from '../lib/toast.js';

// Pagina del creator: TUTTI i suoi video (scaricati e non), non solo gli
// scaricati — così un creator appena aggiunto mostra subito i suoi video
// "disponibili". Esclude solo i nascosti (visibili unicamente in Libreria).
export function ChannelPage() {
  const { key } = useParams();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('uploadDate');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(null);

  useEffect(() => {
    setVideos(null);
    listVideosByChannel(key).then(setVideos).catch((e) => setError(e.message));
  }, [key]);

  // Forza il refresh della foto profilo di QUESTO creator (M42): a differenza
  // del bulk "Sincronizza foto creator" in Sorgenti (force:false, salta chi ce
  // l'ha già), qui force:true perché il senso del pulsante è proprio
  // rinfrescare una foto già presente. Ricarica i video per prendere il nuovo
  // avatarUrl con cache-bust (stesso filename ma query string diversa).
  async function handleAvatarRefresh() {
    setAvatarBusy(true);
    setAvatarError(null);
    showToast('Aggiornamento foto profilo avviato…', 'info');
    try {
      const r = await syncChannelAvatars(true, key);
      setVideos(await listVideosByChannel(key));
      if (r.failedCount > 0) {
        showToast(r.errors?.[0]?.error ?? 'Foto profilo non trovata.', 'error');
      } else {
        showToast('Foto profilo aggiornata.', 'success');
      }
    } catch (e) {
      setAvatarError(e.message);
      showToast(e.message, 'error');
    } finally {
      setAvatarBusy(false);
    }
  }

  const sorted = useMemo(
    () => (videos ? sortVideos(videos.filter((v) => !v.hidden), sort) : []),
    [videos, sort]
  );

  useTitle(videos?.[0]?.channel?.name ?? decodeURIComponent(key));

  if (error) return <div className="notice error">{error}</div>;
  if (!videos) return <div className="empty-state"><span className="spinner"></span></div>;

  const name = videos[0]?.channel?.name ?? decodeURIComponent(key);
  const avatarUrl = videos[0]?.channel?.avatarUrl ?? null;

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
      <div className="chan-head" style={{ marginTop: 16 }}>
        <div className="chan-avatar">
          {avatarUrl ? <img className="avatar-photo" src={avatarUrl} alt="" /> : name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="chan-name">{name}</div>
          <div className="chan-count">{sorted.length} video</div>
        </div>
        <button
          className="icon-btn"
          style={{ marginLeft: 'auto' }}
          disabled={avatarBusy}
          onClick={handleAvatarRefresh}
          title="Aggiorna foto profilo"
        >
          <RefreshCw size={14} className={avatarBusy ? 'spin' : undefined} />
        </button>
      </div>
      {avatarError && <div className="notice error">{avatarError}</div>}
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
                <StatusBadge video={v} />
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
