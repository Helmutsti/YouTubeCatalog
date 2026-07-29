import { useEffect, useState } from 'react';
import { Clapperboard, Cookie, PictureInPicture2, Play } from 'lucide-react';
import { getConfig, patchConfig } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';
import { showToast } from '../lib/toast.js';
import { useMiniPlayerEnabled, setMiniPlayerEnabled, useAutoplayOnOpen, setAutoplayOnOpen } from '../lib/playerStore.js';

// Riscritta sulla config del core. Quello che c'era prima e non c'è più: backup e
// ripristino .zip, spostamento delle cartelle media/video, caricamento del file dei
// cookie, riorganizzazione della libreria — nessuna di quelle funzioni esiste nel
// core (l'elenco completo è in ../../DIFFERENZE.md).
//
// La sezione "Riproduzione" è rimasta identica: sono preferenze di questo browser,
// non hanno mai toccato il server.
//
// Le cartelle si mostrano ma non si cambiano da qui: il server le monta all'avvio,
// quindi cambiarle richiede comunque un riavvio. Si cambiano in `config.json`.

const QUALITA = [
  { value: 'best', label: 'Massima' },
  { value: 'ask', label: 'Chiedi ogni volta' },
  ...[2160, 1440, 1080, 720, 480, 360].map((h) => ({ value: String(h), label: `${h}p (o la migliore sotto)` }))
];

const PARALLELI = [1, 2, 3, 4, 5, 6, 8, 12];

function Percorso({ nome, valore, presente }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, marginTop: 6 }}>
      <span style={{ color: presente ? 'var(--ok, #4ade80)' : 'var(--danger, #f87171)' }} aria-hidden="true">
        {presente ? '●' : '○'}
      </span>
      <span style={{ minWidth: 96, color: 'var(--faint)' }}>{nome}</span>
      <code style={{ wordBreak: 'break-all' }}>{valore ?? '—'}</code>
    </div>
  );
}

