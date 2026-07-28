//! Lettura e scrittura di archivi ZIP, scritte a mano.
//!
//! Porting di `core/src/lib/zip.js`, che a sua volta era scritto a mano per la stessa
//! ragione. Supporta il sottoinsieme del formato che serve: disco singolo, nessun
//! zip64 — abbastanza per un backup, e interoperabile con Esplora file, 7-Zip, `unzip`
//! e `tar`.
//!
//! ## Perché si SCRIVE senza compressione e si LEGGE anche compresso
//!
//! Lo ZIP ammette due metodi che ci interessano: `0` = *stored* (i byte così come
//! sono) e `8` = *deflate*. La versione JavaScript scriveva in deflate, appoggiandosi
//! a `node:zlib`.
//!
//! In scrittura si usa **stored**. Implementare DEFLATE a mano (LZ77 + Huffman
//! dinamico) per guadagnare un fattore di compressione significa rischiare di
//! produrre **archivi corrotti**, che è il modo peggiore in cui una funzione di backup
//! possa fallire. Il costo di questa scelta è dichiarato: un backup pesa quanto la
//! somma dei file invece di circa un quinto — i JSON comprimono molto, le copertine
//! JPEG praticamente nulla.
//!
//! In lettura invece **si supporta anche deflate**, tramite un INFLATE scritto qui.
//! Decomprimere è molto più semplice che comprimere (non ci sono scelte da fare: si
//! esegue ciò che il flusso dice) e serve a una cosa concreta: poter ripristinare i
//! backup che l'implementazione JavaScript ha già prodotto.

use crate::error::{ErrorKind, OndoError, Result};

const SIG_LOCAL: u32 = 0x0403_4b50; // PK\x03\x04
const SIG_CENTRAL: u32 = 0x0201_4b50; // PK\x01\x02
const SIG_EOCD: u32 = 0x0605_4b50; // PK\x05\x06

/// Data/ora DOS fisse (1980-01-01): deterministiche e indipendenti dall'orologio.
/// Nessuna logica del progetto usa questi campi.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;

// ── CRC-32 ──────────────────────────────────────────────────────────────────

/// CRC-32 (IEEE 802.3): richiesto in chiaro dagli header ZIP, quindi va calcolato
/// anche quando i dati non sono compressi.
fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });

    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

// ── Scrittura ───────────────────────────────────────────────────────────────

pub struct ZipEntry {
    /// Percorso dentro l'archivio, con separatori `/`.
    pub name: String,
    pub data: Vec<u8>,
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Crea un archivio in memoria, con le entry **non compresse** (metodo 0).
pub fn create_zip(entries: &[ZipEntry]) -> Vec<u8> {
    let mut local = Vec::new();
    let mut central = Vec::new();

    for entry in entries {
        let name = entry.name.as_bytes();
        let crc = crc32(&entry.data);
        let size = entry.data.len() as u32;
        let offset = local.len() as u32;

        // Header locale
        push_u32(&mut local, SIG_LOCAL);
        push_u16(&mut local, 20); // versione minima per estrarre
        push_u16(&mut local, 0); // flag generici
        push_u16(&mut local, 0); // metodo: 0 = stored
        push_u16(&mut local, DOS_TIME);
        push_u16(&mut local, DOS_DATE);
        push_u32(&mut local, crc);
        push_u32(&mut local, size); // dimensione compressa == originale
        push_u32(&mut local, size);
        push_u16(&mut local, name.len() as u16);
        push_u16(&mut local, 0); // extra field
        local.extend_from_slice(name);
        local.extend_from_slice(&entry.data);

        // Central directory
        push_u32(&mut central, SIG_CENTRAL);
        push_u16(&mut central, 20); // versione di chi ha creato
        push_u16(&mut central, 20); // versione minima per estrarre
        push_u16(&mut central, 0);
        push_u16(&mut central, 0); // metodo
        push_u16(&mut central, DOS_TIME);
        push_u16(&mut central, DOS_DATE);
        push_u32(&mut central, crc);
        push_u32(&mut central, size);
        push_u32(&mut central, size);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0); // extra
        push_u16(&mut central, 0); // commento
        push_u16(&mut central, 0); // numero disco
        push_u16(&mut central, 0); // attributi interni
        push_u32(&mut central, 0); // attributi esterni
        push_u32(&mut central, offset);
        central.extend_from_slice(name);
    }

