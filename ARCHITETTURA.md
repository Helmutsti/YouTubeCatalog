# Ondo — architettura

Due pezzi, niente altro.

```
ondo/       la libreria: funzioni semplici per gestire la libreria video,
            più il sentinel — un guardiano per video, su un thread
ondo-cli/   menu a frecce sopra la libreria
```

Un solo binario da spedire: `ondo`.

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

## Il sentinel (`ondo::sentinel`)

Un guardiano per video: `sentinel::run(...)`, eseguito su un thread del pool
([`Downloader`]), N insieme. Non tocca `library.json` — lavora solo nella sua
cartella di staging e **riferisce** emettendo `Event`.

Passi, in ordine:

1. **Risoluzione del link** — `yt-dlp --skip-download -J`: da un URL qualunque
   (qualunque sito che yt-dlp sappia gestire) ricava id, titolo, autore, durata.
2. **Metadati + copertina** — scrive i metadati grezzi in `<id>.json` (togliendo
   `automatic_captions`, centinaia di KB di URL inutili) e scarica la copertina
   migliore in `<id>.jpg` usando **ffmpeg** come client HTTP, così non serve
   nessuna libreria di rete.
3. **Download video** — `yt-dlp` con `--newline`, avanzamento riga per riga.
4. **`done`** — dice dove sono i tre file.

### Gli eventi

`Event` è un enum che viaggia su un canale: `phase` · `resolved` · `metadata` ·
`cover` · `progress` · `log` · `done` · `error`. Resta serializzabile (`to_line()` dà
una riga JSON) perché è il modo più corto per scriverlo in un log o in una
segnalazione, non perché attraversi un confine di processo.

**Regola su cui si appoggia tutto il resto:** ogni job si chiude con **esattamente
un** evento terminale, `done` oppure `error`. Mai entrambi, mai nessuno. Chi
ascolta non deve avere casi speciali — e il giorno che questa regola è stata rotta
(un `done` non emesso), chi aspettava è rimasto appeso per sempre. C'è un test che
la difende, con un yt-dlp finto: `un_download_riuscito_chiude_il_job_e_organizza_i_file`.

### Perché un thread e non un processo a parte

Il sentinel **era** un eseguibile separato che parlava JSON-lines su stdout. È
diventato una funzione perché i vantaggi del confine di processo, guardati da
vicino, in due casi su tre non c'erano:

- *isolamento dai crash*: quello che si impianta è **yt-dlp**, che è un
  sottoprocesso in entrambi i disegni. Un panic nel nostro codice lo prende
  `catch_unwind` nel worker e diventa "questo download è fallito";
- *niente yt-dlp orfani*: yt-dlp muore perché scrive in una pipe il cui capo di
  lettura è chiuso, e quel capo si chiude quando muore il processo che lo tiene —
  sentinel o CLI, identico;
- *annullare*: col thread è **meglio**. Abbiamo in mano il `Child` di yt-dlp e lo
  uccidiamo direttamente, invece di uccidere il sentinel e sperare che il suo
  yt-dlp si accorga della pipe rotta.

Quello che il processo costava, invece, era reale: un secondo binario da **trovare
a runtime** accanto all'eseguibile (fragilità che si manifesta sull'altra macchina,
contro l'auto-portabilità), più ~300 righe fra serializzazione, parsing degli
argomenti, thread per lo stderr e casi limite tipo "finito senza dire niente".

L'unica cosa che si è persa è lanciare il sentinel a mano per capire un 403. In
cambio ogni invocazione di yt-dlp viene emessa come evento `log` **già pronta da
incollare in un terminale** (`$ tools\yt-dlp.exe --js-runtimes node …`), che è la
cosa che si vuole davvero in quel momento.

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

## Bug noti da correggere

- **Due processi sulla stessa libreria si sovrascrivono.** Ogni processo tiene
  `library.json` in memoria e riscrive tutto quando salva: se una CLI è aperta
  mentre qualcos'altro scrive (un altro `ondo`, uno script, un esempio), il primo
  che salva dopo cancella il lavoro dell'altro. Succede davvero, non in teoria.
  Finché non c'è un lock sul file, la regola è: **un solo processo per libreria**.

## La risoluzione si misura sul file, non nei metadati

I metadati di yt-dlp (`-J`) descrivono il **miglior formato disponibile**: con un
tetto di qualità direbbero 3840×2160 di un file che è 640×360. Dopo aver spostato
il video, `Library::absorb` lo misura con **ffprobe** e sono quei numeri a finire
nel record. Se ffprobe non c'è si tengono quelli dei metadati: approssimativi, ma
meglio di niente.

