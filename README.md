# Ondo

Archivio video locale: scarica i video dei creator che ti interessano prima che
spariscano, li tiene in ordine per autore e li rende cercabili. Un catalogo in un
file JSON, una CLI a menu, download in parallelo.

Due pezzi: `ondo` (la libreria) e `ondo-cli` (i menu). Il disegno sta in
[`ARCHITETTURA.md`](ARCHITETTURA.md); qui c'è solo come metterlo in funzione.

Sono **due guide distinte**: *compilare* produce il binario e riguarda chi lavora al
codice; *installare* mette in funzione un binario già compilato su una macchina che
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

Nient'altro: le dipendenze del progetto sono poche (`serde`, `serde_json`,
`dialoguer`, `console`, `crossterm`) e le prende `cargo` da sé.

## Compilare

```bash
git clone <url-del-repo> ondo
cd ondo
git checkout rust-core
cargo build --release
```

Il risultato è **un solo file**:

```
target/release/ondo.exe     (~1,1 MB su Windows; ondo su Linux/macOS)
```

È quello che serve per l'installazione: non ci sono altri file da portarsi dietro,
né un binario ausiliario da tenere accanto.

## Controllare che sia sano

```bash
cargo test              # 33 test, nessuna rete richiesta
```

I test non toccano internet: il percorso di download riuscito è coperto con un
yt-dlp **finto**, quindi girano anche offline.

## Lavorare al codice

```bash
cargo run -p ondo-cli                        # la CLI, dalla build di debug
cargo run --example scarica -- <URL>         # solo la libreria, senza menu
cargo run --example scarica -- --vivo <URL>  # come fa la console: rilegge il pool
cargo run --example scarica                  # elenca cosa c'è in libreria
```

In sviluppo i binari esterni (vedi sotto) vanno bene anche in `tools/` nella radice
del progetto, perché la ricerca guarda `./tools/` relativo alla cartella corrente e
tu lanci da lì.

---

# 2. Installazione

Su una macchina che deve solo **usare** Ondo. Rust, git e il codice sorgente non
servono: basta il binario compilato al punto 1 (tuo o preso da un'altra macchina
con lo stesso sistema operativo).

## Cosa serve

- **`ondo.exe`**, copiato dove vuoi.
- **yt-dlp**, **ffmpeg** e **ffprobe**: tre eseguibili, **non inclusi nel repo**
  (`/tools/` è ignorato da git: peserebbero ~300 MB per versione nella history).

Ondo non ha altre dipendenze. Ne ha una **yt-dlp**, e riguarda solo YouTube: per
calcolare i parametri offuscati che YouTube mette negli URL dei flussi deve
eseguire il JavaScript del player, quindi gli serve un runtime JavaScript sulla
macchina — va bene **uno qualunque** fra `deno`, `node`, `quickjs`, `bun`. Se non ce
n'è nessuno i download da YouTube muoiono a metà con **403**; gli altri siti non se
ne accorgono. La CLI ti dice all'avvio se non ne trova, e in *Stato e percorsi*
mostra quale sta usando.

## I passi

**1. La cartella della libreria.** È dove finiscono catalogo, video, copertine e
metadati. Chiamala come vuoi; l'esempio usa `ondo-data`.

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

**3. Lancia.**

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

## Verificare l'installazione

Se manca un binario, la CLI lo dice **all'avvio**, non a metà del primo download.
Per il resto: **Impostazioni → Stato e percorsi** elenca radice, cartelle, yt-dlp,
ffmpeg, ffprobe e VLC con `●` verde o `○` rosso. Devono essere tutti verdi, VLC a
parte.

Prova reale: **Download rapido**, incolla un link, Invio. Devi vedere le fasi
scorrere — risolvendo → metadati → barra → fatto — e il video comparire in
**Libreria**.

## Facoltativo

- **VLC**, per riprodurre. Su Windows viene trovato da sé nelle due installazioni
  tipiche (32 e 64 bit); altrimenti si imposta da Impostazioni. Senza VLC tutto il
  resto funziona.
- **ffprobe** si può omettere: perdi solo la misura reale della risoluzione, e nel
  catalogo finiscono i numeri dei metadati di yt-dlp — che descrivono il *miglior*
  formato disponibile, quindi con un tetto di qualità sono sbagliati per eccesso.
- **Cookie** (`cookies.txt` in formato Netscape, esportato dal browser) per video
  privati o non listati del tuo account. Si impostano da Impostazioni e si usano
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

## Due cose da sapere

`config.json` nasce nella radice al primo cambio di impostazione e **non va copiato
fra macchine**: contiene percorsi locali. I binari esterni invece si ridecidono a
ogni avvio, quindi la stessa cartella-libreria funziona su un'altra macchina senza
portarsi dietro percorsi che lì non esistono.

**Un solo processo per libreria.** Ogni processo tiene `library.json` in memoria e
lo riscrive tutto quando salva: due `ondo` sulla stessa cartella si sovrascrivono a
vicenda. È un limite noto, annotato in `ARCHITETTURA.md`.
