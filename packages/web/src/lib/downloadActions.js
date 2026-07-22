// Avvia il download di un video e porta l'utente su Sorgenti, dove ora vive
// la Cronologia con il progresso live (item in cima appena accodato, barra
// live via SSE) — mai più verso la vecchia pagina "Job" col terminale grezzo
// (rimossa). Usato da ogni pagina che NON è già Sorgenti; il tasto rapido
// dentro la Cronologia stessa (SourcesPage) chiama `triggerJob` direttamente,
// senza passare da qui, perché lì non serve nessuna navigazione.
export async function startDownload(videoId, { triggerJob, navigate }) {
  await triggerJob('downloadSingle', { videoId });
  navigate('/sources');
}
