# Deploy Docker su QNAP (M63)

Guida per far girare Ondo (catalogo YouTube locale) in un container Docker sul
NAS QNAP. Un **unico** container serve sia l'API (`/api`, `/media`) sia la Web
GUI: dal browser di qualsiasi dispositivo in LAN apri l'app puntando a
`http://<IP-del-NAS>:3001`.

I video vivono su una cartella del NAS (montata come volume); il binario
**yt-dlp** sta anch'esso in un volume, così lo aggiorni sostituendo il file
senza ricostruire l'immagine.

---

## 1. Prima di iniziare: architettura del NAS

L'immagine è pensata per QNAP **x86_64** (Intel/AMD — la maggioranza). Per
scoprire l'architettura, apri una shell sul NAS (SSH o Container Station →
terminale) ed esegui:

```sh
uname -m
```

- `x86_64` → tutto pronto, prosegui.
- `aarch64` / `armv7l` → il NAS è **ARM**: il binario ufficiale `yt-dlp_linux`
  è solo x86_64 e **non funziona**. Opzioni: usare un'immagine base ARM con
  `yt-dlp` installato via `pip` (Python), oppure un binario yt-dlp ARM
  dedicato. Non è coperto out-of-the-box da questa immagine — chiedi supporto
  se il tuo NAS è ARM.

---

## 2. Struttura delle cartelle sul NAS

Crea sul NAS (es. sotto `/share/Container/youtubecatalog/`) queste cartelle,
che diventeranno i volumi del container:

| Cartella host | Monta su | Contenuto |
|---|---|---|
| `data/`   | `/app/data`          | Catalogo (`catalog.json`), config, job, metadati |
| `media/`  | `/app/media`         | Copertine e avatar (piccoli) |
| `videos/` | `/app/media/videos`  | **I video** (grandi) — qui punti la tua cartella-video sul NAS |
| `tools/`  | `/app/tools`         | Il binario `yt-dlp_linux` |

`videos/` può essere una cartella su un volume/share diverso (magari il disco
più capiente): è il senso di tenerla separata.

### Metti il binario yt-dlp in `tools/`

Scarica il binario Linux ufficiale e rendilo eseguibile:

```sh
cd /share/Container/youtubecatalog/tools
curl -L -o yt-dlp_linux https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x yt-dlp_linux
```

ffmpeg **non** serve scaricarlo: è già dentro l'immagine.

---

## 3. Avvio con docker-compose

Copia sul NAS il progetto (o almeno `Dockerfile`, `docker-compose.yml`, le
cartelle `core/`, `packages/`, e i manifest). Adatta i percorsi host in
`docker-compose.yml` alle tue cartelle reali, poi:

```sh
docker compose up -d --build
```

Apri `http://<IP-del-NAS>:3001` dal browser. Se la porta 3001 è occupata,
cambia la parte sinistra della mappatura in `docker-compose.yml` (es.
`"8080:3001"`) e accedi su quella porta.

### Via Container Station (GUI QNAP)

Container Station supporta le "Application" da `docker-compose.yml`:
**Applications → Create → Import** il file compose, sistema i percorsi delle
cartelle host nei volumi, avvia. In alternativa builda l'immagine da riga di
comando (SSH) come sopra e poi gestiscila dalla GUI.

---

## 4. Aggiornare yt-dlp

YouTube cambia spesso e yt-dlp va aggiornato periodicamente. Con il binario in
un volume **non serve ricostruire l'immagine**: basta sostituire il file e
riavviare il container (per svuotare la cache in memoria del catalogo/processo).

```sh
cd /share/Container/youtubecatalog/tools
curl -L -o yt-dlp_linux https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x yt-dlp_linux
docker compose restart youtubecatalog
```

---

## 5. Cookie per video privati/non listati (facoltativo)

Se ti servono, esporta i cookie YouTube in formato Netscape (estensione tipo
"Get cookies.txt LOCALLY"), salvali come `cookies.txt` sul NAS e scommenta la
riga nel `docker-compose.yml`:

```yaml
      - ./cookies.txt:/app/core/cookies.txt:ro
```

---

## 6. Note

- **Nessuna autenticazione**: l'app è single-user e non protegge l'accesso.
  Tienila su una LAN fidata; non esporla direttamente su Internet senza un
  reverse proxy con autenticazione davanti.
- **VLC non è nel container**: la riproduzione "solo audio/video con VLC" del
  CLI non esiste qui — la Web GUI riproduce i video nel browser (`<video>`),
  streaming diretto da `/media`. Nessuna funzione persa lato web.
- **Riavvia dopo modifiche esterne**: se modifichi `data/config.json` o i file
  del catalogo da fuori mentre il container gira, riavvialo — il processo tiene
  il catalogo in memoria e non lo rilegge da disco finché resta vivo.
- **Permessi**: assicurati che l'utente del container possa leggere/scrivere le
  cartelle montate (su QNAP di solito è sufficiente; in caso di errori di
  scrittura verifica i permessi delle cartelle host).
