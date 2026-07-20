import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listJobs } from '../api/client.js';
import { useJobStream } from '../hooks/useJobStream.js';

const JOB_TYPE_LABEL = { downloadPending: 'Scarica in coda', downloadSingle: 'Scarica video singolo' };
const JOB_STATUS_LABEL = { queued: 'In coda', running: 'In corso', success: 'Completato', failed: 'Fallito' };
const JOB_STATUS_COLOR = {
  queued: 'var(--st-pending)',
  running: 'var(--st-downloading)',
  success: 'var(--st-downloaded)',
  failed: 'var(--st-failed)'
};

// Job in corso: log/progresso in tempo reale via SSE (stesso EventEmitter a
// cui il CLI si iscrive in-process). Storico: snapshot già persistito da
// jobManager, nessuno stream necessario.
export function JobsPage() {
  const [params] = useSearchParams();
  const highlight = params.get('highlight');
  const [jobs, setJobs] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const live = useJobStream(highlight);

  function reload() {
    listJobs().then(setJobs).catch(() => {});
  }
  useEffect(reload, []);

  useEffect(() => {
    if (live.status === 'success' || live.status === 'failed') reload();
  }, [live.status]);

  const history = (jobs ?? []).filter((j) => j.id !== highlight);

  return (
    <>
      <div className="page-head"><h1>Job</h1></div>

      {highlight && (
        <div className="job-card">
          <div className="job-card-head">
            <span className="job-status" style={{ background: JOB_STATUS_COLOR[live.status] ?? 'var(--faint)' }}>
              {JOB_STATUS_LABEL[live.status] ?? 'connessione…'}
            </span>
            <span className="job-type">Job in corso</span>
          </div>
          {live.progress != null && (
            <div className="progress-bar" style={{ marginBottom: 12 }}>
              <div style={{ width: `${live.progress}%` }}></div>
            </div>
          )}
          <div className="job-log">
            {live.logLines.length === 0
              ? <div className="line">In attesa di output…</div>
              : live.logLines.map((line, i) => <div key={i} className="line">{line}</div>)}
          </div>
        </div>
      )}

      <div className="side-sec" style={{ padding: '0 0 10px' }}>Storico</div>
      {jobs === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : history.length === 0 ? (
        <div className="empty-state">Nessun job eseguito finora.</div>
      ) : (
        history.map((j) => (
          <div key={j.id} className="job-card">
            <div className="job-card-head" style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
              <span className="job-status" style={{ background: JOB_STATUS_COLOR[j.status] ?? 'var(--faint)' }}>
                {JOB_STATUS_LABEL[j.status] ?? j.status}
              </span>
              <span className="job-type">{JOB_TYPE_LABEL[j.type] ?? j.type}</span>
              <span className="job-time">{j.startedAt ? new Date(j.startedAt).toLocaleString('it-IT') : ''}</span>
            </div>
            {expanded === j.id && (
              <div className="job-log">
                {j.logLines.map((line, i) => <div key={i} className="line">{line}</div>)}
                {j.error && <div className="line err">{j.error.message}</div>}
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}
