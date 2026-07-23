import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Maximize2, Play } from 'lucide-react';
import {
  usePlayer, useMiniPlayerEnabled,
  setPlaying, setStarted, setCurrent, setVideoEl, setDetached, setMinimized, clear, consumePendingPlay, getPlayerState
} from '../lib/playerStore.js';
import { popNextInQueue } from '../lib/queueStore.js';
import { getVideo } from '../api/client.js';

// Mini-player desktop-only (scelta di scope M54): su schermo piccolo vale il
// comportamento attuale (il video si ferma al cambio pagina), così non resta
// audio in sottofondo da un riquadro nascosto. La soglia coincide col
// breakpoint mobile del CSS.
function isDesktopViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 641px)').matches;
}

// Mini-player persistente (M54). Un UNICO <video> per tutta la GUI, montato
// qui (in Layout, sopra il router) così sopravvive al cambio di route — la
// causa stessa del vecchio bug PiP era che il <video> viveva dentro
// VideoDetailPage e React lo smontava cambiando pagina.
//
// Reparenting senza reload: il <video> non viene mai ricreato. Vive dentro un
// nodo DOM stabile (`mountRef`), creato una sola volta, in cui React "porta"
// (createPortal) il contenuto del player. Quel nodo viene poi SPOSTATO a mano
// (appendChild) tra lo slot della pagina di dettaglio (#player-dock-slot) e il
// riquadro flottante in basso a destra. Spostare un nodo <video> con
// appendChild non ne resetta la riproduzione; ricrearlo (che accadrebbe se il
// <video> fosse figlio diretto di un portale il cui target cambia) sì — per
// questo il portale punta sempre allo STESSO nodo e muoviamo il nodo, non il
// portale.
export function MiniPlayer() {
  const { current, playing, started, detached, minimized } = usePlayer();
  const enabled = useMiniPlayerEnabled();
  const location = useLocation();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const floatHomeRef = useRef(null);

  // Nodo di montaggio stabile: creato una volta sola, mai ricreato.
  const mountRef = useRef(null);
  if (mountRef.current === null && typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.className = 'global-player';
    mountRef.current = el;
  }

  const onOwnPage = !!current && location.pathname === `/videos/${current.id}`;
  // Agganciato alla pagina solo se NON minimizzato manualmente: "minimizza"
  // forza il flottante anche restando sulla pagina del video.
  const docked = onOwnPage && !minimized;
  // Flotta se: mini-player attivo, desktop, non agganciato, e o è in
  // riproduzione, o è stato staccato/minimizzato.
  //   - `playing`: rende `floating` vero NELLO STESSO render della navigazione
  //     (stato sincrono dallo store), così il <video> non si smonta mai per un
  //     commit — se dipendesse solo da `detached` (impostato in un effetto dopo
  //     il commit) ci sarebbe un frame senza player e il media ripartirebbe da
  //     capo, tagliando la riproduzione. È il nodo di continuità della M54.
  //   - `detached`: mantiene il riquadro anche mettendo in pausa (altrimenti
  //     sparirebbe al primo `onPause`).
  //   - `minimized`: "minimizza" manuale, forza il flottante sulla stessa pagina.
  const desktop = isDesktopViewport();
  const floating = !!current && !docked && enabled && desktop && (playing || detached || minimized);
  const shouldShow = docked || floating;

  // Riposiziona il nodo del player: nello slot della pagina (dock) o nel
  // riquadro flottante. useLayoutEffect per farlo prima del paint (niente
  // sfarfallio). appendChild è idempotente grazie al controllo su parentNode.
  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount || !shouldShow) return;
    if (docked) {
      const slot = document.getElementById('player-dock-slot');
      if (slot && mount.parentNode !== slot) slot.appendChild(mount);
      mount.classList.toggle('global-player--docked', true);
      mount.classList.toggle('global-player--floating', false);
    } else if (floating) {
      const home = floatHomeRef.current;
      if (home && mount.parentNode !== home) home.appendChild(mount);
      mount.classList.toggle('global-player--docked', false);
      mount.classList.toggle('global-player--floating', true);
    }
  });

  // Transizione al cambio pagina. Legge lo stato fresco dallo store (non le
  // closure di render, che potrebbero essere sfasate durante la navigazione):
  // - tornati sulla pagina del video → ri-agganciato, azzera "staccato";
  // - lasciata la pagina mentre in riproduzione e mini-player attivo → stacca
  //   nel riquadro flottante;
  // - altrimenti (in pausa, mini-player OFF) e non già staccato → ferma e chiude
  //   (ripristina il comportamento pre-M54: l'audio non resta in sottofondo).
  useEffect(() => {
    const st = getPlayerState();
    if (!st.current) return;
    const own = location.pathname === `/videos/${st.current.id}`;
    if (own) {
      // Tornati sulla pagina del video: ri-agganciato, azzera staccato/minimizzato.
      setDetached(false);
      setMinimized(false);
      return;
    }
    if (st.enabled && st.playing && isDesktopViewport()) {
      setDetached(true);
    } else if (!st.detached && !st.minimized) {
      videoRef.current?.pause();
      clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Disattivazione del mini-player (requisito e): si torna al comportamento
  // normale. Azzera "minimizza" (così sulla pagina del video il player si
  // ri-aggancia e continua); se si è fuori dalla pagina del video, ferma e chiude.
  useEffect(() => {
    if (enabled) return;
    setMinimized(false);
    if (current && !onOwnPage) {
      videoRef.current?.pause();
      clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Autoplay richiesto (setCurrent con play:true): parte quando l'elemento con
  // il nuovo src è montato. L'effetto scatta al cambio di id, cioè dopo che il
  // portale ha (ri)montato il <video> e videoRef è aggiornato.
  useEffect(() => {
    if (current && consumePendingPlay(current.id)) {
      videoRef.current?.play().catch(() => {});
    }
  }, [current?.id]);

  // Fine video: prosegue la coda M52. Se agganciati alla pagina di dettaglio si
  // naviga al successivo (la pagina imposta current e avvia, come da M52); se si
  // sta guardando dal riquadro flottante si carica e riproduce il successivo
  // senza cambiare pagina.
  async function handleEnded() {
    setPlaying(false);
    const next = popNextInQueue();
    if (!next) return;
    if (docked) {
      navigate(`/videos/${next.id}`, { state: { autoplay: true } });
      return;
    }
    try {
      const full = await getVideo(next.id);
      setCurrent(full, { play: true });
    } catch {
      clear();
    }
  }

  // X del riquadro flottante: ferma la riproduzione e chiude.
  function handleClose() {
    videoRef.current?.pause();
    clear();
  }

  // Ripristina il video a schermo intero dal riquadro flottante: annulla
  // staccato/minimizzato e, se non si è già sulla sua pagina, ci naviga.
  function handleExpand() {
    setMinimized(false);
    setDetached(false);
    if (current && location.pathname !== `/videos/${current.id}`) {
      navigate(`/videos/${current.id}`);
    }
  }

  const portalContent = current && (
    <>
      <video
        ref={(el) => { videoRef.current = el; setVideoEl(el); }}
        className="gp-video"
        controls
        playsInline
        preload="metadata"
        src={current.videoUrl || undefined}
        poster={current.thumbnailUrl || undefined}
        onPlay={() => { setStarted(true); setPlaying(true); }}
        onPause={() => setPlaying(false)}
        onEnded={handleEnded}
      />
      {docked && !started && (
        <button className="player-cover" onClick={() => videoRef.current?.play()} aria-label="Riproduci">
          {current.thumbnailUrl && <img src={current.thumbnailUrl} alt="" />}
          <span className="player-cover-play"><Play size={28} fill="currentColor" /></span>
        </button>
      )}
      {floating && (
        <div className="gp-chrome">
          <button
            className="gp-bar"
            onClick={handleExpand}
            title="Torna al video"
          >
            <Maximize2 size={13} />
            <span className="gp-title">{current.title}</span>
          </button>
          <button className="gp-close" onClick={handleClose} title="Chiudi" aria-label="Chiudi mini-player">
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Casa del riquadro flottante: contenitore fisso in basso a destra, in cui
          viene spostato il nodo del player quando non si è sulla pagina del video. */}
      <div ref={floatHomeRef} className={`mini-float-home${floating ? ' visible' : ''}`} />
      {shouldShow && mountRef.current && createPortal(portalContent, mountRef.current)}
    </>
  );
}