    let central_offset = local.len() as u32;
    let central_size = central.len() as u32;
    let count = entries.len() as u16;

    let mut out = local;
    out.extend_from_slice(&central);
    push_u32(&mut out, SIG_EOCD);
    push_u16(&mut out, 0); // numero disco
    push_u16(&mut out, 0); // disco con l'inizio della central directory
    push_u16(&mut out, count);
    push_u16(&mut out, count);
    push_u32(&mut out, central_size);
    push_u32(&mut out, central_offset);
    push_u16(&mut out, 0); // lunghezza commento
    out
}

// ── Lettura ─────────────────────────────────────────────────────────────────

fn read_u16(buf: &[u8], at: usize) -> Result<u16> {
    buf.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(|| bad("archivio troncato"))
}

fn read_u32(buf: &[u8], at: usize) -> Result<u32> {
    buf.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| bad("archivio troncato"))
}

fn bad(msg: &str) -> OndoError {
    OndoError::new(ErrorKind::Parse, format!("Archivio ZIP non valido: {msg}"))
}

/// Legge un archivio restituendo le entry decompresse.
pub fn read_zip(buf: &[u8]) -> Result<Vec<ZipEntry>> {
    if buf.len() < 22 {
        return Err(bad("troppo corto"));
    }

    // EOCD cercato dal fondo (i nostri archivi non hanno commento, ma restiamo robusti).
    let mut eocd = None;
    let start = buf.len().saturating_sub(22);
    for i in (0..=start).rev() {
        if read_u32(buf, i)? == SIG_EOCD {
            eocd = Some(i);
            break;
        }
    }
    let eocd = eocd.ok_or_else(|| bad("EOCD non trovato"))?;

    let count = read_u16(buf, eocd + 10)? as usize;
    let mut ptr = read_u32(buf, eocd + 16)? as usize;

    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if read_u32(buf, ptr)? != SIG_CENTRAL {
            return Err(bad("central directory corrotta"));
        }
        let method = read_u16(buf, ptr + 10)?;
        let comp_size = read_u32(buf, ptr + 20)? as usize;
        let uncomp_size = read_u32(buf, ptr + 24)? as usize;
        let name_len = read_u16(buf, ptr + 28)? as usize;
        let extra_len = read_u16(buf, ptr + 30)? as usize;
        let comment_len = read_u16(buf, ptr + 32)? as usize;
        let local_offset = read_u32(buf, ptr + 42)? as usize;

        let name = String::from_utf8_lossy(
            buf.get(ptr + 46..ptr + 46 + name_len)
                .ok_or_else(|| bad("nome entry troncato"))?,
        )
        .to_string();

        if read_u32(buf, local_offset)? != SIG_LOCAL {
            return Err(bad("header locale corrotto"));
        }
        let local_name_len = read_u16(buf, local_offset + 26)? as usize;
        let local_extra_len = read_u16(buf, local_offset + 28)? as usize;
        let data_start = local_offset + 30 + local_name_len + local_extra_len;
        let raw = buf
            .get(data_start..data_start + comp_size)
            .ok_or_else(|| bad("dati entry troncati"))?;

        let data = match method {
            0 => raw.to_vec(),
            8 => inflate(raw, uncomp_size)?,
            m => {
                return Err(bad(&format!(
                    "metodo di compressione {m} non supportato per «{name}» (attesi 0 o 8)"
                )))
            }
        };

        entries.push(ZipEntry { name, data });
        ptr += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

// ── INFLATE (RFC 1951) ──────────────────────────────────────────────────────
//
// Solo decompressione. Non ci sono scelte da fare: si esegue ciò che il flusso dice,
// ed è per questo che è molto più semplice — e molto più difficile da sbagliare in
// silenzio — che comprimere.

struct BitReader<'a> {
    data: &'a [u8],
    byte: usize,
    bit: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, byte: 0, bit: 0 }
    }

    /// I bit si leggono dal meno significativo, come vuole il formato.
    fn bits(&mut self, n: u32) -> Result<u32> {
        let mut out = 0u32;
        for i in 0..n {
            let b = *self
                .data
                .get(self.byte)
                .ok_or_else(|| bad("flusso deflate troncato"))?;
            out |= (((b >> self.bit) & 1) as u32) << i;
            self.bit += 1;
            if self.bit == 8 {
                self.bit = 0;
                self.byte += 1;
            }
        }
        Ok(out)
    }

    fn align_to_byte(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.byte += 1;
        }
    }
}

