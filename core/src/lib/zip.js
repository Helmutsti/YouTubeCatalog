// Lettura/scrittura ZIP scritte a mano, senza dipendenze esterne (invariante
// del progetto: come la ricerca fuzzy in searchService.js). Si appoggia solo a
// `zlib` nativo per il deflate. Supporta un sottoinsieme sufficiente del formato
// ZIP: singolo disco, nessun zip64, entry compresse in deflate (metodo 8) —
// abbastanza per un backup di pochi file JSON, e interoperabile con qualunque
// strumento zip standard (Esplora risorse, 7-Zip, unzip, tar).

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50; // PK\x03\x04 — header locale
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02 — central directory
const SIG_EOCD = 0x06054b50; // PK\x05\x06 — end of central directory

// CRC-32 (IEEE 802.3), table-based — richiesto in chiaro dagli header ZIP.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Data/ora DOS fisse (1980-01-01 00:00): deterministiche e indipendenti
// dall'orologio. Questi campi non sono usati da nessuna logica del progetto.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Crea un archivio ZIP in memoria.
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0; // offset corrente nell'area degli header locali

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // versione minima per estrarre
    local.writeUInt16LE(0, 6); // flag generici
    local.writeUInt16LE(8, 8); // metodo: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // lunghezza extra field
    nameBuf.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // versione di chi ha creato
    central.writeUInt16LE(20, 6); // versione minima per estrarre
    central.writeUInt16LE(0, 8); // flag
    central.writeUInt16LE(8, 10); // metodo
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // commento
    central.writeUInt16LE(0, 34); // numero disco
    central.writeUInt16LE(0, 36); // attributi interni
    central.writeUInt32LE(0, 38); // attributi esterni
    central.writeUInt32LE(offset, 42); // offset dell'header locale
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // numero disco
  eocd.writeUInt16LE(0, 6); // disco con l'inizio della central directory
  eocd.writeUInt16LE(entries.length, 8); // record su questo disco
  eocd.writeUInt16LE(entries.length, 10); // record totali
  eocd.writeUInt32LE(centralBuf.length, 12); // dimensione central directory
  eocd.writeUInt32LE(offset, 16); // offset di inizio della central directory
  eocd.writeUInt16LE(0, 20); // lunghezza commento

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * Legge un archivio ZIP restituendo le entry decompresse.
 * @param {Buffer} buffer
 * @returns {{name: string, data: Buffer}[]}
 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // EOCD cercato dal fondo (i nostri zip non hanno commento, ma restiamo robusti).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archivio ZIP non valido: EOCD non trovato.');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // inizio della central directory

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== SIG_CENTRAL) {
      throw new Error('Archivio ZIP non valido: central directory corrotta.');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error('Archivio ZIP non valido: header locale corrotto.');
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    const data = method === 0 ? Buffer.from(compData) : inflateRawSync(compData);
    entries.push({ name, data });

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