## Chi tiene lo stato di un download in corso

**Il pool, non l'interfaccia.** `Downloader::statuses()` restituisce, per ogni job
della sessione, fase / percentuale / titolo / esito. Un'interfaccia non ricorda
niente: ridisegna rileggendo.

Serve perché **un evento si consuma una volta sola**. La prima versione della
console si costruiva le righe dagli `Update` e le teneva in una variabile locale:
uscendo e rientrando ripartiva vuota, con i download ancora in corso e nessun modo
di sapere dov'erano arrivati. Tenere le righe nell'interfaccia sarebbe stato un
rammendo; il posto giusto è dove le cose si sanno.

Gli `Update` restano il canale per *reagire* (è così che `Library::apply` scrive lo
stato al momento giusto); `statuses()` è la fotografia per *disegnare*.

## Milestone

- [x] **S1 — libreria + sentinel.** Stato in `library.json`, sentinel in quattro
  passi, protocollo JSON-lines, download paralleli, organizzazione canonica dei
  file, funzioni di lettura (list/get/search/authors/missing_files/remove).

- [ ] **S2 — la CLI, e ciò che il core deve avere perché esista.**

  I menu chiesti (sotto) pretendono quattro cose che S1 non ha. Vanno nel **core**,
  non nella CLI:

  1. **Un video entra in libreria appena il link è risolto**, non a download
     riuscito. `Video.state` diventa `pending | downloading | downloaded | failed`,
     con `error`/`attempts` per i falliti. Così "Da scaricare" e "Falliti" sono
     filtri, non liste separate, e un fallimento resta visibile col suo motivo.
     All'apertura, ogni `downloading` torna `pending`: voleva dire che il processo
     era morto lì.
  2. **Una coda di link non ancora risolti** (`LibraryFile.queue`): un link appena
     incollato non ha ancora un id, quindi non può essere un `Video`. Un link che
     fallisce *prima* di risolversi resta in coda con il suo errore.
  3. **Download non bloccanti**: `Downloader` è un pool di worker che si tiene in
     piedi, con `push(url)` e `try_recv()`. È questo che permette al prompt di
     restare attivo mentre i download vanno. `Library::apply(&update)` è l'unico
     punto che muta lo stato; `Library::download()` resta come involucro bloccante
     costruito sopra lo stesso pool.
  4. **Config persistita** in `<radice>/config.json`: cartelle video/copertine/
     metadati (spostabili), VLC, qualità predefinita, parallelismo, cookie. I
     percorsi nei record diventano relativi *alla loro cartella*, non alla radice:
     spostare l'archivio è una riga di config. In più `play(id, modo)` per VLC.

  Flag per video: `favorite`, `archived`, `removed`. **"Rimossi da YouTube" è un
  punto aperto**: il campo e il filtro ci sono, ma *come* accorgersene (verifica su
  richiesta? al primo fallimento "unavailable"?) è una decisione rimandata, quindi
  per ora nessuno lo imposta.

  I menu:

  ```
  Cerca                    ricerca dal vivo, azioni sul risultato
  Libreria                 tutti (dall'ultimo pubblicato) · autori · preferiti
                           da scaricare · archiviati · rimossi · falliti
  Download rapido          console dal vivo: prompt sempre attivo in basso,
                           i download in corso si aggiornano sopra
  Impostazioni             stato e percorsi · qualità predefinita · VLC
  ```

  "Tutti i video" **esclude gli archiviati**: archiviare serve a togliere di mezzo.
  Solo il Download rapido usa il terminale a schermo pieno (crossterm, con
  `poll()`: nessun thread bloccato sullo stdin, che è il modo in cui una console
  così si mangia i tasti del menu successivo); tutto il resto sono menu a frecce.

  **Qualità.** `Config::quality` è una scelta a tre facce — `Massima`, `Chiedi ogni
  volta`, `<altezza>p` — e `Ask` non è un tetto: è l'assenza di una decisione presa
  in anticipo. Il tetto vero viaggia col **singolo job** (`Downloader::push_with`),
  perché lo si può chiedere link per link. Con `Ask`, la console si ferma fra il
  link incollato e la partenza del sentinel e disegna **lei** la scelta: è in raw
  mode, e un menu di `dialoguer` vorrebbe lo stdin per sé. La scelta vive solo nel
  pool: se la CLI muore prima che il link parta, resta in coda senza tetto e al
  giro dopo vale la qualità predefinita.
