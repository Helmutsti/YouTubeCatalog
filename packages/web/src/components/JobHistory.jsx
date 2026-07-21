import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { listJobs, deleteJob, clearJobs } from '../api/client.js';

const JOB_TYPE_LABEL = { downloadPending: 'Scarica in coda', downloadSingle: 'Scarica video singolo' };
const JOB_STATUS_LABEL = { queued: 'In coda', running: 'In corso', success: 'Completato', failed: 'Fallito' };
const JOB_STATUS_COLOR = {
  queued: 'var(--st-pending)',
  running: 'var(--st-downloading)',
  success: 'var(--st-downloaded)',
  failed: 'var(--st-failed)'
};

const isTerminal = (j) => j.status === 'success' || j.status === 'failed';

// Storico dei job, condiviso da JobsPage e HistoryPage. Snapshot già
// persistito da jobManager (nessuno stream necessario). Cancellazione: solo il
// record storico (il video/i file su disco restano); i job in corso/in coda
// non sono cancellabili (nessun abort possibile), quindi il pulsante compare
// solo sui terminati. `refreshKey` fa ricaricare la lista quando il chiamante
// segnala un cambiamento (es. un nuovo job appena avviato o completato).
export function JobHistory({ excludeId, refreshKey }) {
  const [jobs, setJobs] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    listJobs().then(setJobs).catch(() => {});
  }
  useEffect(reload, [refreshKey]);

  const history = (jobs ?? []).filter((j) => j.id !== excludeId);
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
        history.map((j) => {
          const cover = j.thumbnails?.[0] ?? null;
          const title = j.title ?? JOB_TYPE_LABEL[j.type] ?? j.type;
          const isOpen = expanded === j.id;
          return (
            <div key={j.id} className="job-card job-hist">
              <div className="job-hist-row">
                <div className={`job-hist-cover${cover ? '' : ' empty'}`}>
                  {cover ? <img src={cover} alt="" loading="lazy" /> : <span>nessuna copertina</span>}
                </div>
                <div className="job-hist-body" onClick={() => setExpanded(isOpen ? null : j.id)}>
                  <div className="job-hist-title">{title}</div>
                  <div className="job-hist-meta">
                    <span className="job-status" style={{ background: JOB_STATUS_COLOR[j.status] ?? 'var(--faint)' }}>
                      {JOB_STATUS_LABEL[j.status] ?? j.status}
                    </span>
                    <span className="job-time" style={{ marginLeft: 0 }}>
                      {j.startedAt ? new Date(j.startedAt).toLocaleString('it-IT') : ''}
                    </span>
                    {j.thumbnailsMore > 0 && <span className="job-hist-more">+{j.thumbnailsMore} altri</span>}
                  </div>
                </div>
                {isTerminal(j) && (
                  <button className="job-del" title="Cancella dallo storico" disabled={busy} onClick={(e) => handleDelete(j.id, e)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="job-log" style={{ margin: '0 16px 14px' }}>
                  {j.logLines.map((line, i) => <div key={i} className="line">{line}</div>)}
                  {j.error && <div className="line err">{j.error.message}</div>}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
