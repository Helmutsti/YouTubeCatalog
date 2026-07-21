import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { BACKUP_URL, restoreBackup } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';

export function SettingsPage() {
  useTitle('Impostazioni');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

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

  return (
    <>
      <div className="page-head"><h1>Impostazioni</h1></div>

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
