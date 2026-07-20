import { getPlaylistEntries } from '../ytdlp/ytdlpWrapper.js';

export async function listEntries(source) {
  if (!source.url) {
    throw new Error(`Playlist non configurata per la sorgente "${source.id}"`);
  }
  return getPlaylistEntries(source.url);
}
