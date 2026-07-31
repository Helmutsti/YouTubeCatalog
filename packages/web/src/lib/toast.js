// Notifiche a scomparsa (toast), in alto a destra. Store minimale a singleton
// (un solo <ToastHost/> montato una volta in Layout, persiste tra le pagine)
// invece di Context/Redux: coerente con lo stile del progetto, niente stato
// globale altrove.
//
// Stato appeso a `globalThis` (non una `let` di modulo): un modulo con stato
// singleton in scope proprio si duplica sotto Vite HMR quando questo file (o
// un file che lo importa) viene ricaricato a caldo — ToastHost resterebbe
// registrato sulla vecchia istanza mentre chi chiama showToast() ne
// otterrebbe una nuova, disallineate, e il toast smetterebbe di comparire
// senza errori visibili. `globalThis` è condiviso da tutte le istanze del
// modulo, quindi sopravvive ai ricaricamenti — nessun impatto in produzione
// (build unica, nessun HMR).
const STATE = (globalThis.__ondoToastState ??= { setToasts: null, counter: 0, timers: new Map() });

export function registerToastHost(setter) {
  STATE.setToasts = setter;
}

function scheduleDismiss(id, durationMs) {
  const prev = STATE.timers.get(id);
  if (prev) clearTimeout(prev);
  if (!durationMs) return; // 0/undefined = non sparisce da solo (in attesa di un esito)
  STATE.timers.set(id, setTimeout(() => dismissToast(id), durationMs));
}

// type: 'info' | 'success' | 'error'. durationMs: 0 = resta finché non viene
// aggiornato/chiuso esplicitamente (usato per "avviato…" in attesa di esito).
// onClick (opzionale): rende il toast cliccabile (es. porta a Sorgenti dove il
// job è comunque visibile in Cronologia) — resta invariato quando il toast
// viene poi aggiornato con updateToast() (il patch non lo tocca).
// Ritorna l'id del toast, da passare a updateToast() per farlo "diventare"
// verde/rosso in base al risultato di un'operazione, invece di aprirne uno nuovo.
export function showToast(message, type = 'info', durationMs = 3500, onClick) {
  if (!STATE.setToasts) return null;
  const id = ++STATE.counter;
  STATE.setToasts((prev) => [...prev, { id, message, type, onClick }]);
  scheduleDismiss(id, durationMs);
  return id;
}

export function updateToast(id, patch, durationMs = 4000) {
  if (!STATE.setToasts || id == null) return;
  STATE.setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  scheduleDismiss(id, durationMs);
}

export function dismissToast(id) {
  if (!STATE.setToasts) return;
  const t = STATE.timers.get(id);
  if (t) { clearTimeout(t); STATE.timers.delete(id); }
  STATE.setToasts((prev) => prev.filter((x) => x.id !== id));
}
