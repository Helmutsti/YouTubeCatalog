// Stesse transizioni di decisionService.decideVideo, stessa forma di
// REVIEW_ACTIONS_BY_STATUS nel CLI (packages/cli/cli.js) — un solo posto,
// riusato sia dalla card in griglia sia dalla pagina di dettaglio.
export function reviewActionsFor(status) {
  switch (status) {
    case 'new':
      return [
        { decision: 'download', label: 'Scarica' },
        { decision: 'exclude', label: 'Archivia' }
      ];
    case 'pending':
      return [
        { decision: 'exclude', label: 'Archivia' },
        { decision: 'undecided', label: 'Rimetti tra le novità' }
      ];
    case 'excluded':
      return [
        { decision: 'download', label: 'Scarica' },
        { decision: 'undecided', label: 'Rimetti tra le novità' }
      ];
    case 'failed':
      return [
        { decision: 'download', label: 'Riprova' },
        { decision: 'exclude', label: 'Archivia' },
        { decision: 'undecided', label: 'Rimetti tra le novità' }
      ];
    default:
      return [];
  }
}
