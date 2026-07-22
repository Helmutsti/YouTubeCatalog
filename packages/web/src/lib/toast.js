// Notifiche a scomparsa (toast), in alto a destra. Store minimale a singleton
// (un solo <ToastHost/> montato una volta in Layout, persiste tra le pagine)
// invece di Context/Redux: coerente con lo stile del progetto, niente stato
// globale altrove.
let setToasts = null;
let counter = 0;

export function registerToastHost(setter) {
  setToasts = setter;
}

// type: 'info' | 'success' | 'error' — colora il bordo/icona del toast.
export function showToast(message, type = 'info', durationMs = 3500) {
  if (!setToasts) return;
  const id = ++counter;
  setToasts((prev) => [...prev, { id, message, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, durationMs);
}
