# YouTube Catalog (Ondo)

Archivio personale e locale dei video YouTube dei tuoi creator preferiti: li scarica per non perderli, li cataloga e li rende sfogliabili e riproducibili da una web app o da un menu a terminale.

Strumento **locale, single-user**. Un solo linguaggio (Node.js), nessun Python.

---

## Installazione

Serve **Node.js 20 o superiore** (<https://nodejs.org>, include `npm`). Nient'altro: yt-dlp e ffmpeg se li procura il progetto.

Dalla cartella del progetto, tre comandi:

```bash
npm install      # dipendenze di tutti i pacchetti
npm run setup    # scarica yt-dlp + ffmpeg in tools/ (per il tuo sistema)
npm run serve    # compila la web app e avvia il server
```

Poi apri **<http://localhost:3001>**.

Le cartelle `media/` e i file in `data/` vengono creati da soli al primo avvio: non devi preparare nulla a mano.

> **Aggiornare yt-dlp.** YouTube cambia spesso e un yt-dlp vecchio smette di scaricare. Se i download iniziano a fallire, esegui `npm run setup -- --force`: riscarica l'ultima versione.

> **Se hai già ffmpeg installato** nel sistema, `npm run setup` se ne accorge e non lo riscarica.

---

## Uso

### Web app (consigliata)

`npm run serve`, poi <http://localhost:3001>. Da lì: aggiungi playlist come fonti, sincronizza, scarica, cerca, guarda, gestisci impostazioni e backup.

Per aprirla da un telefono o un altro PC di casa, usa `http://<IP-di-questa-macchina>:3001` (**l'indirizzo IP**, non il nome del PC). Dettagli e casi problematici: [`docs/avvio-avanzato.md`](docs/avvio-avanzato.md).

### Menu a terminale

```bash
npm run cli
```

Tutto navigabile con le **frecce**, nessun comando da digitare. Fa le stesse cose della web app, più la riproduzione con VLC. Non richiede che il server sia avviato.

---

## Configurazione

Tutto sta in `data/config.json`, creato da solo al primo avvio con valori sensati (`data/config.example.json` è il modello). I campi che potresti voler cambiare:

| Campo | A cosa serve |
|---|---|
| `videosRoot` | Cartella dei **file video**. Default `null` = dentro `media/videos`. Impostala per tenerli su un altro disco, es. `"D:\\YouTube\\Video"`. |
| `mediaRoot` | Cartella di copertine e avatar (default `./media`). |
| `port` | Porta del server (default `3001`). |
| `playback.vlcPath` | Percorso di `vlc.exe`, solo per la riproduzione via VLC dal menu a terminale. |

> Nei percorsi Windows dentro il JSON serve la **doppia** backslash: `"D:\\YouTube\\Video"`.

Le stesse cartelle si possono spostare anche dalla pagina **Impostazioni** della web app.

---

## Video privati o non listati (facoltativo)

Se la tua playlist contiene video privati o non listati del tuo account, yt-dlp deve autenticarsi:

1. Esporta i cookie di YouTube in **formato Netscape** (es. con l'estensione "Get cookies.txt LOCALLY").
2. Caricali dalla pagina **Impostazioni** della web app, oppure salva il file come `core/cookies.txt`.

Se il file non c'è, tutto funziona lo stesso. Non viene mai versionato.

---

## Backup

Dalla pagina **Impostazioni** (o dal menu **Backup / Ripristino** del CLI) si scarica un `.zip` con **tutto lo stato tranne i file video**: catalogo, metadati, storico, impostazioni, copertine e avatar.

Al ripristino i file attuali vengono prima copiati in `data/pre-restore-<data-ora>/`: nulla viene cancellato. **Dopo un ripristino riavvia il server**, perché lo stato è tenuto in memoria.

---

## Altro

| | |
|---|---|
| Avvio in LAN, sviluppo con hot-reload, risoluzione problemi di rete | [`docs/avvio-avanzato.md`](docs/avvio-avanzato.md) |
| Deploy su NAS / QNAP con Docker | [`docs/DOCKER.md`](docs/DOCKER.md) |
| Come funziona e perché (stato attuale) | [`docs/documentazione.md`](docs/documentazione.md) |
| Regole di progetto e architettura | [`docs/progetto.md`](docs/progetto.md) |
| Cosa manca da fare | [`docs/PIANO.md`](docs/PIANO.md) |
| Progetto del core in Rust (ABI C) — su carta | [`docs/rust-core.md`](docs/rust-core.md) |

> **Piattaforme.** Nato e usato su **Windows**. `npm run setup` e il codice scelgono i binari giusti anche su **Linux** e **macOS**, ma il supporto lì non è ancora verificato end-to-end.
