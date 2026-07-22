import { useEffect, useState } from 'react';
import { Trash2, Download } from 'lucide-react';
import { listJobs, deleteJob, clearJobs } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';

const JOB_TYPE_LABEL = {
  downloadPending: 'Scarica in coda',
  downloadSingle: 'Scarica video singolo',
  addSource: 'Nuova sorgente',
  addVideo: 'Nuovo video'
};
const JOB_STATUS_LABEL = { queued: 'In coda', running: 'In corso', success: 'Completato', failed: 'Fallito' };
const JOB_STATUS_COLOR = {
  queued: 'var(--st-pending)',
  running: 'var(--st-downloading)',
  success: 'var(--st-downloaded)',
  failed: 'var(--st-failed)'
};
const ADD_VIDEO_ACTION_LABEL = {
  added: 'aggiunto alla libreria',
  'already-present': 'già in libreria',
  'already-downloaded': 'già scaricato',
  'already-downloading': 'già in download'
};

const isTerminal = (j) => j.status === 'success' || j.status === 'failed';
const isLive = (j) => j.status === 'queued' || j.status === 'running';

// Riga di esito mostrata DENTRO l'item (M39: mai una notice a livello pagina),
// solo per i tipi che aggiungono qualcosa alla libreria — gli altri tipi
// restano con la sola pillola di stato, comportamento invariato.
function outcomeText(job) {
  const s = job.summary;
  if (!s || job.status !== 'success') return null;
  if (job.type === 'addSource') {
    if (s.alreadyExists) return `Fonte già presente: "${s.name}".`;
    const parts = [`${s.newCount} nuovi`];
    if (s.enriched) parts.push(`${s.enriched} arricchiti`);
    if (s.failed) parts.push(`${s.failed} metadati falliti`);
    if (s.removed) parts.push(`${s.removed} privati (segnati "Rimosso")`);
    return `"${s.name}" — ${parts.join(' · ')}.`;
  }
  if (job.type === 'addVideo') {
    return `"${s.title ?? s.videoId}" ${ADD_VIDEO_ACTION_LABEL[s.action] ?? s.action}.`;
  }
  // downloadSingle (M40): niente più terminale/pagina dedicata — solo l'esito
  // minimo dentro l'item, il dettaglio resta comunque nel log espandibile.
  if (job.type === 'downloadSingle') return 'Video scaricato.';
  return null;
}

// Un video "aggiunto alla libreria" (addVideo, mai scaricato) può avviare il
// download direttamente da qui, senza tornare alla scheda video (M40).
function canQuickDownload(job) {
  return job.type === 'addVideo' && job.status === 'success' && job.summary?.action === 'added';
}

// Storico dei job, unica consumatrice SourcesPage (M40: la vecchia JobsPage è
// stata rimossa). Snapshot persistito da jobManager, riletto a ogni
// `refreshKey`. Un job ancora in coda/in corso si iscrive live via SSE
// (JobHistoryRow) così l'item mostra il progresso reale invece di restare
// fermo sulla pillola "In coda" finché non lo si ricarica a mano — a fine job
// `onSettled` ricarica lo storico (per il summary definitivo) e avvisa il
// chiamante (es. SourcesPage deve ricaricare l'elenco fonti). `onQuickDownload`
// avvia un download direttamente da un item "aggiunto alla libreria".
export function JobHistory({ excludeId, refreshKey, onJobSettled, onQuickDownload }) {
  const [jobs, setJobs] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    listJobs().then(setJobs).catch(() => {});
  }
  useEffect(reload, [refreshKey]);

  // Solo job di DOWNLOAD/AGGIUNTA: gli enrichSource lanciati da "Sincronizza"
  // (arricchimento di una fonte già esistente) restano job di servizio in
  // background, fuori dalla cronologia — invariato da M31. addSource/addVideo
  // invece SONO la cronologia (M39): non sono filtrati.
  const history = (jobs ?? []).filter((j) => j.id !== excludeId && j.type !== 'enrichSource');
  const deletableCount = history.filter(isTerminal).length;

  async function handleDelete(id, e) {
    e.stopPropagation();
    setBusy(true);
    try {
      await deleteJob(id);
      reload();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (!window.confirm(`Svuotare lo storico? Verranno cancellati ${deletableCount} job terminati. I video scaricati restano.`)) return;
    setBusy(true);
    try {
      await clearJobs();
      reload();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleSettled(job) {
    reload();
    onJobSettled?.(job);
  }

  return (
    <>
      <div className="side-sec hist-head" style={{ padding: '0 0 10px' }}>
        <span>Storico</span>
        {deletableCount > 0 && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handleClear}>
            <Trash2 size={13} />Svuota storico
          </button>
        )}
      </div>

      {jobs === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : history.length === 0 ? (
        <div className="empty-state">Nessun job eseguito finora.</div>
      ) : (
        history.map((j) => (
          <JobHistoryRow
            key={j.id}
            job={j}
            isOpen={expanded === j.id}
            onToggle={() => setExpanded((cur) => (cur === j.id ? null : j.id))}
            onDelete={(e) => handleDelete(j.id, e)}
            busy={busy}
            onSettled={handleSettled}
            onQuickDownload={onQuickDownload}
          />
        ))
      )}
    </>
  );
}

