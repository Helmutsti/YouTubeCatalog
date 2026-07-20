import { useEffect, useState } from 'react';
import { FolderTree } from 'lucide-react';
import { reorganizeLibrary } from '../api/client.js';

// Equivalente di "Riorganizza libreria (per creator)" nel CLI: dry-run
// automatico all'apertura (piano di sola lettura), poi conferma esplicita
// prima di spostare davvero i file su disco.
export function LibraryPage() {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function loadPlan() {
    setError(null);
    setResult(null);
    reorganizeLibrary(true).then(setPlan).catch((e) => setError(e.message));
  }
  useEffect(loadPlan, []);

  async function handleExecute() {
    if (!window.confirm(`Spostare ${plan.planned.length} file ora?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await reorganizeLibrary(false);
      setResult(r);
      loadPlan();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Riorganizza libreria</h1></div>
      <p className="card-meta" style={{ marginBottom: 20, maxWidth: 640 }}>
        Sposta i video scaricati nel layout canonico <code>media/videos/&lt;Creator&gt;/&lt;Titolo&gt; [id].ext</code>,
        così l'archivio è consultabile da Esplora File. Idempotente: i video già a posto vengono saltati.
      </p>

      {error && <div className="notice error">{error}</div>}
      {result && (
        <div className="notice success">
          Spostati {result.moved} file · {result.alreadyOk} già a posto
          {result.missing.length > 0 && ` · ${result.missing.length} non trovati su disco`}.
        </div>
      )}

      {!plan ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : (
        <>
          <div className="banner-cta">
            <div className="label">
              <b>{plan.planned.length}</b> da spostare · {plan.alreadyOk} già a posto
              {plan.missing.length > 0 && <> · <b>{plan.missing.length}</b> non trovati su disco</>}
            </div>
            <button className="btn btn-primary" disabled={busy || plan.planned.length === 0} onClick={handleExecute}>
              <FolderTree size={14} />Sposta {plan.planned.length} file ora
            </button>
          </div>

          {plan.planned.length > 0 && (
            <div className="list">
              {plan.planned.map((m) => (
                <div key={m.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                  <div className="card-meta">{m.from}</div>
                  <div className="card-meta" style={{ color: 'var(--ink2)' }}>→ {m.to}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
