// Riferimento condiviso alla funzione `navigate` di react-router, registrato
// da Layout (sempre montato, ha già `useNavigate()`) così codice imperativo
// fuori da un componente (es. il click su un toast) può navigare senza dover
// passare `navigate` a mano attraverso ogni funzione di libreria.
// Stato su `globalThis`, stesso motivo di toast.js/dialog.js: sopravvive alla
// duplicazione del modulo sotto Vite HMR (nessun impatto in produzione).
const STATE = (globalThis.__ondoNavState ??= { navigate: null });

export function registerNavigate(fn) {
  STATE.navigate = fn;
}

export function appNavigate(path) {
  STATE.navigate?.(path);
}
