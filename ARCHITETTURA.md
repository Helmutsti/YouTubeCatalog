# Ondo — architettura

Due pezzi, niente altro.

```
ondo/            la libreria: funzioni semplici per gestire la libreria video
ondo-sentinel/   un processo per video: risolve, scarica, riferisce
```

## La libreria (`ondo`)

Un solo tipo, `Library`, aperto su una cartella radice. Tutto lo stato sta in un
file JSON (`library.json`), scritto in modo atomico (`.tmp` + rename).

```rust
let mut lib = Library::open("ondo-data")?;

lib.download(&urls, |u| println!("{:?}", u.event))?;  // orchestrazione
lib.list();                                          // tutti i video, dal più recente
lib.get(id);
lib.search("bel gramar");
lib.authors();                                        // (autore, quanti video)
lib.file_path(v);   lib.cover_path(v);
lib.missing_files();                                  // id con il file sparito dal disco
lib.remove(id, delete_files);
```

Layout su disco sotto la radice:

```
library.json                       stato: { version, videos: { id: Video } }
videos/<Autore>/<Titolo> [id].mp4  archivio canonico
covers/<id>.jpg                    copertina
metadata/<id>.json                 metadati grezzi di yt-dlp (senza automatic_captions)
staging/job-<n>/                   area di lavoro dei sentinel, svuotata a ogni giro
```

I percorsi dentro `library.json` sono **relativi** alla radice: spostare l'archivio
non richiede di riscrivere il file.

## Il sentinel (`ondo-sentinel`)

Un processo per video, lanciato N volte in parallelo dalla libreria. Non tocca
`library.json`: lavora solo nella sua cartella di staging e **riferisce**.

Passi, in ordine:

1. **Risoluzione del link** — `yt-dlp --skip-download -J`: da un URL qualunque
   (qualunque sito che yt-dlp sappia gestire) ricava id, titolo, autore, durata.
2. **Metadati + copertina** — scrive i metadati grezzi in `<id>.json` (togliendo
   `automatic_captions`, centinaia di KB di URL inutili) e scarica la copertina
   migliore in `<id>.jpg` usando **ffmpeg** come client HTTP, così non serve
   nessuna libreria di rete.
3. **Download video** — `yt-dlp` con `--newline`, avanzamento riga per riga.
4. **`done`** — dice alla libreria dove sono i tre file.

### Protocollo: una riga JSON per evento su stdout

```json
{"event":"phase","phase":"resolve"}
{"event":"resolved","id":"dQw4w9WgXcQ","title":"…","author":"…","duration":212.0}
{"event":"phase","phase":"metadata"}
{"event":"metadata","path":"…/dQw4w9WgXcQ.json"}
{"event":"cover","path":"…/dQw4w9WgXcQ.jpg"}
{"event":"phase","phase":"video"}
{"event":"progress","percent":45.3}
{"event":"log","line":"[download] Destination: …"}
{"event":"done","id":"dQw4w9WgXcQ","video":"…mp4","cover":"…jpg","metadata":"…json"}
{"event":"error","message":"…"}
```

Niente socket, niente porte: si lancia a mano dal terminale e si legge cosa dice.
Il tipo `Event` vive nella libreria (`ondo::Event`) e il sentinel dipende da essa —
un solo posto dove il protocollo è definito, impossibile che le due parti divergano.

### Chi fa cosa a download finito

Il sentinel si ferma a `done`. È **la libreria** che poi organizza: legge i
metadati, costruisce il record `Video`, sposta il video in
`videos/<Autore>/<Titolo> [id].mp4`, la copertina in `covers/`, i metadati in
`metadata/`, e salva `library.json`. Lo stato è mutato solo dal thread
orchestratore: i sentinel girano in parallelo, ma nessuno di loro scrive lo stato,
quindi non c'è niente da bloccare.

## Fatti su yt-dlp che costano caro da riscoprire

- `--js-runtimes node` — senza un runtime JS, yt-dlp non decifra le firme dei
  formati recenti e i download muoiono a metà con **403**.
- `--extractor-args youtube:player_client=default,android_vr,web_embedded` —
  alcuni video sono in un esperimento YouTube che pretende un "PO Token" dai
  client normali; `android_vr` non è soggetto all'esperimento.
- **Niente `--cookies` di default**: cookie del browser + identità mobile
  `android_vr` è una combinazione che la CDN video blocca con 403. I cookie
  servono solo per i video privati/non listati del proprio account.
- Il selettore di formato **esclude AV1** (`vcodec!*=av01`): alla stessa
  risoluzione l'AV1 di YouTube falliva sistematicamente con 403, il VP9 no.
  Nessun compromesso sulla qualità, solo un codec in meno. L'ultimo ripiego
  (`/b`, senza filtro) esiste per i siti dove l'AV1 è l'unico formato che c'è.
- `--newline` — altrimenti l'avanzamento arriva con `\r` sulla stessa riga e non
  si riesce a leggerlo riga per riga.

## Milestone

- [x] **S1 — libreria + sentinel.** Stato in `library.json`, sentinel in quattro
  passi, protocollo JSON-lines, download paralleli, organizzazione canonica dei
  file, funzioni di lettura (list/get/search/authors/missing_files/remove).
- [ ] **S2 — interfaccia.** Una CLI (o altro) sopra queste funzioni. Nulla della
  logica sopra va duplicato nell'interfaccia.
