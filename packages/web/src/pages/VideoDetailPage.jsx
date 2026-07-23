import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Archive, ArchiveRestore, Play, PictureInPicture2, Gauge, FileDown, Star, ChevronRight, ChevronLeft, ListMusic, RefreshCw, X } from 'lucide-react';
import { getVideo, listVideos, setHidden, setFavorite, deleteVideo, triggerJob, refreshMetadata } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { actionsFor } from '../lib/reviewActions.js';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { startDownload } from '../lib/downloadActions.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial, formatBytes, formatBitrate } from '../lib/format.js';
import { confirmDialog } from '../lib/dialog.js';
import { showToast, updateToast } from '../lib/toast.js';
import { useQueue, removeFromQueue, clearQueue, popNextInQueue } from '../lib/queueStore.js';

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 0.25, 0.5, 0.75];
const DOWNLOAD_LABEL = { none: 'Non scaricato', downloading: 'In download', downloaded: 'Scaricato', failed: 'Errore download' };

export function VideoDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [video, setVideo] = useState(null);
  const [related, setRelated] = useState([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedCollapsed, setRelatedCollapsed] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [pipError, setPipError] = useState(null);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  const videoRef = useRef(null);
  const descRef = useRef(null);
  const queue = useQueue();
  // Autoplay in coda (M52): evita di richiamare play() più di una volta per
  // ogni navigazione — l'effetto qui sotto ha video?.videoUrl tra le
  // dipendenze e ri-scatterebbe altrimenti a ogni suo re-render.
  const autoplayedRef = useRef(false);

  function reload() {
    setError(null);
    getVideo(id).then(setVideo).catch((e) => setError(e.message));
  }

  useEffect(reload, [id]);
  useEffect(() => setHasStarted(false), [id]);
  useEffect(() => setPipError(null), [id]);
  // Il browser azzera playbackRate a 1x a ogni nuovo <video src>: si resetta lo
  // stato in coppia, così l'etichetta del pulsante non mente sulla velocità
  // reale quando si passa da un video all'altro.
  useEffect(() => setSpeedIndex(0), [id]);
  useEffect(() => { autoplayedRef.current = false; }, [id]);
  useEffect(() => setDescExpanded(false), [id]);

  // Descrizione collassabile in stile YouTube: il toggle "Mostra altro" deve
  // comparire solo se il testo eccede davvero le righe clampate — una soglia
  // sui caratteri sarebbe approssimativa (dipende da font/larghezza colonna),
  // mentre confrontare scrollHeight/clientHeight sul nodo reale è esatto.
  // useLayoutEffect (non useEffect) per misurare prima del paint ed evitare
  // un flash del pulsante con lo stato della descrizione precedente quando
  // si cambia video. La misura è valida quando descExpanded è false (clamp
  // CSS attivo): è il caso che si verifica sempre al cambio di id, perché
  // l'effetto sopra riporta descExpanded a false in coppia.
  useLayoutEffect(() => {
    const el = descRef.current;
    setDescClamped(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [video?.description, video?.id]);

  // Autoplay a fine video (M52): quando si arriva qui da handleEnded (navigate
  // con state.autoplay), avvia subito la riproduzione appena il tag <video> ha
  // una sorgente pronta. Best-effort: alcuni browser possono comunque
  // bloccare l'autoplay con audio non collegato a un gesto utente diretto su
  // QUESTA pagina — in quel caso resta comunque il pulsante "Riproduci" sulla
  // copertina, nessun errore mostrato all'utente per questo.
  useEffect(() => {
    if (!location.state?.autoplay || !video?.videoUrl || autoplayedRef.current) return;
    autoplayedRef.current = true;
    videoRef.current?.play().catch(() => {});
  }, [location.state, video?.videoUrl]);

  // A fine video, se la coda ha un elemento successivo si passa lì da soli;
  // se è vuota, nessun autoplay (niente fallback sui suggeriti casuali —
  // scelta esplicita del piano M52).
  function handleEnded() {
    const next = popNextInQueue();
    if (next) navigate(`/videos/${next.id}`, { state: { autoplay: true } });
  }

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

  // "Video suggeriti" (punto 1 del backlog): selezione casuale su tutta la
  // libreria (non più limitata allo stesso canale), esclusi il video corrente
  // e gli archiviati. Estratta in una funzione così il pulsante "rimescola" può
  // ripescarne 5 nuovi su richiesta, ri-scaricando la lista dal server (vede
  // eventuali video aggiunti/rimossi/archiviati nel frattempo).
  const loadRelated = useCallback(() => {
    if (!video) return;
    setRelatedLoading(true);
    listVideos()
      .then((videos) => {
        const pool = videos.filter((v) => v.id !== video.id && !v.hidden);
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        setRelated(shuffled.slice(0, 5));
      })
      .catch(() => setRelated([]))
      .finally(() => setRelatedLoading(false));
  }, [video]);

  // Ricalcolo automatico a ogni cambio di video (loadRelated cambia con `video`).
  useEffect(() => { loadRelated(); }, [loadRelated]);

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

  // Menu ⋮ della card orizzontale di un suggerito (M53): stesso ventaglio di
  // azioni di handleAction, ma sul suggerito cliccato, non sul video in
  // pagina. `reload()` sul video corrente basta anche qui: rilegge `video`
  // (stesso id, dati invariati) ma ne cambia il riferimento, e questo da solo
  // rifà scattare l'effetto che ricalcola "Video suggeriti" da dati freschi
  // (nuovo pool + nuovo shuffle) — nessuna funzione di refresh separata.
  async function handleRelatedAction(rid, kind) {
    const target = related.find((r) => r.id === rid);
    try {
      if (kind === 'download') {
        await startDownload(rid, { triggerJob, onSettled: reload, title: target?.title });
        return;
      }
      if (kind === 'hide') {
        requestHide(target);
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(rid);
        reload();
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(rid, kind === 'favorite');
        reload();
        return;
      }
      if (kind === 'deletevideo') {
        await deleteVideo(rid);
        showToast('Video cancellato definitivamente.', 'success');
        reload();
        return;
      }
      await setHidden(rid, false); // unhide
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
          <div className="player-frame">
            {isDownloaded && video.videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  controls
                  preload="metadata"
                  poster={video.thumbnailUrl || undefined}
                  src={video.videoUrl}
                  onPlay={() => setHasStarted(true)}
                  onEnded={handleEnded}
                />
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
              {video.description && (
                <>
                  <span className="label">Descrizione</span>
                  <div ref={descRef} className={`d-desc-text${descExpanded ? ' expanded' : ''}`}>
                    {video.description}
                  </div>
                  {descClamped && (
                    <button
                      type="button"
                      className="d-desc-toggle"
                      onClick={() => setDescExpanded((v) => !v)}
                      aria-expanded={descExpanded}
                    >
                      {descExpanded ? 'Mostra meno' : 'Mostra altro'}
                    </button>
                  )}
                </>
              )}
              {/* I tag restano sempre visibili (non nella parte collassabile):
                  sono chip brevi già pensati per una scansione rapida, non
                  prosa da troncare come la descrizione — nasconderli dietro
                  "Mostra altro" li renderebbe meno utili senza risparmiare
                  spazio in modo apprezzabile. */}
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

        {(queue.length > 0 || related.length > 0) && (
          <div className={`side-related${relatedCollapsed ? ' collapsed' : ''}`}>
            {relatedCollapsed ? (
              /* Collassata (M49, ridisegnato): scompare tutto — coda, header e
                 suggeriti — e resta solo una freccia "‹" per riaprire, ancorata
                 in alto; il player si prende lo spazio liberato. */
              <button
                className="rel-collapse-btn rel-reopen-btn"
                onClick={() => setRelatedCollapsed(false)}
                title="Espandi i suggeriti"
                aria-label="Espandi i suggeriti"
              >
                <ChevronLeft size={18} />
              </button>
            ) : (
              <>
                {/* Coda di riproduzione effimera (M52): box evidenziato, sopra
                    "Video suggeriti", mostrato solo a coda non vuota. */}
                {queue.length > 0 && (
                  <div className="queue-box">
                    <div className="rel-header">
                      <div className="rel-lbl"><ListMusic size={13} /> In coda ({queue.length})</div>
                      <button className="rel-collapse-btn" onClick={clearQueue} title="Svuota coda" aria-label="Svuota coda">
                        <X size={14} />
                      </button>
                    </div>
                    <div className="queue-list">
                      {queue.map((q) => (
                        <div key={q.id} className="rel-item queue-item">
                          <Link to={`/videos/${q.id}`} className="rel-thumb">
                            {q.thumbnailUrl && <img src={q.thumbnailUrl} alt="" loading="lazy" />}
                            {formatDuration(q.durationSeconds) && <div className="dur">{formatDuration(q.durationSeconds)}</div>}
                          </Link>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Link to={`/videos/${q.id}`} className="rel-title">{q.title}</Link>
                            {q.channelName && <div className="rel-meta">{q.channelName}</div>}
                          </div>
                          <button
                            className="rel-collapse-btn"
                            onClick={() => removeFromQueue(q.id)}
                            title="Rimuovi dalla coda"
                            aria-label="Rimuovi dalla coda"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {related.length > 0 && (
                  <>
                    <div className="rel-header">
                      <div className="rel-lbl">Video suggeriti</div>
                      <div className="rel-actions">
                        <button
                          className="rel-collapse-btn"
                          onClick={loadRelated}
                          disabled={relatedLoading}
                          title="Rimescola i suggeriti"
                          aria-label="Rimescola i suggeriti"
                        >
                          <RefreshCw size={15} className={relatedLoading ? 'spin' : undefined} />
                        </button>
                        <button
                          className="rel-collapse-btn"
                          onClick={() => setRelatedCollapsed(true)}
                          title="Comprimi i suggeriti"
                          aria-label="Comprimi i suggeriti"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </div>
                    {related.map((r) => (
                      <VideoCard key={r.id} video={r} layout="row" onDecide={handleRelatedAction} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {modal}
    </>
  );
}
