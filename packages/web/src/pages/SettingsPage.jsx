import { useEffect, useState } from 'react';
import { Download, Upload, FolderCog, Clapperboard, Cookie, Trash2, PictureInPicture2, Play } from 'lucide-react';
import { BACKUP_URL, restoreBackup, getConfig, setMediaRoot, setVideosRoot, uploadCookies, deleteCookies } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';
import { confirmDialog } from '../lib/dialog.js';
import { showToast } from '../lib/toast.js';
import { useMiniPlayerEnabled, setMiniPlayerEnabled, useAutoplayOnOpen, setAutoplayOnOpen } from '../lib/playerStore.js';

export function SettingsPage() {
  useTitle('Impostazioni');

  // --- Riproduzione (mini-player, M54; autoplay all'apertura, M60) — preferenze solo client (localStorage) ---
  const miniPlayerEnabled = useMiniPlayerEnabled();
  const autoplayOnOpen = useAutoplayOnOpen();

  // --- Backup / ripristino ---
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // --- Percorsi (media = copertine/avatar; video = file video) ---
  const [config, setConfig] = useState(null);
  const [mediaInput, setMediaInput] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaResult, setMediaResult] = useState(null);
  const [mediaError, setMediaError] = useState(null);
  const [videosInput, setVideosInput] = useState('');
  const [videosBusy, setVideosBusy] = useState(false);
  const [videosResult, setVideosResult] = useState(null);
  const [videosError, setVideosError] = useState(null);

  // --- Cookie YouTube ---
  const [cookiesStatus, setCookiesStatus] = useState(null);
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesError, setCookiesError] = useState(null);

  function reloadConfig() {
    return getConfig().then((c) => {
      setConfig(c);
      setMediaInput(c.mediaRoot ?? '');
      setVideosInput(c.videosRoot ?? '');
      setCookiesStatus(c.cookies);
      return c;
    });
  }

  useEffect(() => {
    reloadConfig().catch((e) => setMediaError(e.message));
  }, []);

  async function handleRestore(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permette di riselezionare lo stesso file
    if (!file) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await restoreBackup(file));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveMediaRoot() {
    setMediaError(null);
    setMediaResult(null);
    setMediaBusy(true);
    try {
      setMediaResult(await setMediaRoot(mediaInput.trim()));
    } catch (err) {
      setMediaError(err.message);
    } finally {
      setMediaBusy(false);
    }
  }

  async function handleSaveVideosRoot() {
    setVideosError(null);
    setVideosResult(null);
    setVideosBusy(true);
    try {
      setVideosResult(await setVideosRoot(videosInput.trim()));
    } catch (err) {
      setVideosError(err.message);
    } finally {
      setVideosBusy(false);
    }
  }

  async function handleUploadCookies(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permette di riselezionare lo stesso file
    if (!file) return;
    setCookiesError(null);
    setCookiesBusy(true);
    try {
      const text = await file.text();
      const status = await uploadCookies(text);
      setCookiesStatus(status);
      showToast('Cookie caricati.', 'success');
    } catch (err) {
      setCookiesError(err.message);
      showToast(`Caricamento cookie fallito: ${err.message}`, 'error');
    } finally {
      setCookiesBusy(false);
    }
  }

  async function handleDeleteCookies() {
    const ok = await confirmDialog({
      title: 'Cancellare i cookie?',
      message: 'I video privati, non listati o con limite d\'età smetteranno di essere accessibili finché non ne carichi di nuovi.',
      confirmLabel: 'Cancella',
      danger: true
    });
    if (!ok) return;
    setCookiesError(null);
    setCookiesBusy(true);
    try {
      const status = await deleteCookies();
      setCookiesStatus(status);
      showToast('Cookie cancellati.', 'success');
    } catch (err) {
      setCookiesError(err.message);
      showToast(`Cancellazione cookie fallita: ${err.message}`, 'error');
    } finally {
      setCookiesBusy(false);
    }
  }

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
              Se attivo, aprendo un video già scaricato la riproduzione parte da sola. I browser possono bloccare l'avvio automatico con audio finché non interagisci con la pagina: in quel caso resta la copertina "Riproduci" da cliccare. L'avanzamento automatico della coda/playlist funziona comunque, a prescindere da questa impostazione. La preferenza è salvata in questo browser.
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
        <span className="label">Cartella video</span>
        Posizione su disco dei file video (con una sottocartella per creator). Può stare su un disco diverso da copertine/avatar. Per cambiarla: crea/sposta prima la cartella, poi indica qui il percorso — l'app non tocca i file. Effetto dopo il riavvio del server.
        {config && (
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            Percorso attuale: <code>{config.videosDirResolved}</code>
            {!config.videosRoot && <> <span style={{ color: 'var(--faint)' }}>(default: sotto la cartella media)</span></>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240, maxWidth: 'none' }}>
            <input
              placeholder="Es. D:\YouTube\Video"
              value={videosInput}
              onChange={(e) => setVideosInput(e.target.value)}
              disabled={videosBusy}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleSaveVideosRoot}
            disabled={videosBusy || !videosInput.trim() || videosInput.trim() === (config?.videosRoot ?? '')}
          >
            <Clapperboard size={15} /> {videosBusy ? 'Salvataggio…' : 'Salva'}
          </button>
        </div>
        {videosError && <div className="notice error" style={{ marginTop: 14 }}>{videosError}</div>}
        {videosResult && (
          <div className="notice success" style={{ marginTop: 14 }}>
            Cartella video impostata su <code>{videosResult.resolved}</code>.
            {' '}<strong>Riavvia il server</strong> per applicare.
          </div>
        )}
      </div>

      <div className="d-desc">
        <span className="label">Cartella media (copertine e avatar)</span>
        Posizione su disco di copertine e avatar (piccoli). I file video hanno una cartella dedicata separata (sopra). Per cambiarla: sposta prima la cartella, poi indica qui il percorso. Effetto dopo il riavvio del server.
        {config && (
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            Percorso attuale: <code>{config.mediaRoot}</code>
            {config.mediaRootResolved !== config.mediaRoot && (
              <> → <code>{config.mediaRootResolved}</code></>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240, maxWidth: 'none' }}>
            <input
              placeholder="Es. ./media"
              value={mediaInput}
              onChange={(e) => setMediaInput(e.target.value)}
              disabled={mediaBusy}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleSaveMediaRoot}
            disabled={mediaBusy || !mediaInput.trim() || mediaInput.trim() === config?.mediaRoot}
          >
            <FolderCog size={15} /> {mediaBusy ? 'Salvataggio…' : 'Salva'}
          </button>
        </div>
        {mediaError && <div className="notice error" style={{ marginTop: 14 }}>{mediaError}</div>}
        {mediaResult && (
          <div className={`notice ${mediaResult.hasVideos ? 'success' : ''}`} style={{ marginTop: 14 }}>
            Cartella media impostata su <code>{mediaResult.resolved}</code>.
            {' '}<strong>Riavvia il server</strong> per applicare.
          </div>
        )}
      </div>

      <div className="d-desc">
        <span className="label">Cookie YouTube</span>
        Necessari per i video privati/non listati del tuo account o con limite d'età. Esporta i cookie dal browser (es. estensione "Get cookies.txt") mentre sei loggato su YouTube, poi caricali qui — sostituiscono quelli attuali, effetto immediato (nessun riavvio). Il file non viene mai versionato né incluso nel backup.
        {cookiesStatus && (
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            {cookiesStatus.present
              ? <>Cookie presenti, caricati il {new Date(cookiesStatus.updatedAt).toLocaleString('it-IT')}.</>
              : <span style={{ color: 'var(--faint)' }}>Nessun cookie configurato.</span>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <label className="btn btn-primary" style={{ cursor: cookiesBusy ? 'default' : 'pointer' }}>
            <Cookie size={15} /> {cookiesBusy ? 'Caricamento…' : 'Carica cookie…'}
            <input type="file" accept=".txt" hidden onChange={handleUploadCookies} disabled={cookiesBusy} />
          </label>
          {cookiesStatus?.present && (
            <button className="btn btn-danger" onClick={handleDeleteCookies} disabled={cookiesBusy}>
              <Trash2 size={15} /> Cancella cookie
            </button>
          )}
        </div>
        {cookiesError && <div className="notice error" style={{ marginTop: 14 }}>{cookiesError}</div>}
      </div>

      <div className="d-desc">
        <span className="label">Backup</span>
        Scarica un archivio .zip con il catalogo, i metadati e lo storico dei job. I file video non sono inclusi.
        <div style={{ marginTop: 14 }}>
          <a className="btn btn-primary" href={BACKUP_URL}>
            <Download size={15} /> Scarica backup .zip
          </a>
        </div>
      </div>

      <div className="d-desc">
        <span className="label">Ripristino</span>
        Carica un backup .zip. I file attuali vengono prima copiati in una cartella di sicurezza, poi sostituiti. Dopo il ripristino occorre riavviare il server.
        <div style={{ marginTop: 14 }}>
          <label className="btn" style={{ cursor: busy ? 'default' : 'pointer' }}>
            <Upload size={15} /> {busy ? 'Ripristino…' : 'Ripristina da file…'}
            <input type="file" accept=".zip" hidden onChange={handleRestore} disabled={busy} />
          </label>
        </div>
        {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
        {result && (
          <div className="notice success" style={{ marginTop: 14 }}>
            Ripristinati: {result.restored.join(', ')}. Copia di sicurezza in <code>{result.safetyDir}</code>.
            {' '}<strong>Riavvia il server</strong> per applicare le modifiche.
          </div>
        )}
      </div>
    </>
  );
}
