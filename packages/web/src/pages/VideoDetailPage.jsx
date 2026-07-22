import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Archive, ArchiveRestore, Volume2, Video as VideoIcon, Play, PictureInPicture2, Gauge, FileDown, Star } from 'lucide-react';
import { getVideo, listVideosByChannel, setHidden, setFavorite, triggerJob, refreshMetadata } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { actionsFor } from '../lib/reviewActions.js';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { startDownload } from '../lib/downloadActions.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial, formatBytes, formatBitrate } from '../lib/format.js';
import { confirmDialog } from '../lib/dialog.js';
import { showToast, updateToast } from '../lib/toast.js';

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 0.25, 0.5, 0.75];
const DOWNLOAD_LABEL = { none: 'Non scaricato', downloading: 'In download', downloaded: 'Scaricato', failed: 'Errore download' };

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

  const { requestHide, modal } = useHideWithPrompt({ onDone: reload, onError: setError });

  async function handleAction(kind, label) {
    try {
      if (kind === 'download') {
        await startDownload(id, { triggerJob, onSettled: reload, title: video.title });
        return;
      }
      if (kind === 'hide') {
        requestHide(video);
        return;
      }
      if (kind === 'metadata') {
        const toastId = showToast('Aggiornamento metadati avviato…', 'info', 0);
        try {
          await refreshMetadata(id);
          setNotice('Metadati aggiornati.');
          updateToast(toastId, { message: 'Metadati aggiornati.', type: 'success' });
          reload();
        } catch (e) {
          updateToast(toastId, { message: `Aggiornamento metadati fallito: ${e.message}`, type: 'error' });
          throw e;
        }
        return;
      }
      await setHidden(id, false); // unhide
      setNotice(`${label}: fatto.`);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  // Archivia dalla pagina video: volutamente defilato e con conferma (per gli
  // scaricati la conferma è il modale "Vuoi tenere il video?"; per gli altri un
  // confirm), così non è un click accidentale.
  async function handleArchive() {
    if (video.download === 'downloaded') { requestHide(video); return; }
    const ok = await confirmDialog({
      title: 'Archiviare il video?',
      message: `Archiviare "${video.title ?? video.id}"? Andrà tra gli Archiviati (puoi ripristinarlo).`,
      confirmLabel: 'Archivia',
      danger: true
    });
    if (ok) {
      setHidden(id, true).then(reload).catch((e) => setError(e.message));
    }
  }

  // Preferito (M43 era limitato al menu ⋮ di VideoCard): estensione al
  // dettaglio video, indipendente dallo stato di download come ogni altro
  // uso del flag `favorite`.
  async function toggleFavorite() {
    try {
      setVideo(await setFavorite(id, !video.favorite));
    } catch (e) {
      setError(e.message);
    }
  }

  useTitle(video?.title ?? null);

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
  const actions = actionsFor(video);
  const isDownloaded = video.download === 'downloaded';
  const downloadAction = actions.find((a) => a.kind === 'download');
  const hideAction = actions.find((a) => a.kind === 'hide' || a.kind === 'unhide');
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);

  // sha256 escluso deliberatamente (poco interessante da leggere per un
  // utente finale) — resta comunque nel catalogo/API se mai servisse altrove.
  const techFields = [
    {
      label: 'Risoluzione',
      value: video.resolution?.width && video.resolution?.height
        ? `${video.resolution.width}×${video.resolution.height}${video.resolution.fps ? ` · ${video.resolution.fps}fps` : ''}`
        : null
    },
    { label: 'Codec video', value: video.video?.videoCodec },
    { label: 'Codec audio', value: video.video?.audioCodec },
    { label: 'Bitrate', value: formatBitrate(video.video?.bitrateKbps) },
    { label: 'Dimensione file', value: formatBytes(video.video?.sizeBytes) },
    { label: 'Formato', value: video.video?.container },
    { label: 'yt-dlp', value: video.video?.ytdlpVersion }
  ].filter((f) => f.value);

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
      <div className="detail-body" style={{ marginTop: 16 }}>
        <div className="player-col">
          <div className={`player-frame${audioOnly ? ' audio-only' : ''}`}>
            {isDownloaded && video.videoUrl ? (
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
            ) : video.download === 'downloading' ? (
              <div className="player-placeholder">
                <span className="spinner"></span>
                <span>Download in corso — vedi il progresso in <Link to="/sources">Sorgenti</Link>.</span>
              </div>
            ) : (
              <div
                className="player-placeholder"
                style={video.thumbnailUrl ? {
                  backgroundImage: `linear-gradient(rgba(8,8,10,.82), rgba(8,8,10,.82)), url("${video.thumbnailUrl}")`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                } : undefined}
              >
                <StatusBadge video={video} inline />
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
              <button
                className={`icon-btn fav-toggle${video.favorite ? ' active' : ''}`}
                onClick={toggleFavorite}
                title={video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
                aria-label={video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
              >
                <Star size={18} fill={video.favorite ? 'currentColor' : 'none'} />
              </button>
              {isDownloaded && (
                <button className="btn" onClick={() => setAudioOnly((v) => !v)}>
                  {audioOnly ? <VideoIcon size={14} /> : <Volume2 size={14} />}
                  {audioOnly ? 'Video' : 'Solo audio'}
                </button>
              )}
              {isDownloaded && document.pictureInPictureEnabled && (
                <button className="btn" onClick={togglePiP}>
                  <PictureInPicture2 size={14} />
                  {isPiP ? 'Esci da PiP' : 'Picture in Picture'}
                </button>
              )}
              {isDownloaded && (
                <button className="btn" onClick={cycleSpeed} title="Cambia velocità di riproduzione">
                  <Gauge size={14} />
                  {SPEEDS[speedIndex]}x
                </button>
              )}
              {downloadAction && (
                <button className="btn btn-primary" onClick={() => handleAction('download', downloadAction.label)}>
                  <Download size={14} />{downloadAction.label}
                </button>
              )}
            </div>
          </div>


          {notice && <div className="notice success" style={{ marginTop: 16 }}>{notice}</div>}
          {pipError && <div className="notice error" style={{ marginTop: 16 }}>{pipError}</div>}

          {video.download === 'failed' && video.error && (
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

          {techFields.length > 0 && (
            <div className="d-desc">
              <span className="label">Dati tecnici</span>
              <div className="tech-grid">
                {techFields.map((f) => (
                  <div key={f.label}>
                    <span className="tech-key">{f.label}</span>
                    <span className="tech-val">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Box stato e sincronizzazione del singolo video (M35) */}
          <div className="d-desc">
            <span className="label">Stato e sincronizzazione</span>
            <div className="tech-grid">
              <div>
                <span className="tech-key">Presenza</span>
                <span className="tech-val">
                  {video.presence === 'removed'
                    ? `Rimosso da YouTube${video.removedAt ? ` · ${new Date(video.removedAt).toLocaleDateString('it-IT')}` : ''}`
                    : <a href={video.webpageUrl} target="_blank" rel="noopener noreferrer">Presente su YouTube</a>}
                </span>
              </div>
              <div>
                <span className="tech-key">Download</span>
                <span className="tech-val">{DOWNLOAD_LABEL[video.download] ?? video.download}</span>
              </div>
              <div>
                <span className="tech-key">Archiviato</span>
                <span className="tech-val">{video.hidden ? 'Sì' : 'No'}</span>
              </div>
              <div>
                <span className="tech-key">Metadati aggiornati</span>
                <span className="tech-val">{video.enrichedAt ? new Date(video.enrichedAt).toLocaleString('it-IT') : '—'}</span>
              </div>
              <div>
                <span className="tech-key">Sorgente</span>
                <span className="tech-val">
                  {video.sources?.length
                    ? video.sources.map((s) => s.name ?? s.sourceId).join(', ')
                    : 'Video singolo'}
                </span>
              </div>
            </div>
            <div className="sync-actions">
              <button className="btn" onClick={() => handleAction('metadata')}>
                <FileDown size={14} />Scarica metadati
              </button>
              {hideAction?.kind === 'hide' && (
                <button className="btn btn-brick" onClick={handleArchive}>
                  <Archive size={14} />Archivia
                </button>
              )}
              {hideAction?.kind === 'unhide' && (
                <button className="btn" onClick={() => handleAction('unhide', 'Ripristinato')}>
                  <ArchiveRestore size={14} />Ripristina
                </button>
              )}
            </div>
          </div>
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
      {modal}
    </>
  );
}
