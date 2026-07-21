import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ImageIcon } from 'lucide-react';
import { listSources, addSource, removeSource, syncSources, syncChannelAvatars } from '../api/client.js';

export function SourcesPage() {
  const [sources, setSources] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forceAvatars, setForceAvatars] = useState(false);

  function reload() {
    listSources().then(setSources).catch((e) => setError(e.message));
  }
  useEffect(reload, []);

  async function handleAdd(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await addSource(url.trim());
      setNotice(result.alreadyExists
        ? `Fonte già presente: "${result.name}".`
        : `Aggiunta "${result.name}" — ${result.newCount} video trovati.`);
      setUrl('');
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(source) {
    if (!window.confirm(`Rimuovere "${source.name}"? I video già scaricati non verranno toccati.`)) return;
    try {
      await removeSource(source.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleSync(sourceId) {
    setBusy(true);
    setError(null);
    try {
      const result = await syncSources(sourceId);
      const totals = Object.values(result).reduce(
        (acc, r) => ({ newCount: acc.newCount + r.newCount, healedCount: acc.healedCount + r.healedCount }),
        { newCount: 0, healedCount: 0 }
      );
      setNotice(`Sincronizzato: ${totals.newCount} nuovi, ${totals.healedCount} riparati.`);
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Foto profilo canali (M14): force:false salta chi ce l'ha già (idempotente,
  // uso normale); il checkbox "Aggiorna anche le foto già presenti" passa
  // force:true — copre il caso in cui un creator abbia cambiato foto.
  async function handleAvatarSync() {
    setBusy(true);
    setError(null);
    try {
      const r = await syncChannelAvatars(forceAvatars);
      setNotice(
        `Foto canali: ${r.fetchedCount} scaricate, ${r.skippedCount} già presenti` +
        (r.failedCount ? `, ${r.failedCount} non trovate.` : '.')
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Sorgenti</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {sources?.length > 0 && (
            <button className="btn" disabled={busy} onClick={() => handleSync(undefined)}>
              <RefreshCw size={14} />Sincronizza tutte
            </button>
          )}
          <button className="btn" disabled={busy} onClick={handleAvatarSync}>
            <ImageIcon size={14} />Sincronizza foto canali
          </button>
        </div>
      </div>

      <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20 }}>
        <input type="checkbox" checked={forceAvatars} onChange={(e) => setForceAvatars(e.target.checked)} />
        Aggiorna anche le foto già presenti (un creator ha cambiato foto profilo)
      </label>

      <form className="form-row" onSubmit={handleAdd} style={{ marginBottom: 20 }}>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <label>Aggiungi fonte (URL playlist YouTube)</label>
          <input
            placeholder="https://www.youtube.com/playlist?list=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          <Plus size={14} />Aggiungi
        </button>
      </form>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      {sources === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : sources.length === 0 ? (
        <div className="empty-state">Nessuna fonte configurata.</div>
      ) : (
        sources.map((s) => (
          <div key={s.id} className="source-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{s.name}</div>
              <div className="url">{s.url}</div>
            </div>
            <div className="count">{s.videoCount} video</div>
            <div className="actions">
              <button className="btn small" disabled={busy} onClick={() => handleSync(s.id)}><RefreshCw size={13} /></button>
              <button className="btn small btn-danger" onClick={() => handleRemove(s)}><Trash2 size={13} /></button>
            </div>
          </div>
        ))
      )}
    </>
  );
}
