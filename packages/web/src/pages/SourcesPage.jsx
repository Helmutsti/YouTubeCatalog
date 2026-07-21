import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ImageIcon } from 'lucide-react';
import { listSources, addSource, removeSource, syncSources, syncChannelAvatars, getJob, downloadSingle } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';
import { useTitle } from '../hooks/useTitle.js';
import { JobHistory } from '../components/JobHistory.jsx';

// Riconosce se l'input incollato è una PLAYLIST (→ nuova sorgente) o un SINGOLO
// video (→ aggiunto/scaricato). Regola: la presenza di un `list=` (o di
// /playlist?) indica una playlist, ANCHE se l'URL contiene anche `v=` — è il
// caso di watch?v=…&list=…, il link che YouTube mostra mentre si guarda un
// video dentro una playlist. `extractPlaylistId` (core) estrae comunque il
// `list=` da qualunque URL. Per aggiungere un SINGOLO video basta incollare il
// link pulito senza list= (watch?v=…, youtu.be/…, id nudo, altri siti).
function looksLikePlaylist(input) {
  const s = input.trim();
  if (/\/playlist\?/.test(s)) return true;
  if (/[?&]list=/.test(s)) return true;
  return false;
}

export function SourcesPage() {
  const [sources, setSources] = useState(null);
  const [url, setUrl] = useState('');
  const [immediate, setImmediate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forceAvatars, setForceAvatars] = useState(false);
  const [jobRefreshKey, setJobRefreshKey] = useState(0);

  // Sincronizzazione contestuale alla sorgente (una per volta).
  const [activeSyncId, setActiveSyncId] = useState(null);
  const [phase, setPhase] = useState(null); // 'enumerating' | 'enriching'
  const [activeJobId, setActiveJobId] = useState(null);
  const [results, setResults] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  const live = useJobStream(activeJobId);
  useTitle('Sorgenti');

  function reload() {
    return listSources().then((s) => { setSources(s); return s; }).catch((e) => setError(e.message));
  }
  useEffect(() => { reload(); }, []);

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
        setJobRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setRowErrors((p) => ({ ...p, [sourceId]: e.message }));
    } finally {
      setActiveJobId(null);
      setPhase(null);
      setActiveSyncId(null);
      await reload();
    }
  }

  async function handleSyncAll() {
    setError(null);
    for (const s of sources ?? []) await syncOne(s.id);
  }

  async function handleAdd(e) {
    e.preventDefault();
    const input = url.trim();
    if (!input) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (looksLikePlaylist(input)) {
        // Playlist → nuova sorgente + arricchimento (barra sulla riga).
        const result = await addSource(input);
        setUrl('');
        if (result.alreadyExists) { setNotice(`Fonte già presente: "${result.name}".`); return; }
        await reload();
        setResults((p) => ({ ...p, [result.sourceId]: { newCount: result.newCount ?? 0, removedCount: 0, restoredCount: 0, healedCount: 0 } }));
        if (result.jobId) {
          setActiveSyncId(result.sourceId);
          setPhase('enriching');
          setActiveJobId(result.jobId);
          await waitForJobTerminal(result.jobId);
          setJobRefreshKey((k) => k + 1);
          setActiveJobId(null);
          setPhase(null);
          setActiveSyncId(null);
          await reload();
        }
      } else {
        // Singolo video → scaricato subito (se "Download immediato") o solo aggiunto.
        const r = await downloadSingle(input, immediate);
        setUrl('');
        if (r.action === 'download') { setNotice(`"${r.title ?? r.videoId}" — download avviato (vedi cronologia sotto).`); setJobRefreshKey((k) => k + 1); }
        else if (r.action === 'added') setNotice(`"${r.title ?? r.videoId}" aggiunto alla libreria (compare in Home).`);
        else if (r.action === 'already-downloaded') setNotice(`"${r.title ?? r.videoId}" è già in archivio.`);
        else if (r.action === 'already-downloading') setNotice(`"${r.title ?? r.videoId}" è già in download.`);
        else if (r.action === 'already-present') setNotice(`"${r.title ?? r.videoId}" è già in libreria.`);
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

      <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
        <input type="checkbox" checked={forceAvatars} onChange={(e) => setForceAvatars(e.target.checked)} />
        Aggiorna anche le foto già presenti (un creator ha cambiato foto profilo)
      </label>

      <form className="form-row" onSubmit={handleAdd} style={{ marginBottom: 20 }}>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <label>Aggiungi: playlist o singolo video</label>
          <input
            placeholder="Incolla una playlist YouTube, oppure un link/id di un singolo video (anche Rumble…)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="hint">Playlist → nuova sorgente · singolo video → aggiunto o scaricato</div>
        </div>
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
          Download immediato (singoli)
        </label>
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

      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 12px', color: '#fff' }}>Cronologia download</h2>
        <JobHistory refreshKey={String(jobRefreshKey)} />
      </div>
    </>
  );
}
