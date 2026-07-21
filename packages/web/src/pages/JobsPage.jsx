import { useSearchParams } from 'react-router-dom';
import { useJobStream } from '../hooks/useJobStream.js';
import { JobHistory } from '../components/JobHistory.jsx';

const JOB_STATUS_LABEL = { queued: 'In coda', running: 'In corso', success: 'Completato', failed: 'Fallito' };
const JOB_STATUS_COLOR = {
  queued: 'var(--st-pending)',
  running: 'var(--st-downloading)',
  success: 'var(--st-downloaded)',
  failed: 'var(--st-failed)'
};

// Job in corso: log/progresso in tempo reale via SSE (stesso EventEmitter a
// cui il CLI si iscrive in-process). Storico: componente condiviso JobHistory
// (snapshot persistito, con cancellazione). Il job evidenziato è escluso dallo
// storico finché è "in corso" (mostrato nella card live sopra); quando termina,
// il cambio di `live.status` fa ricaricare lo storico.
export function JobsPage() {
  const [params] = useSearchParams();
  const highlight = params.get('highlight');
  const live = useJobStream(highlight);

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

      <JobHistory excludeId={highlight} refreshKey={live.status} />
    </>
  );
}
