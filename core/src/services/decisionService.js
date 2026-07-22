import { updateCatalog } from '../catalog/catalogStore.js';

// Modello a flag ortogonali (M25): il vecchio ciclo di decisione
// new/pending/excluded è sparito. Le uniche "decisioni" persistenti sono ora:
//   - nascondere/mostrare un video (asse `hidden`) — questa funzione;
//   - scaricarlo (asse `download`) — via triggerJob('downloadSingle'/'downloadPending').
// Nascondere è sempre ammesso, qualunque siano presenza/stato di download:
// gli assi sono indipendenti (un video scaricato può comunque essere nascosto).
export async function setVideoHidden(id, hidden) {
  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
    video.hidden = !!hidden;
    video.updatedAt = new Date().toISOString();
    return video;
  });
}

// Preferito (M43): stesso pattern di setVideoHidden, asse indipendente —
// ammesso qualunque siano presenza/download/hidden.
export async function setVideoFavorite(id, favorite) {
  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
    video.favorite = !!favorite;
    video.updatedAt = new Date().toISOString();
    return video;
  });
}
