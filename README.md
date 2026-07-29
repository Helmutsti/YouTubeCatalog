# Ondo

Archivio video locale: scarica i video dei creator che ti interessano prima che
spariscano, li tiene in ordine per autore e li rende cercabili. Un catalogo in un
file JSON, download in parallelo, e **due interfacce** sulla stessa libreria: una CLI
a menu e una web app.

```
ondo-core/       la libreria: il catalogo, la ricerca, il pool di download e il
                 sentinel — il guardiano che segue un video dal link al file su disco
cli/             l'interfaccia a menu per il terminale
ondo-web/api/    il server HTTP: /api in JSON, /media per i byte dei video
ondo-web/fe/     la web app (React), che parla solo con l'API
```

Le dipendenze vanno in una direzione sola: `cli` e `api` chiamano `ondo-core`, mai il
contrario, e `fe` non sa nemmeno che il server è scritto in Rust.

Il disegno sta in [`ARCHITETTURA.md`](ARCHITETTURA.md) — protocollo, chi tiene lo
stato, limiti noti e i fatti su yt-dlp che costano caro da riscoprire; le differenze
fra questa API e quella Express di prima stanno in
[`ondo-web/DIFFERENZE.md`](ondo-web/DIFFERENZE.md). Nel codice, i due moduli da
leggere per capire come funziona sono `ondo-core/src/sentinel.rs` e
`ondo-core/src/downloader.rs`. Qui c'è solo come metterlo in funzione.

Sono **due guide distinte**: *compilare* produce i binari e riguarda chi lavora al
codice; *installare* mette in funzione ciò che è già compilato su una macchina che
deve solo usarlo — lì Rust non serve affatto.

---

# 1. Compilazione

Da sorgente, su una macchina da sviluppo.

## Cosa serve

