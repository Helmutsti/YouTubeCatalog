import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Archive, RotateCcw, RefreshCw, Volume2, Video as VideoIcon, Play, PictureInPicture2, Gauge } from 'lucide-react';
import { getVideo, listVideosByChannel, decideVideo } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { reviewActionsFor } from '../lib/reviewActions.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';

const ICONS = { download: Download, exclude: Archive, undecided: RotateCcw };
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 0.25, 0.5, 0.75];

export function VideoDetailPage() {
  const { id } = useParams();
  const [video, setVideo] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [pipError, setPipError] = useState(null);
  const [speedIndex, setSpeedIndex] = useState(0);
  const videoRef = useRef(null);
  const navigate = useNavigate();

  function reload() {
    setError(null);
    getVideo(id).then(setVideo).catch((e) => setError(e.message));
  }

  useEffect(reload, [id]);
  useEffect(() => setAudioOnly(false), [id]);
  useEffect(() => setHasStarted(false), [id]);
  useEffect(() => setPipError(null), [id]);
  // Il browser azzera playbackRate a 1x a ogni nuovo <video src>: si resetta lo
  // stato in coppia, così l'etichetta del pulsante non mente sulla velocità
  // reale quando si passa da un video all'altro.
  useEffect(() => setSpeedIndex(0), [id]);

  function cycleSpeed() {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (videoRef.current) videoRef.current.playbackRate = SPEEDS[next];
  }

  // Il pulsante PiP resta sincronizzato anche se l'utente chiude la finestra
  // PiP nativa del sistema operativo invece di usare di nuovo il pulsante.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnter = () => setIsPiP(true);
    const onLeave = () => setIsPiP(false);
    v.addEventListener('enterpictureinpicture', onEnter);
    v.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnter);
      v.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [video?.id]);

  async function togglePiP() {
    setPipError(null);
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      // requestPictureInPicture richiede i metadati già caricati: se l'utente
      // clicca PiP prima di aver mai avviato il video, il browser potrebbe non
      // averli ancora (anche con preload="metadata" — es. tab in background) —
      // si aspetta l'evento con un timeout, invece di fallire subito o restare
      // bloccato all'infinito se per qualche motivo l'evento non arriva mai.
      if (v.readyState < 1) {
        await Promise.race([
          new Promise((resolve) => v.addEventListener('loadedmetadata', resolve, { once: true })),
          new Promise((_, reject) => setTimeout(() => reject(new Error('metadati non caricati (timeout)')), 5000))
        ]);
      }
      await v.requestPictureInPicture();
    } catch (e) {
      setPipError(`Picture in Picture non disponibile: ${e.message}`);
    }
  }

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
                <video
                  ref={videoRef}
                  controls
                  preload="metadata"
                  poster={video.thumbnailUrl || undefined}
                  src={video.videoUrl}
                  onPlay={() => setHasStarted(true)}
                />
                <div className="audio-face"><Volume2 size={32} /><span>Solo audio</span></div>
                {!hasStarted && (
                  <button className="player-cover" onClick={() => videoRef.current?.play()} aria-label="Riproduci">
                    {video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" />}
                    <span className="player-cover-play"><Play size={28} fill="currentColor" /></span>
                  </button>
                )}
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
                  <Link to={`/channels/${encodeURIComponent(key)}`} className="d-chan-name">{video.channel?.name ?? 'Creator sconosciuto'}</Link>
                ) : (
                  <div className="d-chan-name">{video.channel?.name ?? 'Creator sconosciuto'}</div>
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
              {video.status === 'downloaded' && document.pictureInPictureEnabled && (
                <button className="btn" onClick={togglePiP}>
                  <PictureInPicture2 size={14} />
                  {isPiP ? 'Esci da PiP' : 'Picture in Picture'}
                </button>
              )}
              {video.status === 'downloaded' && (
                <button className="btn" onClick={cycleSpeed} title="Cambia velocità di riproduzione">
                  <Gauge size={14} />
                  {SPEEDS[speedIndex]}x
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
          {pipError && <div className="notice error" style={{ marginTop: 16 }}>{pipError}</div>}

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
