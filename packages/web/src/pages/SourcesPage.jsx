import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ImageIcon } from 'lucide-react';
import { listSources, addSource, removeSource, syncSources, syncChannelAvatars, getJob } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';

export function SourcesPage() {
  const [sources, setSources] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false); // aggiunta fonte / foto creator (globali)
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forceAvatars, setForceAvatars] = useState(false);

  // Sincronizzazione contestuale alla sorgente (una per volta): barra ed esito
  // vivono sulla riga della fonte in lavorazione.
  const [activeSyncId, setActiveSyncId] = useState(null);
  const [phase, setPhase] = useState(null); // 'enumerating' | 'enriching'
  const [activeJobId, setActiveJobId] = useState(null);
  const [results, setResults] = useState({}); // { [sourceId]: {newCount, removedCount, restoredCount, healedCount} }
  const [rowErrors, setRowErrors] = useState({}); // { [sourceId]: message }
  const live = useJobStream(activeJobId);

  function reload() {
    return listSources().then((s) => { setSources(s); return s; }).catch((e) => setError(e.message));
  }
  useEffect(() => { reload(); }, []);

  // Attende che un job raggiunga uno stato terminale (getJob espone lo status;
  // la percentuale live arriva invece da useJobStream, che aggiorna la barra).
  function waitForJobTerminal(jobId) {
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const j = await getJob(jobId);
          if (j && (j.status === 'success' || j.status === 'failed')) return resolve(j);
        } catch { /* riprova */ }
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  // Sincronizza UNA sorgente: fase 1 (enumerazione, barra indeterminata) + fase 2
  // (arricchimento, barra a %). Aggiorna esito/errore della sua riga.
  async function syncOne(sourceId) {
    setActiveSyncId(sourceId);
    setPhase('enumerating');
    setActiveJobId(null);
    setRowErrors((p) => { const n = { ...p }; delete n[sourceId]; return n; });
    try {
      const { results: r, jobId } = await syncSources(sourceId);
      if (r?.[sourceId]) setResults((p) => ({ ...p, [sourceId]: r[sourceId] }));
      if (jobId) {
        setActiveJobId(jobId);
        setPhase('enriching');
        await waitForJobTerminal(jobId);
      }
    } catch (e) {
      setRowErrors((p) => ({ ...p, [sourceId]: e.message }));
    } finally {
      setActiveJobId(null);
      setPhase(null);
      setActiveSyncId(null);
      await reload(); // aggiorna il conteggio video della fonte
    }
  }

  async function handleSyncAll() {
    setError(null);
    const list = sources ?? [];
    for (const s of list) {
      await syncOne(s.id); // sequenziale: una barra per volta, sulla riga attiva
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await addSource(url.trim());
      setUrl('');
      if (result.alreadyExists) {
        setNotice(`Fonte già presente: "${result.name}".`);
        return;
      }
      // Fai comparire la nuova riga, poi mostra l'arricchimento su di essa.
      await reload();
      setResults((p) => ({ ...p, [result.sourceId]: { newCount: result.newCount ?? 0, removedCount: 0, restoredCount: 0, healedCount: 0 } }));
      if (result.jobId) {
        setActiveSyncId(result.sourceId);
        setPhase('enriching');
        setActiveJobId(result.jobId);
        await waitForJobTerminal(result.jobId);
        setActiveJobId(null);
        setPhase(null);
        setActiveSyncId(null);
        await reload();
      }
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

  async function handleAvatarSync() {
    setBusy(true);
    setError(null);
    try {
      const r = await syncChannelAvatars(forceAvatars);
      setNotice(
        `Foto creator: ${r.fetchedCount} scaricate, ${r.skippedCount} già presenti` +
        (r.failedCount ? `, ${r.failedCount} non trovate.` : '.')
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const syncing = activeSyncId !== null;

  function summaryLine(r) {
    const parts = [`${r.newCount} nuovi`];
    if (r.removedCount) parts.push(`${r.removedCount} rimossi`);
    if (r.restoredCount) parts.push(`${r.restoredCount} ricomparsi`);
    if (r.healedCount) parts.push(`${r.healedCount} riparati`);
    return parts.join(' · ');
  }

  return (
    <>
      <div className="page-head">
        <h1>Sorgenti</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {sources?.length > 0 && (
            <button className="btn" disabled={busy || syncing} onClick={handleSyncAll}>
              <RefreshCw size={14} className={syncing ? 'spin' : undefined} />Sincronizza tutte
            </button>
          )}
          <button className="btn" disabled={busy || syncing} onClick={handleAvatarSync}>
            <ImageIcon size={14} />Sincronizza foto creator
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
        <button className="btn btn-primary" type="submit" disabled={busy || syncing}>
          {busy ? <span className="spinner"></span> : <><Plus size={14} />Aggiungi</>}
        </button>
      </form>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      {sources === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : sources.length === 0 ? (
        <div className="empty-state">Nessuna fonte configurata.</div>
      ) : (
        sources.map((s) => {
          const active = activeSyncId === s.id;
          const r = results[s.id];
          const rowErr = rowErrors[s.id];
          return (
            <div key={s.id} className="source-block">
              <div className="source-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{s.name}</div>
                  <div className="url">{s.url}</div>
                </div>
                <div className="count">{s.videoCount} video</div>
                <div className="actions">
                  <button className="btn small" disabled={busy || syncing} onClick={() => syncOne(s.id)}>
                    <RefreshCw size={13} className={active ? 'spin' : undefined} />
                  </button>
                  <button className="btn small btn-danger" disabled={syncing} onClick={() => handleRemove(s)}><Trash2 size={13} /></button>
                </div>
              </div>

              {active && (
                <div style={{ marginTop: 8 }}>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    {phase === 'enriching' ? 'Arricchimento metadati e copertine…' : 'Sincronizzazione in corso…'}
                  </div>
                  <div className={`progress-bar${phase === 'enriching' ? '' : ' indeterminate'}`}>
                    <div style={phase === 'enriching' ? { width: `${live.progress ?? 0}%` } : undefined}></div>
                  </div>
                </div>
              )}

              {!active && r && <div className="source-result">✓ {summaryLine(r)}</div>}
              {!active && rowErr && <div className="source-result err">✘ {rowErr}</div>}
            </div>
          );
        })
      )}
    </>
  );
}