- **Rust** stabile, almeno **1.75** — via [rustup](https://rustup.rs).
- Su **Windows**: i *Visual Studio Build Tools* con il carico "Desktop development
  with C++". Il toolchain MSVC ha bisogno del linker; è lo scoglio tipico su una
  macchina nuova, e `rustup` lo segnala all'installazione.
- **git**.
- **Node** (18 o più recente) **solo per compilare la web app**: vite gira in Node.
  Se ti interessa solo la CLI, non serve.

Le dipendenze Rust le prende `cargo` da sé; quelle della web app, `npm`.

## Compilare

```bash
git clone <url-del-repo> ondo
cd ondo
git checkout rust-core
cargo build --release
```

Escono **due eseguibili**:

```
target/release/ondo.exe          (~1,1 MB)  la CLI
target/release/ondo-api.exe      (~2,4 MB)  il server web
```

Poi, se vuoi la web app, la si compila a parte:

```bash
cd ondo-web/fe
npm install
npm run build          # → ondo-web/fe/dist, che il server serve da sé
```

## Controllare che sia sano

```bash
cargo test              # 38 test, nessuna rete richiesta
```

I test non toccano internet: il percorso di download riuscito è coperto con un
yt-dlp **finto**, quindi girano anche offline.

## Lavorare al codice

```bash
cargo run -p ondo-cli                        # la CLI, dalla build di debug
cargo run -p ondo-api                        # il server, dalla build di debug
cargo run --example scarica -- <URL>         # solo la libreria, senza interfacce
cargo run --example scarica -- --vivo <URL>  # come fa la console: rilegge il pool
cargo run --example scarica                  # elenca cosa c'è in libreria
```

Per la web app conviene il server di sviluppo, che ricarica a ogni salvataggio:

```bash
cd ondo-web/fe && npm run dev     # su :5173, inoltra /api e /media a :3001
```

In sviluppo i binari esterni (vedi sotto) vanno bene anche in `tools/` nella radice
del progetto, perché la ricerca guarda `./tools/` relativo alla cartella corrente e
tu lanci da lì.

---

# 2. Installazione

Su una macchina che deve solo **usare** Ondo. Rust, git e il codice sorgente non
servono: bastano i file prodotti al punto 1 (tuoi, o presi da un'altra macchina con
lo stesso sistema operativo).

## Cosa serve

- **`ondo.exe`** se vuoi la CLI, **`ondo-api.exe`** se vuoi la web app, o entrambi.
- Per la web app, la cartella **`dist/`** prodotta da `npm run build`: copiala dove
  vuoi e indicala con `--web`. **Node non serve** su questa macchina: il bundle è
  fatto di file statici che serve il binario Rust.
- **yt-dlp**, **ffmpeg** e **ffprobe**: tre eseguibili, **non inclusi nel repo**
  (`/tools/` è ignorato da git: peserebbero ~300 MB per versione nella history).

Ondo non ha altre dipendenze. Ne ha una **yt-dlp**, e riguarda solo YouTube: per
calcolare i parametri offuscati che YouTube mette negli URL dei flussi deve
eseguire il JavaScript del player, quindi gli serve un runtime JavaScript sulla
macchina — va bene **uno qualunque** fra `deno`, `node`, `quickjs`, `bun`. Se non ce
n'è nessuno i download da YouTube muoiono a metà con **403**; gli altri siti non se
ne accorgono. CLI e server lo dicono all'avvio se non ne trovano.

## I passi

**1. La cartella della libreria.** È dove finiscono catalogo, video, copertine e
metadati. Chiamala come vuoi; l'esempio usa `ondo-data`. **Non sta dentro il
programma**: gliela si indica da fuori, e i due programmi possono servire la stessa.

**2. I binari esterni, dentro la libreria:**

```
ondo-data/tools/yt-dlp.exe      da github.com/yt-dlp/yt-dlp → Releases
ondo-data/tools/ffmpeg.exe      una build statica (gyan.dev, oppure BtbN su GitHub)
ondo-data/tools/ffprobe.exe     sta nello stesso archivio di ffmpeg
```

⚠️ **Dove li metti conta**, ed è l'errore più facile. La ricerca guarda in
quest'ordine: la variabile d'ambiente → `<radice-libreria>/tools/` →
`./tools/` relativo alla cartella corrente → il `PATH`. Metterli in
`<radice>/tools/` è l'unica sistemazione che funziona **da qualunque cartella tu
lanci il programma**.

**3. Lancia** quello che ti serve.

**La CLI:**

```bash
ondo.exe
```

La radice predefinita è `ondo-data` **relativa alla cartella corrente**, e viene
creata vuota al primo avvio. Se metti `ondo.exe` nel `PATH` e vuoi lanciarlo da
qualsiasi parte, dagli una radice assoluta:

```bash
set ONDO_ROOT=D:\Video\ondo-data      # cmd
$env:ONDO_ROOT = 'D:\Video\ondo-data' # PowerShell
export ONDO_ROOT=/home/tuo/ondo-data  # bash
```

**La web app:**

```bash
ondo-api.exe --root D:\Video\ondo-data --web C:\ondo\dist
```

Poi apri **http://127.0.0.1:3001**. Le opzioni (`--help` le elenca tutte):

| | |
|---|---|
| `--root <cartella>` | la libreria da servire (o `ONDO_ROOT`, default `./ondo-data`) |
| `--web <cartella>` | il `dist/` della web app (o `ONDO_WEB`, default `ondo-web/fe/dist`) |
| `--port <numero>` | la porta (o `ONDO_PORT`, default `3001`) |
| `--bind <indirizzo>` | su cosa ascoltare (o `ONDO_BIND`, default `127.0.0.1`) |

Senza `--web` il server parte comunque e l'API risponde: te lo dice all'avvio.

**Per raggiungerla da un altro dispositivo** in casa serve ascoltare su tutte le
interfacce — di default ascolta solo il computer stesso:

```bash
ondo-api.exe --root D:\Video\ondo-data --web C:\ondo\dist --bind 0.0.0.0
```

Poi da telefono o tablet: `http://<ip-del-computer>:3001`. Non c'è nessuna
autenticazione: chiunque sia sulla rete vede la libreria e può scaricare. Va bene in
casa, non su una rete che non controlli.

## Verificare l'installazione

Se manca un binario, **CLI e server lo dicono all'avvio**, non a metà del primo
download. Il server stampa anche da quali cartelle sta attingendo:

```
ondo-api
  libreria    D:\Video\ondo-data
  video       D:\Video\ondo-data\videos
  copertine   D:\Video\ondo-data\covers
  web app     C:\ondo\dist
  in ascolto  http://127.0.0.1:3001
```

Nella CLI: **Impostazioni → Stato e percorsi** elenca radice, cartelle, yt-dlp,
ffmpeg, ffprobe, il runtime JavaScript e VLC con `●` verde o `○` rosso; nella web
app la stessa cosa sta in **Impostazioni**. Devono essere tutti verdi, VLC a parte.

Prova reale, in entrambe: incolla un link in **Download** e guarda le fasi scorrere —
risolvendo → metadati → barra → fatto — e il video comparire in libreria. Nella web
app, aprilo: se si riproduce e riesci a spostarti a metà, anche la parte che serve i
byte funziona.

## Facoltativo

- **VLC**, per riprodurre **dalla CLI**. Su Windows viene trovato da sé nelle due
  installazioni tipiche (32 e 64 bit); altrimenti si imposta da Impostazioni. Nella
  web app non serve: si usa il player della pagina.
- **ffprobe** si può omettere: perdi solo la misura reale della risoluzione, e nel
  catalogo finiscono i numeri dei metadati di yt-dlp — che descrivono il *miglior*
  formato disponibile, quindi con un tetto di qualità sono sbagliati per eccesso.
- **Cookie** (un file in formato Netscape, esportato dal browser) per video privati o
  non listati del tuo account: si indica il **percorso** da Impostazioni. Si usano
  solo come **ripiego**, dopo un primo tentativo senza: mandarli insieme al client
  `android_vr` è la combinazione che la CDN di YouTube blocca con 403.
- Variabili d'ambiente per scavalcare la ricerca: `ONDO_ROOT`, `ONDO_YTDLP`,
  `ONDO_FFMPEG`, `ONDO_FFPROBE`.

## Se qualcosa va storto

- **«vcruntime140.dll non trovato»** all'avvio: il binario MSVC lega dinamicamente
  il runtime C. Installa il *Visual C++ Redistributable*, oppure ricompila statico
  con `RUSTFLAGS="-C target-feature=+crt-static" cargo build --release`.
- **Download YouTube che falliscono con 403**: quasi sempre non c'è nessun runtime
  JavaScript nel `PATH` (`deno`, `node`, `quickjs` o `bun` — ne basta uno).
- **«non trovo: yt-dlp (...)»**: i tre eseguibili non sono dove il programma li
  cerca — rileggi il punto 2.
- **La pagina web è bianca o dice «web app non compilata»**: `--web` non punta a una
  cartella che contiene `index.html`. L'API risponde comunque sotto `/api`.
- **Il video non parte nel browser** ma il file c'è: quasi sempre è il **codec**. Il
  selettore evita l'AV1 (dava 403) e finisce spesso su VP9, che Safari e iOS non
  riproducono; Chrome, Edge e Firefox sì.

## Due cose da sapere

`config.json` nasce nella radice al primo cambio di impostazione e **non va copiato
fra macchine**: contiene percorsi locali. I binari esterni invece si ridecidono a
ogni avvio, quindi la stessa cartella-libreria funziona su un'altra macchina senza
portarsi dietro percorsi che lì non esistono.

**Un solo processo per libreria.** Ogni processo tiene `library.json` in memoria e lo
riscrive tutto quando salva: la CLI e il server aperti insieme sulla stessa cartella
si sovrascrivono a vicenda, e così due CLI. È un limite noto, annotato in
`ARCHITETTURA.md`: finché non c'è un lock sul file, la regola è **un solo processo per
libreria**.
