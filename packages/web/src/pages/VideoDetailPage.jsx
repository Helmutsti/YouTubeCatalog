import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Archive, RotateCcw, RefreshCw, Volume2, Video as VideoIcon } from 'lucide-react';
import { getVideo, listVideosByChannel, decideVideo } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { reviewActionsFor } from '../lib/reviewActions.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';

const ICONS = { download: Download, exclude: Archive, undecided: RotateCcw };

export function VideoDetailPage() {
  const { id } = useParams();
  const [video, setVideo] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const navigate = useNavigate();

  function reload() {
    setError(null);
    getVideo(id).then(setVideo).catch((e) => setError(e.message));
  }

  useEffect(reload, [id]);
  useEffect(() => setAudioOnly(false), [id]);

  useEffect(() => {
    if (!video) return;
    const key = channelKey(video);
    if (!key) return;
    listVideosByChannel(key)
      .then((videos) => setRelated(videos.filter((v) => v.id !== video.id).slice(0, 5)))
      .catch(() => setRelated([]));
  }, [video]);

  async function handleDecide(decision, label) {
    try {
      await decideVideo(id, decision);
      setNotice(decision === 'download' ? `Aggiunto alla coda. Vai su Home per avviare il download.` : `${label}: fatto.`);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  if (error) {
    return (
      <>
        <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
        <div className="notice error" style={{ marginTop: 16 }}>{error}</div>
      </>
    );
  }
  if (!video) return <div className="empty-state"><span className="spinner"></span></div>;

  const key = channelKey(video);
  const actions = reviewActionsFor(video.status);
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
      <div className="detail-body" style={{ marginTop: 16 }}>
        <div className="player-col">
          <div className={`player-frame${audioOnly ? ' audio-only' : ''}`}>
            {video.status === 'downloaded' && video.videoUrl ? (
              <>
                <video controls src={video.videoUrl} />
                <div className="audio-face"><Volume2 size={32} /><span>Solo audio</span></div>
              </>
            ) : video.status === 'downloading' ? (
              <div className="player-placeholder">
                <span className="spinner"></span>
                <span>Download in corso — vedi la <Link to="/jobs">pagina Job</Link> per il log live.</span>
              </div>
            ) : (
              <div className="player-placeholder">
                <StatusBadge status={video.status} />
                <span>Non ancora disponibile per la riproduzione.</span>
              </div>
            )}
          </div>

          <h1 className="d-title">{video.title ?? video.id}</h1>

          <div className="d-row">
            <div className="d-chan">
              <div className="d-avatar">
                {video.channel?.avatarUrl ? <img className="avatar-photo" src={video.channel.avatarUrl} alt="" /> : channelInitial(video)}
              </div>
              <div>
                {key ? (
                  <Link to={`/channels/${encodeURIComponent(key)}`} className="d-chan-name">{video.channel?.name ?? 'Canale sconosciuto'}</Link>
                ) : (
                  <div className="d-chan-name">{video.channel?.name ?? 'Canale sconosciuto'}</div>
                )}
                <div className="d-meta">{[dur, date].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="d-actions">
              {video.status === 'downloaded' && (
                <button className="btn" onClick={() => setAudioOnly((v) => !v)}>
                  {audioOnly ? <VideoIcon size={14} /> : <Volume2 size={14} />}
                  {audioOnly ? 'Video' : 'Solo audio'}
                </button>
              )}
              {actions.map((a) => {
                const Icon = ICONS[a.decision] ?? Download;
                const cls = a.decision === 'exclude' ? 'btn btn-danger' : a.decision === 'download' ? 'btn btn-primary' : 'btn';
                return (
                  <button key={a.decision} className={cls} onClick={() => handleDecide(a.decision, a.label)}>
                    <Icon size={14} />
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>

          {notice && <div className="notice success" style={{ marginTop: 16 }}>{notice}</div>}

          {video.status === 'failed' && video.error && (
            <div className="notice error" style={{ marginTop: 16 }}>
              Download fallito ({video.attempts} tentativ{video.attempts === 1 ? 'o' : 'i'}): {video.error}
            </div>
          )}

          {(video.description || video.tags?.length > 0) && (
            <div className="d-desc">
              {video.description && (<><span className="label">Descrizione</span>{video.description}</>)}
              {video.tags?.length > 0 && (
                <div className="d-tags">
                  {video.tags.slice(0, 12).map((tag) => <div key={tag} className="d-tag">{tag}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        {related.length > 0 && (
          <div className="side-related">
            <div className="rel-lbl">Altri video di {video.channel?.name}</div>
            {related.map((r) => (
              <Link key={r.id} to={`/videos/${r.id}`} className="rel-item">
                <div className="rel-thumb">
                  {r.thumbnailUrl && <img src={r.thumbnailUrl} alt="" loading="lazy" />}
                  {formatDuration(r.durationSeconds) && <div className="dur">{formatDuration(r.durationSeconds)}</div>}
                </div>
                <div>
                  <div className="rel-title">{r.title ?? r.id}</div>
                  <div className="rel-meta">{videoDisplayDate(r)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
