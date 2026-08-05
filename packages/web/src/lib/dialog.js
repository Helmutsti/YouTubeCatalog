// Alert/confirm in stile app (stesso modale di "Vuoi tenere il video?",
// `.modal-overlay`/`.modal`) al posto dei popup nativi del browser. Stesso
// pattern a singleton di toast.js: un solo <DialogHost/> montato in Layout,
// funzioni imperative che restituiscono una Promise (come window.confirm, ma
// non bloccante e risolta dal click dell'utente sul modale React).
//
// Stato su `globalThis` invece che in una `let` di modulo, per lo stesso
// motivo di toast.js: sopravvive alla duplicazione del modulo sotto Vite HMR
// (nessun impatto in produzione, build unica).
const STATE = (globalThis.__ondoDialogState ??= { setState: null });

export function registerDialogHost(setter) {
  STATE.setState = setter;
}

function open(config) {
  return new Promise((resolve) => {
    // Valore "annullato" coerente col tipo se nessun host è montato (es. HMR a
    // metà): false per il confirm, null per la scelta multipla, undefined per l'alert.
    if (!STATE.setState) {
      resolve(config.type === 'confirm' ? false : (config.type === 'choice' || config.type === 'radio') ? null : undefined);
      return;
    }
    STATE.setState({ ...config, resolve });
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

// Scelta fra più opzioni (M55, es. strategia audio A/B): risolve col `value`
// dell'opzione scelta, oppure null se l'utente annulla. `options` è un array di
// { value, label, description? }; ogni opzione è un pulsante nel modale.
export function choiceDialog({ title, message, options, cancelLabel = 'Annulla' }) {
  return open({ type: 'choice', title, message, options, cancelLabel });
}

// Scelta singola a radio button + conferma (M56, es. risoluzione di download):
// a differenza di choiceDialog (un click = scelta immediata), qui si seleziona
// un'opzione e poi si conferma. `options` = { value, label }[]; `defaultValue`
// preseleziona. Risolve col value scelto, o null se annullato.
export function radioDialog({ title, message, options, defaultValue, confirmLabel = 'Scarica', cancelLabel = 'Annulla' }) {
  return open({ type: 'radio', title, message, options, defaultValue, confirmLabel, cancelLabel });
}