function JobHistoryRow({ job, isOpen, onToggle, onDelete, busy, onSettled, onQuickDownload }) {
  const live = useJobStream(isLive(job) ? job.id : null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (live.status === 'success' || live.status === 'failed') onSettled(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.status]);

  const status = live.status ?? job.status;
  const cover = job.thumbnails?.[0] ?? null;
  const title = job.title ?? JOB_TYPE_LABEL[job.type] ?? job.type;
  const outcome = outcomeText(job);
  const liveNow = isLive(job); // ancora in coda/corso secondo lo snapshot statico
  const timeSource = job.startedAt ?? job.queuedAt;
  const quickDownload = canQuickDownload(job) && onQuickDownload;

  async function handleQuickDownload() {
    setStarting(true);
    try {
      await onQuickDownload(job.summary.videoId);
    } finally {
      // Non serve resettare a false: appena parte, il nuovo job compare come
      // item a sé in cima alla lista — questo pulsante non ha più senso finché
      // esiste (resta disabilitato, coerente con "già avviato").
    }
  }

  return (
    <div className="job-card job-hist">
      <div className="job-hist-row">
        <div className={`job-hist-cover${cover ? '' : ' empty'}`}>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <span>nessuna copertina</span>}
        </div>
        <div className="job-hist-body" onClick={onToggle}>
          <div className="job-hist-title">{title}</div>
          <div className="job-hist-meta">
            <span className="job-status" style={{ background: JOB_STATUS_COLOR[status] ?? 'var(--faint)' }}>
              {JOB_STATUS_LABEL[status] ?? status}
            </span>
            <span className="job-time" style={{ marginLeft: 0 }}>
              {timeSource ? new Date(timeSource).toLocaleString('it-IT') : ''}
            </span>
            {job.thumbnailsMore > 0 && <span className="job-hist-more">+{job.thumbnailsMore} altri</span>}
          </div>
        </div>
        {isTerminal(job) && !liveNow && (
          <button className="job-del" title="Cancella dallo storico" disabled={busy} onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {liveNow && (
        <div className="job-hist-extra job-hist-progress">
          <div className="job-hist-phase">
            {status === 'queued' ? 'In coda — attende il job precedente…' : (live.logLines.at(-1) ?? 'Avvio…')}
          </div>
          <div className={`progress-bar${live.progress == null ? ' indeterminate' : ''}`}>
            <div style={live.progress != null ? { width: `${live.progress}%` } : undefined}></div>
          </div>
        </div>
      )}

      {!liveNow && (outcome || (job.status === 'failed' && job.error)) && (
        <div className="job-hist-extra">
          <div className="job-hist-outcome-row">
            {outcome && <div className="job-hist-outcome">{outcome}</div>}
            {quickDownload && (
              <button className="btn small" disabled={starting} onClick={handleQuickDownload}>
                <Download size={13} />Scarica
              </button>
            )}
          </div>
          {job.status === 'failed' && job.error && <div className="job-hist-outcome err">{job.error.message}</div>}
        </div>
      )}

      {isOpen && (
        <div className="job-log" style={{ margin: '0 16px 14px' }}>
          {(liveNow ? live.logLines : job.logLines).map((line, i) => <div key={i} className="line">{line}</div>)}
          {job.error && <div className="line err">{job.error.message}</div>}
        </div>
      )}
    </div>
  );
}