/// Albero di Huffman canonico, rappresentato per lunghezze di codice: è il modo in cui
/// il formato lo trasmette, e permette di decodificare senza costruire nodi.
struct Huffman {
    /// `counts[len]` = quanti codici hanno quella lunghezza.
    counts: [u16; 16],
    /// Simboli ordinati per lunghezza di codice crescente.
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Self {
        let mut counts = [0u16; 16];
        for &l in lengths {
            counts[l as usize] += 1;
        }
        counts[0] = 0; // le lunghezze 0 non sono codici

        let mut offsets = [0u16; 16];
        for i in 1..15 {
            offsets[i + 1] = offsets[i] + counts[i];
        }

        let mut symbols = vec![0u16; lengths.len()];
        for (sym, &l) in lengths.iter().enumerate() {
            if l != 0 {
                symbols[offsets[l as usize] as usize] = sym as u16;
                offsets[l as usize] += 1;
            }
        }
        Huffman { counts, symbols }
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for len in 1..16 {
            code |= reader.bits(1)? as i32;
            let count = self.counts[len] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err(bad("codice di Huffman non valido"))
    }
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

fn fixed_trees() -> (Huffman, Huffman) {
    // Alfabeto fisso definito dall'RFC: lunghezze note a priori.
    let mut lit = [0u8; 288];
    for (i, l) in lit.iter_mut().enumerate() {
        *l = match i {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    (Huffman::new(&lit), Huffman::new(&[5u8; 30]))
}

fn dynamic_trees(reader: &mut BitReader<'_>) -> Result<(Huffman, Huffman)> {
    let hlit = reader.bits(5)? as usize + 257;
    let hdist = reader.bits(5)? as usize + 1;
    let hclen = reader.bits(4)? as usize + 4;

    // Le lunghezze dell'alfabeto dei codici arrivano in quest'ordine bizzarro, fissato
    // dall'RFC per mettere davanti i valori statisticamente più probabili.
    const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let mut code_lengths = [0u8; 19];
    for i in 0..hclen {
        code_lengths[ORDER[i]] = reader.bits(3)? as u8;
    }
    let code_tree = Huffman::new(&code_lengths);

    let total = hlit + hdist;
    let mut lengths = vec![0u8; total];
    let mut i = 0;
    while i < total {
        let sym = code_tree.decode(reader)?;
        match sym {
            0..=15 => {
                lengths[i] = sym as u8;
                i += 1;
            }
            16 => {
                // Ripeti la lunghezza precedente 3-6 volte.
                if i == 0 {
                    return Err(bad("ripetizione senza lunghezza precedente"));
                }
                let prev = lengths[i - 1];
                let n = 3 + reader.bits(2)? as usize;
                for _ in 0..n {
                    if i >= total {
                        return Err(bad("ripetizione oltre la fine"));
                    }
                    lengths[i] = prev;
                    i += 1;
                }
            }
            17 => {
                let n = 3 + reader.bits(3)? as usize;
                i = (i + n).min(total);
            }
            18 => {
                let n = 11 + reader.bits(7)? as usize;
                i = (i + n).min(total);
            }
            _ => return Err(bad("simbolo di lunghezza non valido")),
        }
    }

    Ok((Huffman::new(&lengths[..hlit]), Huffman::new(&lengths[hlit..])))
}

/// Decomprime un flusso deflate **grezzo** (senza intestazione zlib/gzip), che è ciò
/// che lo ZIP contiene. `expected_size` serve solo a pre-allocare.
pub fn inflate(data: &[u8], expected_size: usize) -> Result<Vec<u8>> {
    let mut reader = BitReader::new(data);
    let mut out = Vec::with_capacity(expected_size);

    loop {
        let last = reader.bits(1)? == 1;
        let btype = reader.bits(2)?;

        match btype {
            // Blocco non compresso.
            0 => {
                reader.align_to_byte();
                let len = read_u16(reader.data, reader.byte)? as usize;
                reader.byte += 4; // LEN + NLEN
                let end = reader.byte + len;
                let chunk = reader
                    .data
                    .get(reader.byte..end)
                    .ok_or_else(|| bad("blocco non compresso troncato"))?;
                out.extend_from_slice(chunk);
                reader.byte = end;
            }
            // Huffman fisso o dinamico: cambia solo come si ottengono gli alberi.
            1 | 2 => {
                let (lit_tree, dist_tree) = if btype == 1 {
                    fixed_trees()
                } else {
                    dynamic_trees(&mut reader)?
                };

                loop {
                    let sym = lit_tree.decode(&mut reader)?;
                    match sym {
                        0..=255 => out.push(sym as u8),
                        256 => break, // fine del blocco
                        257..=285 => {
                            let i = sym as usize - 257;
                            let len = LENGTH_BASE[i] as usize
                                + reader.bits(LENGTH_EXTRA[i] as u32)? as usize;

                            let dsym = dist_tree.decode(&mut reader)? as usize;
                            if dsym >= DIST_BASE.len() {
                                return Err(bad("distanza non valida"));
                            }
                            let dist = DIST_BASE[dsym] as usize
                                + reader.bits(DIST_EXTRA[dsym] as u32)? as usize;
                            if dist > out.len() {
                                return Err(bad("riferimento oltre l'inizio dei dati"));
                            }

                            // Copia LZ77: le regioni possono sovrapporsi (dist < len),
                            // quindi si copia byte per byte, non in blocco.
                            let from = out.len() - dist;
                            for k in 0..len {
                                let b = out[from + k];
                                out.push(b);
                            }
                        }
                        _ => return Err(bad("simbolo letterale non valido")),
                    }
                }
            }
            _ => return Err(bad("tipo di blocco riservato")),
        }

        if last {
            return Ok(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, data: &[u8]) -> ZipEntry {
        ZipEntry { name: name.into(), data: data.to_vec() }
    }

    #[test]
    fn crc32_matches_the_known_vector() {
        // Valore canonico per "123456789", verificabile con qualunque implementazione.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn round_trip_of_a_stored_archive() {
        let entries = vec![
            entry("library.json", b"{\"version\":2}"),
            entry("metadata/abc.json", b"{\"id\":\"abc\"}"),
            entry("covers/abc.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
        ];
        let zip = create_zip(&entries);
        let back = read_zip(&zip).unwrap();

        assert_eq!(back.len(), 3);
        for (a, b) in entries.iter().zip(back.iter()) {
            assert_eq!(a.name, b.name);
            assert_eq!(a.data, b.data);
        }
    }

    #[test]
    fn empty_archive_and_empty_entries_are_handled() {
        let zip = create_zip(&[]);
        assert!(read_zip(&zip).unwrap().is_empty());

        let zip = create_zip(&[entry("vuoto.json", b"")]);
        let back = read_zip(&zip).unwrap();
        assert_eq!(back.len(), 1);
        assert!(back[0].data.is_empty());
    }

    #[test]
    fn unicode_names_survive() {
        // I nomi dei creator hanno accenti ed emoji, e possono finire nei percorsi.
        let zip = create_zip(&[entry("authors/Créatôr 🎧.jpg", b"x")]);
        assert_eq!(read_zip(&zip).unwrap()[0].name, "authors/Créatôr 🎧.jpg");
    }

    #[test]
    fn truncated_and_garbage_archives_are_rejected_not_panicking() {
        assert!(read_zip(b"").is_err());
        assert!(read_zip(b"non uno zip").is_err());
        let zip = create_zip(&[entry("a", b"dati")]);
        assert!(read_zip(&zip[..zip.len() / 2]).is_err());
    }

    #[test]
    fn inflate_handles_an_uncompressed_deflate_block() {
        // Blocco stored: BFINAL=1, BTYPE=00, poi LEN/NLEN e i byte.
        let payload = b"ciao mondo";
        let mut raw = vec![0x01]; // BFINAL=1, BTYPE=00
        raw.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        raw.extend_from_slice(&(!(payload.len() as u16)).to_le_bytes());
        raw.extend_from_slice(payload);
        assert_eq!(inflate(&raw, payload.len()).unwrap(), payload);
    }

    /// **Il test che conta.** Vettori prodotti da `zlib.deflateRawSync()` di Node — la
    /// stessa funzione che l'implementazione JavaScript usava per scrivere i backup —
    /// a tre livelli di compressione, così da esercitare tutti e tre i tipi di blocco:
    /// stored (`level 0`), Huffman dinamico (`level 1` e `9`), con e senza
    /// riferimenti indietro LZ77.
    ///
    /// Rigenerabili con:
    /// ```text
    /// node -e 'const z=require("zlib");console.log([...z.deflateRawSync(Buffer.from("testo"),{level:9})].join(","))'
    /// ```
    #[test]
    fn inflate_decompresses_real_zlib_output() {
        let vectors: &[(&[u8], &str)] = &[
            // "ciao" — stored / fisso-o-dinamico
            (&[1, 4, 0, 251, 255, 99, 105, 97, 111], "ciao"),
            (&[75, 206, 76, 204, 7, 0], "ciao"),
            // ripetitivo: esercita i riferimenti indietro con sovrapposizione
            (
                &[
                    1, 48, 0, 207, 255, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99,
                    97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98,
                    99, 97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99,
                ],
                "abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc",
            ),
            (
                &[75, 76, 74, 78, 36, 5, 1, 0],
                "abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc",
            ),
            // un pezzo di library.json vero, con emoji: Huffman dinamico
            (
                &[
                    77, 78, 187, 13, 194, 48, 16, 237, 61, 197, 211, 213, 84, 148, 222, 129, 9, 16,
                    133, 133, 79, 96, 41, 241, 161, 248, 68, 164, 68, 94, 129, 21, 82, 178, 30, 35,
                    32, 31, 74, 66, 247, 238, 125, 238, 189, 217, 1, 244, 228, 161, 36, 201, 228,
                    113, 60, 216, 157, 34, 75, 33, 143, 217, 1, 0, 133, 13, 2, 148, 34, 249, 70, 53,
                    167, 169, 154, 180, 227, 198, 157, 24, 65, 161, 119, 198, 36, 130, 207, 242,
                    122, 255, 153, 194, 173, 61, 60, 95, 182, 216, 99, 224, 194, 249, 106, 201, 31,
                    214, 221, 30, 101, 204, 157, 4, 171, 90, 49, 71, 178, 202, 234, 128, 106, 59,
                    123, 86, 155, 86, 93, 253, 2,
                ],
                "{\n  \"version\": 2,\n  \"videos\": {\n    \"a\": {\n      \"id\": \"a\",\n      \"title\": \"Me at the zoo 🎧\",\n      \"tags\": [],\n      \"presence\": \"present\",\n      \"download\": \"downloaded\"\n    }\n  },\n  \"meta\": {}\n}",
            ),
            // accenti + emoji ripetuti: riferimenti indietro su testo multibyte
            (
                &[
                    115, 46, 58, 188, 50, 177, 228, 240, 150, 34, 133, 15, 243, 251, 150, 43, 56, 6,
                    251, 6, 41, 60, 106, 152, 162, 80, 148, 89, 144, 90, 82, 90, 146, 175, 167, 224,
                    76, 185, 10, 0,
                ],
                "Créatôr 🎧 ASMR — ripetuto. Créatôr 🎧 ASMR — ripetuto. Créatôr 🎧 ASMR — ripetuto.",
            ),
        ];

        for (i, (compressed, expected)) in vectors.iter().enumerate() {
            let out = inflate(compressed, expected.len())
                .unwrap_or_else(|e| panic!("vettore {i}: {e}"));
            assert_eq!(
                String::from_utf8_lossy(&out),
                *expected,
                "vettore {i} decompresso male"
            );
        }
    }

    #[test]
    fn a_zip_with_deflated_entries_can_be_read() {
        // Costruisce a mano un archivio col metodo 8, come lo scriveva la versione
        // JavaScript: è il percorso che permette di ripristinare un backup vecchio.
        let payload = "abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc";
        let deflated: &[u8] = &[75, 76, 74, 78, 36, 5, 1, 0];
        let name = b"library.json";

        let mut local = Vec::new();
        push_u32(&mut local, SIG_LOCAL);
        push_u16(&mut local, 20);
        push_u16(&mut local, 0);
        push_u16(&mut local, 8); // metodo: deflate
        push_u16(&mut local, DOS_TIME);
        push_u16(&mut local, DOS_DATE);
        push_u32(&mut local, crc32(payload.as_bytes()));
        push_u32(&mut local, deflated.len() as u32);
        push_u32(&mut local, payload.len() as u32);
        push_u16(&mut local, name.len() as u16);
        push_u16(&mut local, 0);
        local.extend_from_slice(name);
        local.extend_from_slice(deflated);

        let central_offset = local.len() as u32;
        let mut central = Vec::new();
        push_u32(&mut central, SIG_CENTRAL);
        push_u16(&mut central, 20);
        push_u16(&mut central, 20);
        push_u16(&mut central, 0);
        push_u16(&mut central, 8);
        push_u16(&mut central, DOS_TIME);
        push_u16(&mut central, DOS_DATE);
        push_u32(&mut central, crc32(payload.as_bytes()));
        push_u32(&mut central, deflated.len() as u32);
        push_u32(&mut central, payload.len() as u32);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u32(&mut central, 0);
        push_u32(&mut central, 0);
        central.extend_from_slice(name);

        let mut zip = local;
        let central_size = central.len() as u32;
        zip.extend_from_slice(&central);
        push_u32(&mut zip, SIG_EOCD);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 1);
        push_u16(&mut zip, 1);
        push_u32(&mut zip, central_size);
        push_u32(&mut zip, central_offset);
        push_u16(&mut zip, 0);

        let back = read_zip(&zip).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "library.json");
        assert_eq!(String::from_utf8_lossy(&back[0].data), payload);
    }

    #[test]
    fn malformed_deflate_streams_do_not_panic() {
        // Un archivio corrotto deve dare errore, non far cadere il programma.
        for raw in [
            &[0xFFu8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF][..],
            &[0x00][..],
            &[0x07][..], // BTYPE riservato
            &[][..],
        ] {
            let _ = inflate(raw, 0);
        }
    }
}
