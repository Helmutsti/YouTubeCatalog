# YouTube Catalog (Ondo) — core + CLI

Archivio personale e locale dei video YouTube dei tuoi creator preferiti: li scarica per non perderli, li cataloga e li rende sfogliabili e riproducibili da un menu a terminale.

Strumento **locale, single-user**. Un solo linguaggio (Node.js), nessun Python.

> **Questo branch (`node-core`) contiene solo il core e la CLI.** La **web app** e l'**API HTTP** vivono sul branch **`main`** e da lì verranno migrate quando core e CLI saranno chiusi: qui non ne esiste una copia, di proposito — due versioni divergenti dello stesso frontend sarebbero peggio di nessuna. Per usare la web app: `git checkout main`.

---

## Installazione

Serve **Node.js 20 o superiore** (<https://nodejs.org>, include `npm`). Nient'altro: yt-dlp e ffmpeg se li procura il progetto.

Dalla cartella del progetto, tre comandi:

```bash
npm install      # dipendenze (solo @inquirer/prompts: il core non ne ha nessuna)
npm run setup    # scarica yt-dlp + ffmpeg + ffprobe in tools/ (per il tuo sistema)
npm run cli      # apre il menu a terminale
```

Le cartelle `media/` e i file in `data/` vengono creati da soli al primo avvio: non devi preparare nulla a mano.

> **Aggiornare yt-dlp.** YouTube cambia spesso e un yt-dlp vecchio smette di scaricare. Se i download iniziano a fallire, esegui `npm run setup -- --force`: riscarica l'ultima versione.

> **Se hai già ffmpeg installato** nel sistema, `npm run setup` se ne accorge e non lo riscarica.

---

## Solo i sotto-comandi da terminale (senza clonare il repo)

Se non ti serve il menu interattivo a frecce ma solo i comandi (`video`, `author`, `source`) da uno script o da terminale, non serve clonare il repo: dalle [Release](https://github.com/Helmutsti/YouTubeCatalog/releases) viene pubblicato un pacchetto standalone, installabile con un solo comando.

Serve **Node.js 20 o superiore**.

```bash
npm install -g https://github.com/Helmutsti/YouTubeCatalog/releases/download/<tag>/ondo-cli-<tag>.tgz
ondo setup   # scarica yt-dlp + ffmpeg + ffprobe in tools/ (per il tuo sistema)
```

(sostituisci `<tag>` con la versione che vuoi, es. `v1.0.0`)

```bash
ondo --help
ondo video --help
ondo author --help
ondo source --help
```

Questo pacchetto **non include il menu interattivo** (`ondo` senza argomenti stampa un messaggio invece di aprirlo) — per quello serve l'installazione completa qui sopra.

---

## Uso

```bash
npm run cli
```

Tutto navigabile con le **frecce**, nessun comando da digitare. Quattro voci:

| Voce | Cosa fa |
|---|---|
| **Cerca** | Ricerca esatta su titolo, autore, tag e descrizione; dai risultati si agisce sul video. |
| **Libreria** | Tutti i video, per autore, preferiti, da scaricare, archiviati, rimossi da YouTube, falliti. Su un video: riproduci (VLC), solo audio, preferito, archivia, togli dalla libreria. |
| **Download rapido** | Incolli uno o più link e guardi le barre di avanzamento dal vivo. Esc torna al menu **senza fermare i download**. |
| **Impostazioni** | Stato e percorsi (cartelle, binari, runtime JS, VLC), qualità predefinita, quanti download in parallelo. |

I download continuano mentre navighi. Uscire con download attivi te lo chiede prima.

**Tasti**: le frecce per muoverti, Invio per scegliere, **`Esc` per tornare indietro** (da qualsiasi elenco, senza scorrere fino a «← indietro»), **`Ctrl-C` per uscire** dal programma.

---

## Configurazione

Tutto sta in `data/config.json`, creato da solo al primo avvio con valori sensati (`data/config.example.json` è il modello). Quasi tutto si cambia dal menu **Impostazioni**; a mano, i campi che contano:

| Campo | A cosa serve |
|---|---|
| `videosRoot` | Cartella dei **file video**. Default `null` = dentro `media/videos`. Impostala per tenerli su un altro disco, es. `"D:\\YouTube\\Video"`. |
| `mediaRoot` | Cartella di copertine e avatar (default `./media`). |
| `quality` | Qualità predefinita: `"best"`, `"ask"` (chiede a ogni download) o `{ "height": 1080 }`. |
| `jobs.parallel` | Quanti download insieme (default `1`). Si può cambiare a caldo. |
| `playback.vlcPath` | Percorso di `vlc.exe`, per la riproduzione. |

> Nei percorsi Windows dentro il JSON serve la **doppia** backslash: `"D:\\YouTube\\Video"`.

> **Se il disco di `videosRoot` non è collegato, l'app non parte** (`ENOENT ... mkdir`). È un difetto noto, registrato in [`docs/PIANO.md`](docs/PIANO.md) → "Bug noti". Ripiego: ricollega il disco, o rimetti `videosRoot` a `null`.

---

## Video privati o non listati (facoltativo)

Se ti servono video privati o non listati del tuo account, yt-dlp deve autenticarsi:

1. Esporta i cookie di YouTube in **formato Netscape** (es. con l'estensione "Get cookies.txt LOCALLY").
2. Salva il file come `core/cookies.txt`.

Se il file non c'è, tutto funziona lo stesso. Non viene mai versionato.

---

## Altro

| | |
|---|---|
| Come funziona e perché (stato attuale) | [`docs/documentazione.md`](docs/documentazione.md) |
| Regole di progetto e architettura | [`docs/progetto.md`](docs/progetto.md) |
| Cosa manca da fare | [`docs/PIANO.md`](docs/PIANO.md) |
| Storia completa, milestone per milestone | [`docs/storico.md`](docs/storico.md) |
| Progetto del core in Rust (ABI C) — su carta, abbandonato | [`docs/rust-core.md`](docs/rust-core.md) |

> **Piattaforme.** Nato e usato su **Windows**. `npm run setup` e il codice scelgono i binari giusti anche su **Linux** e **macOS**, ma il supporto lì non è ancora verificato end-to-end.
