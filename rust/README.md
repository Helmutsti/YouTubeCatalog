# rust/ — `ondo-core` e `ondo-cli`

Core e CLI in Rust, **autonomi**: non richiedono API né frontend. Il ramo `main` resta
l'implementazione JavaScript completa e non viene toccato.

## Prerequisiti

- Toolchain Rust stabile (su Windows il toolchain MSVC).
- `tools/yt-dlp*` + ffmpeg — li procura `npm run setup` dalla radice.
- **`node` nel PATH**: yt-dlp lo usa come runtime JS (`--js-runtimes node`) per
  decifrare le firme dei formati. È l'unica dipendenza da Node che resta, e non è
  eliminabile finché il motore di download è yt-dlp.

## Comandi

```bash
npm run rust:build   # compila in release
npm run rust:test    # 68 test
npm run cli:rust     # avvia la CLI

# da rust/
cargo run -p ondo-core --example e2e_download   # prova reale del download, con pulizia
```

---

## Struttura

Quella decisa dall'utente, con una correzione: **il downloader sta accanto alla
library, non sotto**.

```
ops            orchestrazione: sync · download · sorgenti · manutenzione · storico
 ├── library   stato: schema · state · commit · metadata · query · search · files
 └── downloader   yt-dlp + ffmpeg — PURO: prende un url, restituisce dati
```

**Perché non `library(downloader)`.** Il downloader deve scrivere il risultato *dentro*
la library (entry del video, metadati grezzi): mettendolo sotto si crea il ciclo
`library → downloader → library`. Il ciclo esisteva davvero nella prima stesura,
ereditato dal JavaScript — il wrapper chiamava `set_metadata()` da sé. Ora il
downloader restituisce un `Extracted { fields, raw_info }` e non tocca lo stato:
decide `ops`. Una sola direzione, e il downloader diventa testabile da solo.

**Nessuna ABI C**: la CLI linka il crate direttamente e usa tipi Rust veri, non
stringhe JSON.

## File su disco

```
data/
  sources.json          le sorgenti
  library.json          autori + video
  metadata/<id>.json    metadati grezzi, UNO PER VIDEO
  covers/<id>.jpg       copertine
  authors/<key>.jpg     foto profilo
videos/                 configurabile, tipicamente su un altro disco
  <Autore>/<Titolo> [<id>].<ext>
```

**Metadati per video, non un file unico.** Misurato sui dati veri: 95 KB in media per
video dopo aver rimosso `automatic_captions` — 132 KB su un video con 38 formati,
57 KB su uno con 13 — quindi ~25 MB per 274 video. Con un file unico ogni salvataggio
riscrive tutto: un arricchimento completo sarebbero ~3,4 GB scritti e una quindicina
di secondi di puro serializza/deserializza, per aggiornare 95 KB alla volta.

**`data/` e `videos/` restano separati.** Unirli riporterebbe decine di GB di video sul
disco di sistema. `videosRoot` in `data/config.json` resta la radice configurabile.

## Atomicità su più file

Con un file unico l'atomicità era gratis: tmp + `rename()`. Con due file un
`add_source` — che registra la sorgente **e** ingerisce i video — potrebbe morire in
mezzo. Un `rename()` atomico su due file non esiste, quindi il **punto di commit** si
sposta su un file minuscolo:

```
data/.commit/
  sources.json  library.json   ← contenuti nuovi, completi, forzati su disco (sync_all)
  COMMIT                       ← creato con un rename: QUESTO è il punto di commit
```

Il ripristino gira **prima di ogni lettura e di ogni scrittura**: se `COMMIT` c'è, la
transazione era decisa e si completa (idempotente — un file già spostato si salta); se
non c'è, si scarta lo staging e lo stato visibile è ancora quello vecchio, intatto.
Risultato: **o tutti i file nuovi, o tutti quelli vecchi**, mai un miscuglio. Il
`sync_all()` sui contenuti è ciò che rende la garanzia vera anche su spegnimento
improvviso, non solo su un processo ucciso. Quattro test coprono i quattro momenti in
cui si può morire.

**Un solo lock** (`data/state.lock`) per tutto lo stato: con file che si toccano a
vicenda, lock separati sarebbero un invito al deadlock.

## Autori come entità, ma lo snapshot resta

`authors` è una tabella: un autore può esistere con zero video, il nome non è più
duplicato in ogni entry, e avatar/url hanno una casa.

Ma `video.channel` **resta**, e non è ridondanza: è uno *snapshot*, come
`statsAtDownload`. Se un canale viene rinominato o terminato, il video conserva il nome
che aveva. La tabella dice *com'è adesso*, lo snapshot *com'era* — e preservare la
seconda informazione è il motivo per cui questo progetto esiste. Il collegamento è
`video.authorKey`.

