import { useEffect, useState } from 'react';
import { registerToastHost } from '../lib/toast.js';

// Contenitore delle notifiche a scomparsa, montato una sola volta in Layout
// così resta visibile durante la navigazione tra pagine.
export function ToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    registerToastHost(setToasts);
    return () => registerToastHost(null);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}${t.onClick ? ' clickable' : ''}`}
          onClick={t.onClick}
          role={t.onClick ? 'button' : undefined}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
