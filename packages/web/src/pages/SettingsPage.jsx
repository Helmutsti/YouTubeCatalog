import { useEffect, useState } from 'react';
import { Download, Upload, FolderCog } from 'lucide-react';
import { BACKUP_URL, restoreBackup, getConfig, setMediaRoot } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';

export function SettingsPage() {
  useTitle('Impostazioni');

  // --- Backup / ripristino ---
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // --- Cartella media ---
  const [config, setConfig] = useState(null);
  const [mediaInput, setMediaInput] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaResult, setMediaResult] = useState(null);
  const [mediaError, setMediaError] = useState(null);

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c);
        setMediaInput(c.mediaRoot);
      })
      .catch((e) => setMediaError(e.message));
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

  return (
    <>
      <div className="page-head"><h1>Impostazioni</h1></div>

      <div className="d-desc">
        <span className="label">Cartella media</span>
        Posizione su disco dei file scaricati (video, copertine, avatar). Per spostarla fuori dal progetto: sposta prima la cartella dove vuoi, poi indica qui il nuovo percorso — l'app non tocca i file. Il cambio ha effetto dopo il riavvio del server.
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
              placeholder="Es. D:\OndoMedia"
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
            {!mediaResult.hasVideos && <> ⚠ Attenzione: nessuna sottocartella <code>videos/</code> trovata qui.</>}
            {' '}<strong>Riavvia il server</strong> per applicare.
          </div>
        )}
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