export function SettingsPage() {
  useTitle('Impostazioni');
  const miniPlayerEnabled = useMiniPlayerEnabled();
  const autoplayOnOpen = useAutoplayOnOpen();

  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [vlcInput, setVlcInput] = useState('');
  const [cookiesInput, setCookiesInput] = useState('');

  function reloadConfig() {
    getConfig()
      .then((c) => {
        setConfig(c);
        setVlcInput(c.vlc ?? '');
        setCookiesInput(c.cookies ?? '');
      })
      .catch((e) => setError(e.message));
  }
  useEffect(reloadConfig, []);

  async function salva(partial, messaggio) {
    setBusy(true);
    setError(null);
    try {
      const c = await patchConfig(partial);
      setConfig(c);
      setVlcInput(c.vlc ?? '');
      setCookiesInput(c.cookies ?? '');
      showToast(messaggio, 'success');
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const qualita = typeof config?.quality === 'number' ? String(config.quality) : config?.quality ?? 'best';

  return (
    <>
      <div className="page-head"><h1>Impostazioni</h1></div>

      <div className="d-desc">
        <span className="label">Riproduzione</span>
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title"><PictureInPicture2 size={15} /> Mini-player flottante</div>
            <div className="setting-sub">
              Lasciando la pagina di un video in riproduzione, continua in un piccolo riquadro in basso a destra mentre navighi altrove (come su YouTube). Disattivandolo, il video si ferma al cambio pagina. Solo desktop. La preferenza è salvata in questo browser.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={miniPlayerEnabled}
            className={`switch${miniPlayerEnabled ? ' on' : ''}`}
            onClick={() => setMiniPlayerEnabled(!miniPlayerEnabled)}
            aria-label="Attiva/disattiva mini-player flottante"
          >
            <span className="switch-knob" />
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title"><Play size={15} /> Riproduzione automatica</div>
            <div className="setting-sub">
              Se attivo, aprendo un video già scaricato la riproduzione parte da sola. I browser possono bloccare l'avvio automatico con audio finché non interagisci con la pagina: in quel caso resta la copertina "Riproduci" da cliccare. La preferenza è salvata in questo browser.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoplayOnOpen}
            className={`switch${autoplayOnOpen ? ' on' : ''}`}
            onClick={() => setAutoplayOnOpen(!autoplayOnOpen)}
            aria-label="Attiva/disattiva riproduzione automatica all'apertura di un video"
          >
            <span className="switch-knob" />
          </button>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">Qualità predefinita</span>
        Vale per i download futuri. «Chiedi ogni volta» fa comparire la scelta della risoluzione
        appena lanci un download, link per link. La qualità più alta viene comunque esclusa se è
        in AV1: alla stessa risoluzione dava 403 sistematici.
        <div style={{ marginTop: 12 }}>
          <select
            value={qualita}
            disabled={busy || !config}
            aria-label="Qualità predefinita"
            onChange={(e) => {
              const v = e.target.value;
              salva({ quality: v === 'best' || v === 'ask' ? v : Number(v) }, 'Qualità predefinita aggiornata.');
            }}
          >
            {QUALITA.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">Download in parallelo</span>
        Quanti download insieme. Vale subito: alzarlo fa partire altri worker, abbassarlo li
        congeda quando hanno finito quello che hanno per le mani, senza interrompere niente.
        <div style={{ marginTop: 12 }}>
          <select
            value={String(config?.parallel ?? 3)}
            disabled={busy || !config}
            aria-label="Download in parallelo"
            onChange={(e) => salva({ parallel: Number(e.target.value) }, `${e.target.value} download in parallelo.`)}
          >
            {PARALLELI.map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">VLC</span>
        Serve alla CLI per riprodurre un video fuori dal browser; qui nella web app si usa il
        player della pagina. Vuoto = nessuno.
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240, maxWidth: 'none' }}>
            <input
              placeholder="Es. C:\Program Files\VideoLAN\VLC\vlc.exe"
              value={vlcInput}
              onChange={(e) => setVlcInput(e.target.value)}
              disabled={busy}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => salva({ vlc: vlcInput.trim() }, 'VLC aggiornato.')}
            disabled={busy || vlcInput.trim() === (config?.vlc ?? '')}
          >
            <Clapperboard size={15} /> Salva
          </button>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">Cookie</span>
        Il <b>percorso</b> di un file cookie in formato Netscape, per i video privati o non listati
        del tuo account. Prima si caricava il contenuto del file, adesso si indica dov'è. Si usano
        solo come ripiego, dopo un primo tentativo senza: mandarli insieme al client
        <code> android_vr </code> è la combinazione che la CDN di YouTube blocca con 403.
        Vuoto = nessuno.
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240, maxWidth: 'none' }}>
            <input
              placeholder="Es. D:\YouTube\cookies.txt"
              value={cookiesInput}
              onChange={(e) => setCookiesInput(e.target.value)}
              disabled={busy}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => salva({ cookies: cookiesInput.trim() }, 'Cookie aggiornati.')}
            disabled={busy || cookiesInput.trim() === (config?.cookies ?? '')}
          >
            <Cookie size={15} /> Salva
          </button>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">Stato e percorsi</span>
        Dove sta attingendo il server. Si cambiano in <code>config.json</code> — il server monta le
        cartelle all'avvio, quindi un cambio richiede un riavvio.
        {config && (
          <div style={{ marginTop: 12 }}>
            <Percorso nome="libreria" valore={config.paths?.root} presente />
            <Percorso nome="video" valore={config.paths?.videos} presente />
            <Percorso nome="copertine" valore={config.paths?.covers} presente />
            <Percorso nome="metadati" valore={config.paths?.metadata} presente />
            <Percorso nome="yt-dlp" valore={config.tools?.ytdlp?.path} presente={config.tools?.ytdlp?.found} />
            <Percorso nome="ffmpeg" valore={config.tools?.ffmpeg?.path} presente={config.tools?.ffmpeg?.found} />
            <Percorso nome="ffprobe" valore={config.tools?.ffprobe?.path} presente={config.tools?.ffprobe?.found} />
            <Percorso
              nome={config.tools?.jsRuntime ? `js (${config.tools.jsRuntime.name})` : 'js'}
              valore={config.tools?.jsRuntime?.path ?? 'nessun runtime: yt-dlp non potrà scaricare da YouTube'}
              presente={Boolean(config.tools?.jsRuntime)}
            />
          </div>
        )}
      </div>

      {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
    </>
  );
}
