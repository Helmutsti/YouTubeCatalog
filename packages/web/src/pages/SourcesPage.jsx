import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ImageIcon, ChevronDown } from 'lucide-react';
import { listSources, removeSource, syncSources, syncChannelAvatars, getJob, triggerJob } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';
import { useTitle } from '../hooks/useTitle.js';
import { JobHistory } from '../components/JobHistory.jsx';
import { showToast } from '../lib/toast.js';
import { confirmDialog } from '../lib/dialog.js';
import { startDownload } from '../lib/downloadActions.js';

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
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
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
    setSourcesOpen(true); // il progresso per riga vive dentro l'accordion: aprilo
    setActiveSyncId(sourceId);
    setPhase('enumerating');
    setActiveJobId(null);
    setRowErrors((p) => { const n = { ...p }; delete n[sourceId]; return n; });
    const sourceName = sources?.find((s) => s.id === sourceId)?.name ?? sourceId;
    showToast(`Sincronizzazione di "${sourceName}" avviata…`, 'info');
    try {
      const { results: r, jobId } = await syncSources(sourceId);
      if (r?.[sourceId]) setResults((p) => ({ ...p, [sourceId]: r[sourceId] }));
      if (jobId) {
        setActiveJobId(jobId);
        setPhase('enriching');
        const job = await waitForJobTerminal(jobId);
        setJobRefreshKey((k) => k + 1);
        if (job.status === 'failed') {
          showToast(`Sincronizzazione di "${sourceName}" fallita: ${job.error?.message ?? 'errore sconosciuto'}`, 'error');
        } else {
          showToast(`"${sourceName}" sincronizzata: ${summaryLine(r?.[sourceId] ?? {})}`, 'success');
        }
      } else if (r?.[sourceId]) {
        showToast(`"${sourceName}" sincronizzata: ${summaryLine(r[sourceId])}`, 'success');
      }
    } catch (e) {
      setRowErrors((p) => ({ ...p, [sourceId]: e.message }));
      showToast(`Sincronizzazione di "${sourceName}" fallita: ${e.message}`, 'error');
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

  // Aggiunta "istantanea" (M39): l'intera operazione (risoluzione yt-dlp +
  // registrazione + metadati, MAI il video) gira come un job in coda — così il
  // campo si libera subito e si può accodare un'aggiunta dopo l'altra; partono
  // in differita, in ordine (il jobManager è single-worker, mai in parallelo).
  // L'esito compare come nuovo item nella Cronologia sotto, non qui in pagina.
  async function handleAdd(e) {
    e.preventDefault();
    const input = url.trim();
    if (!input) return;
    setUrl('');
    setError(null);
    try {
      await triggerJob(looksLikePlaylist(input) ? 'addSource' : 'addVideo', { url: input });
      setJobRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e.message);
    }
  }

  // Un job addSource appena concluso ha registrato una nuova fonte: ricarica
  // l'elenco sopra così compare senza dover cambiare pagina.
  function handleJobSettled(job) {
    if (job.type === 'addSource') reload();
  }

  // Tasto rapido "Scarica" su un item "aggiunto alla libreria" (M40): si è già
  // su Sorgenti, quindi nessuna navigazione — il nuovo job compare da solo
  // come item a sé in cima alla Cronologia. Passa da startDownload (M55) così
  // anche questo download by-id ottiene il confirm "elimina e ri-scarica" e la
  // scelta audio, invece di avviare downloadSingle alla cieca e sovrascrivere.
  async function handleQuickDownload(videoId) {
    await startDownload(videoId, { triggerJob, onSettled: () => setJobRefreshKey((k) => k + 1) });
  }

  async function handleRemove(source) {
    const ok = await confirmDialog({
      title: 'Rimuovere la fonte?',
      message: `Rimuovere "${source.name}"? I video già scaricati non verranno toccati.`,
      confirmLabel: 'Rimuovi',
      danger: true
    });
    if (!ok) return;
    try {
      await removeSource(source.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  // Aggiorna solo i creator che NON hanno ancora una foto (mai "force" da qui):
  // un creator nuovo la prende già in automatico alla creazione; forzare il
  // refresh di una foto già presente è un'azione sul singolo creator, da
  // spostare sulla sua pagina (fuori scope di questa pagina).
  async function handleAvatarSync() {
    setBusy(true);
    setError(null);
    showToast('Aggiornamento foto creator avviato…', 'info');
    try {
      const r = await syncChannelAvatars(false);
      const outcome = `Foto creator: ${r.fetchedCount} scaricate, ${r.skippedCount} già presenti` +
        (r.failedCount ? `, ${r.failedCount} non trovate.` : '.');
      setNotice(outcome);
      showToast(outcome, r.failedCount ? 'error' : 'success');
    } catch (e) {
      setError(e.message);
      showToast(`Aggiornamento foto creator fallito: ${e.message}`, 'error');
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
    // backlog #4: avvisa se YouTube dichiara più video di quanti enumerati
    // (alcuni non visibili ora: privati/rimossi/glitch — riprova la sync).
    if (r.missingCount > 0) {
      parts.push(`⚠ enumerati ${r.enumeratedCount} su ${r.declaredCount} — ${r.missingCount} non visibili ora`);
    }
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

      <div className="add-panel">
        <div className="add-eyebrow">Aggiungi playlist o singolo video</div>
        <form className="add-row" onSubmit={handleAdd}>
          <input
            placeholder="Incolla una playlist YouTube, oppure un link/id di un singolo video (anche Rumble…)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            <Plus size={14} />Aggiungi
          </button>
        </form>
        <div className="add-hint">Playlist → nuova sorgente · singolo video → aggiunto alla libreria. Solo metadati: il video si scarica dopo, dalla scheda.</div>
      </div>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      {sources === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : sources.length === 0 ? (
        <div className="empty-state">Nessuna fonte configurata.</div>
      ) : (
        <>
          <button className="sources-toggle" onClick={() => setSourcesOpen((o) => !o)}>
            <span className="eyebrow">Fonti registrate · {sources.length}</span>
            <ChevronDown size={16} className={`chev${sourcesOpen ? ' open' : ''}`} />
          </button>

          {!sourcesOpen ? (
            <div className="sources-summary">{sources.length} fonti — clicca per espandere l'elenco.</div>
          ) : (
            <div className="sources-panel">
              {sources.map((s) => {
                const active = activeSyncId === s.id;
                const r = results[s.id];
                const rowErr = rowErrors[s.id];
                return (
                  <div key={s.id} className="source-line-wrap">
                    <div className="source-line">
                      <div className="source-line-main">
                        <div className="name">{s.name}</div>
                        <div className="url">{s.url}</div>
                      </div>
                      <div className="count">{s.videoCount} video</div>
                      <div className="actions">
                        <button className="icon-btn" disabled={busy || syncing} onClick={() => syncOne(s.id)} title="Sincronizza">
                          <RefreshCw size={14} className={active ? 'spin' : undefined} />
                        </button>
                        <button className="icon-btn icon-btn-danger" disabled={syncing} onClick={() => handleRemove(s)} title="Rimuovi fonte">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {active && (
                      <div className="source-line-progress">
                        <div className="hint" style={{ marginBottom: 6 }}>
                          {phase === 'enriching' ? 'Arricchimento metadati e copertine…' : 'Sincronizzazione in corso…'}
                        </div>
                        <div className={`progress-bar${phase === 'enriching' ? '' : ' indeterminate'}`}>
                          <div style={phase === 'enriching' ? { width: `${live.progress ?? 0}%` } : undefined}></div>
                        </div>
                      </div>
                    )}

                    {!active && r && <div className="source-line-result">✓ {summaryLine(r)}</div>}
                    {!active && rowErr && <div className="source-line-result err">✘ {rowErr}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <JobHistory refreshKey={String(jobRefreshKey)} onJobSettled={handleJobSettled} onQuickDownload={handleQuickDownload} />
    </>
  );
}