*Limite noto*: la chiave è l'id del canale se noto, altrimenti il nome.
L'enumerazione flat di una playlist non espone l'id, quindi i video che arrivano da lì
prendono il nome come chiave e lo mantengono anche dopo che il download ha rivelato
l'id vero — cambiarla renderebbe orfani i video già collegati. Funziona, ma la chiave
non è sempre un `UC…`.

## Migrazione dal vecchio formato

`Impostazioni → Migra dal vecchio formato`, oppure `ops::migrate_all()`:
`catalog.json` → `library.json` + `sources.json` + `metadata/<id>.json`, popolando
`authors` dagli snapshot dei video e dalla vecchia mappa `channelAvatars`. Applica
anche le due migrazioni storiche (`status` singolo → flag ortogonali, `source` singola
→ `sources[]`).

**Non cancella nulla**: i file vecchi diventano `*.pre-v2`. La CLI **segnala** la
migrazione all'avvio ma non la esegue da sé — toccare i dati dell'utente senza che lo
abbia chiesto non è mai la scelta giusta.

## Le migliorie rispetto all'implementazione JS

1. **Niente coda di job.** `jobManager` esisteva per alimentare via SSE un pannello nel
   browser. Senza frontend le operazioni girano in primo piano con una barra. Oltre
   alle ~600 righe in meno: **nessuna operazione può restare orfana** —
   `reconcileOrphanJobs()` esisteva perché un processo morto lasciava job `running` per
   sempre, e senza coda in background quello stato non è rappresentabile.
2. **Lock fra processi.** Il mutex JS proteggeva solo dentro un processo: due processi
   si sovrascrivevano, ed è la radice dell'incidente del 2026-07-25 (83 video
   azzerati), fin qui gestito come convenzione umana in `documentazione.md`.
3. **Due bug noti corretti** (`PIANO.md` → "Bug noti" #1): guardia se il disco dei
   video è irraggiungibile — non si declassa più un'intera sorgente perché il NAS era
   scollegato — e **riconciliazione inversa** `none → downloaded` quando il file
   ricompare, che è esattamente ciò che allora mancava.
4. **Niente cache del catalogo per processo**: si rilegge sotto lock.

## Cosa manca

- **Backup/ripristino `.zip`** (~324 righe): l'unica funzionalità del CLI JS assente.
- **Download del file avatar**: l'URL si risolve e si registra, l'immagine non si salva
  (servirebbe un client HTTP, e una CLI non mostra immagini).
- **Il banco differenziale JS↔Rust è stato ritirato.** Confrontava le due
  implementazioni sullo stesso `catalog.json`; con lo stato diviso in tre file il JS non
  sa più leggerlo. Era prevedibile e annunciato: è il prezzo della divisione. Al suo
  posto la rete di sicurezza sono i 68 test e la prova end-to-end reale.

## Altre scelte tecniche

- **`Video`/`Author` avvolgono una mappa JSON**, non sono struct tipizzate: i campi non
  modellati sopravvivono e l'ordine delle chiavi non cambia.
- **La ricerca lavora su UTF-16**: JS misura `length` e taglia `slice()` in unità
  UTF-16, e senza la stessa unità i punteggi divergono sui titoli con emoji.
- **`ytdlp.rs` drena stderr in un thread dedicato**: leggere stdout fino a EOF mentre
  stderr si riempie porta a un deadlock delle pipe. In Node il problema non esiste.
- **Niente `tokio`**: le operazioni sono sequenziali e bloccanti.
- **La radice del progetto si cerca**: `ONDO_ROOT` → risalita dalla cwd → risalita
  dall'eseguibile. Il trucco di `__dirname` non funziona per un binario.
- **Interruzione = Ctrl-C.** Le operazioni sono in primo piano, quindi la console
  recapita il segnale a tutto il gruppo di processi, yt-dlp compreso. Chiude anche la
  CLI, ma lo stato non resta incoerente: un video interrotto risulta `downloading` e la
  riconciliazione all'avvio successivo lo riporta a "da scaricare".

## Verifiche

- **68 test unitari** (`npm run rust:test`), inclusi i quattro sui punti di crash della
  transazione e quelli sui due bug di sync corretti.
- **End-to-end reale** (`examples/e2e_download.rs`): download vero, due flussi fusi da
  ffmpeg, sha256 confrontato con la dimensione reale del file, autore creato nella
  tabella e potato alla cancellazione, metadati nel file per-video senza
  `automatic_captions`, nessun sidecar residuo, verifica che non resti una transazione
  a metà, e pulizia completa.
- **Non verificato**: i menu a frecce richiedono un TTY reale, che l'ambiente di
  automazione non fornisce. La prova visiva è a carico dell'utente.
