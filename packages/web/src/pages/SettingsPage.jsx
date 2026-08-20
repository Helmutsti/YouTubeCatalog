import { useEffect, useState } from 'react';
import { Download, Upload, Clapperboard, Cookie, Trash2, PictureInPicture2, Play, Gauge, Layers } from 'lucide-react';
import { BACKUP_URL, restoreBackup, getConfig, setVideosRoot, setDefaultQuality, setParallel, uploadCookies, deleteCookies } from '../api/client.js';
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

  // --- Qualità predefinita dei download (stesso menu della CLI) ---
  const [qualityBusy, setQualityBusy] = useState(false);
  const [qualityError, setQualityError] = useState(null);

  // --- Download in parallelo (stesso menu della CLI, default 1) ---
  const [parallelBusy, setParallelBusy] = useState(false);
  const [parallelError, setParallelError] = useState(null);

  // --- Percorso video (copertine/avatar vivono fissi dentro data/media) ---
  const [config, setConfig] = useState(null);
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
      setVideosInput(c.videosRoot ?? '');
      setCookiesStatus(c.cookies);
      return c;
    });
  }

  useEffect(() => {
    reloadConfig().catch((e) => setVideosError(e.message));
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

  async function handleSetQuality(e) {
    const level = (config?.qualityLevels ?? []).find((q) => e.target.value === `${q.kind}:${q.height}`);
    if (!level) return;
    setQualityError(null);
    setQualityBusy(true);
    try {
      await setDefaultQuality(level);
      await reloadConfig();
    } catch (err) {
      setQualityError(err.message);
    } finally {
      setQualityBusy(false);
    }
  }

  async function handleSetParallel(e) {
    const n = Number.parseInt(e.target.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setParallelError(null);
    setParallelBusy(true);
    try {
      await setParallel(n);
      await reloadConfig();
    } catch (err) {
      setParallelError(err.message);
    } finally {
      setParallelBusy(false);
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
        <span className="label"><Gauge size={15} style={{ verticalAlign: -2 }} /> Qualità predefinita</span>
        Vale per i download futuri (i già scaricati non vengono toccati). «Chiedi ogni volta» fa comparire la scelta della risoluzione a ogni download, come già succede per ogni video da questa pagina web. La qualità più alta esclude comunque l'AV1: alla stessa risoluzione dava errori 403 sistematici.
        {config && (
          <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
            <select
              value={(() => {
                const current = (config.qualityLevels ?? []).find((q) => q.current);
                return current ? `${current.kind}:${current.height}` : '';
              })()}
              onChange={handleSetQuality}
              disabled={qualityBusy}
            >
              {(config.qualityLevels ?? []).map((q) => (
                <option key={`${q.kind}:${q.height}`} value={`${q.kind}:${q.height}`}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {qualityError && <div className="notice error" style={{ marginTop: 14 }}>{qualityError}</div>}
      </div>

      <div className="d-desc">
        <span className="label"><Layers size={15} style={{ verticalAlign: -2 }} /> Download in parallelo</span>
        Quanti download vanno insieme invece che uno alla volta (default 1). Alzarlo fa partire subito quelli in coda; abbassarlo non interrompe quelli già in corso, semplicemente non vengono rimpiazzati finché non si scende sotto il tetto.
        {config && (
          <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
            <select
              value={config.parallel ?? 1}
              onChange={handleSetParallel}
              disabled={parallelBusy}
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n === 1 ? '1 (uno alla volta)' : n}</option>
              ))}
            </select>
          </div>
        )}
        {parallelError && <div className="notice error" style={{ marginTop: 14 }}>{parallelError}</div>}
      </div>

      <div className="d-desc">
        <span className="label">Cartella video</span>
        Posizione su disco dei file video (con una sottocartella per creator). Copertine e avatar vivono invece dentro <code>data/media</code>, non spostabili separatamente. Per cambiare questa: crea/sposta prima la cartella, poi indica qui il percorso — l'app non tocca i file. Effetto dopo il riavvio del server.
        {config && (
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            Percorso attuale: <code>{config.videosDirResolved}</code>
            {!config.videosRoot && <> <span style={{ color: 'var(--faint)' }}>(default: ./videos)</span></>}
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
        <span className="label">Backup e ripristino</span>
        Scarica un archivio .zip con il catalogo, i metadati, lo storico dei job, le impostazioni e le copertine/avatar (i file video e i cookie non sono inclusi), oppure ripristina da un backup .zip: i file dati attuali vengono prima copiati in una cartella di sicurezza, poi sostituiti. Dopo un ripristino occorre riavviare il server.
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <a className="btn btn-primary" href={BACKUP_URL}>
            <Download size={15} /> Scarica backup .zip
          </a>
          <label className="btn" style={{ cursor: busy ? 'default' : 'pointer' }}>
            <Upload size={15} /> {busy ? 'Ripristino…' : 'Ripristina da file…'}
            <input type="file" accept=".zip" hidden onChange={handleRestore} disabled={busy} />
          </label>
        </div>
        {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
        {result && (
          <div className="notice success" style={{ marginTop: 14 }}>
            Ripristinati: {result.restored.join(', ')}{result.restoredImages ? ` + ${result.restoredImages} immagini` : ''}. Copia di sicurezza in <code>{result.safetyDir}</code>.
            {' '}<strong>Riavvia il server</strong> per applicare le modifiche.
          </div>
        )}
      </div>
    </>
  );
}
