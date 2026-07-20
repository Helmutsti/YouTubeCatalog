import { readMetadata } from '../catalog/metadataStore.js';

export async function getRawMetadata(id) {
  return readMetadata(id);
}
