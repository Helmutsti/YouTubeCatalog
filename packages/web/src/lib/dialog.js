// Alert/confirm in stile app (stesso modale di "Vuoi tenere il video?",
// `.modal-overlay`/`.modal`) al posto dei popup nativi del browser. Stesso
// pattern a singleton di toast.js: un solo <DialogHost/> montato in Layout,
// funzioni imperative che restituiscono una Promise (come window.confirm, ma
// non bloccante e risolta dal click dell'utente sul modale React).
let setState = null;

export function registerDialogHost(setter) {
  setState = setter;
}

function open(config) {
  return new Promise((resolve) => {
    if (!setState) { resolve(config.type === 'confirm' ? false : undefined); return; }
    setState({ ...config, resolve });
  });
}

// Sostituisce window.confirm(message): risolve true/false in base al pulsante cliccato.
export function confirmDialog({ title, message, confirmLabel = 'Conferma', cancelLabel = 'Annulla', danger = false }) {
  return open({ type: 'confirm', title, message, confirmLabel, cancelLabel, danger });
}

// Sostituisce window.alert(message): risolve (senza valore) alla chiusura.
export function alertDialog({ title = 'Errore', message, okLabel = 'OK' }) {
  return open({ type: 'alert', title, message, okLabel });
}
