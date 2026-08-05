// Azioni per-video derivate dai flag ortogonali (M25). Un solo posto, riusato
// da card in griglia, dettaglio e ricerca. Ogni azione ha un `kind` che la
// pagina traduce nella chiamata API giusta:
//   'download' → triggerJob('downloadSingle', { videoId })
//   'hide'/'unhide' → setHidden(id, true/false)
export function actionsFor(video) {
  if (video.download === 'downloading') return []; // già in corso: nessuna azione
  const actions = [];
  if (video.download !== 'downloaded') {
    actions.push({ kind: 'download', label: video.download === 'failed' ? 'Riprova' : 'Scarica' });
  }
  actions.push(video.hidden ? { kind: 'unhide', label: 'Mostra' } : { kind: 'hide', label: 'Nascondi' });
  return actions;
}
