# scripter

Userscript per Tampermonkey (o Violentmonkey): parla con l'API di `@catalog/server`
direttamente da youtube.com, senza passare dalla webapp.

## Cosa fa

- Un bottone nel masthead (in alto a destra) con un menu a tendina: **Scarica
  questo video** — scarica il video della pagina `/watch` aperta al momento.
- Un bottone di download su ogni thumbnail (home, ricerca, canale, correlati):
  un click e quel video va in coda, senza aprirlo.
- Un bottone **cronologia download** accanto alla barra di ricerca: apre un
  pannello in stile "download di Chrome" — barra di avanzamento per i job in
  corso (aggiornata ogni secondo), completati con segno di spunta, e un
  pulsante **Cancella tutto**.

## Installazione

1. Il server deve essere avviato (`npm run web:start` dalla cartella del
   progetto, o `npm run web` per build+avvio) — lo script parla con
   `http://localhost:3001` di default.
2. Installa [Tampermonkey](https://www.tampermonkey.net/) (o Violentmonkey) nel
   browser.
3. Apri il pannello di Tampermonkey → **Crea un nuovo script**, cancella il
   contenuto d'esempio e incolla tutto `scripter.user.js` — oppure, più comodo,
   **Utilità → Importa da file** e seleziona `scripter.user.js` direttamente.
4. Salva. Apri (o ricarica) youtube.com.

## Cambiare l'indirizzo del server

Se il server non gira su `http://localhost:3001` (porta diversa, o macchina
diversa in LAN): icona di Tampermonkey nella barra del browser → **Ondo:
cambia indirizzo del server…** nell'elenco dei comandi dello script.

Se l'indirizzo è un host diverso da `localhost`/`127.0.0.1`, Tampermonkey
chiederà un permesso di connessione la prima volta (whitelist `@connect` nello
script — dichiarata solo per `localhost`/`127.0.0.1`, l'uso previsto).

## Perché GM_xmlhttpRequest e non fetch/EventSource nativi

youtube.com è un'origine pubblica (https); il server gira in locale. Chrome
tratta una richiesta da pagina pubblica verso un indirizzo locale come
*Private Network Access* e la blocca a meno che il server non risponda al
preflight con `Access-Control-Allow-Private-Network: true` — cosa che oggi non
fa. `GM_xmlhttpRequest` parte dal contesto dell'estensione, non dalla pagina:
non passa da questa restrizione (né dal CORS normale). Il costo: niente
`EventSource`, quindi niente stream degli eventi di job in tempo reale — la
percentuale di avanzamento è letta con polling su `GET /api/jobs` (un
secondo), non via push.

## Limiti noti

- Le thumbnail coperte da tag/layout che il codice non riconosce (annunci,
  scaffali "Mix", alcune card promozionali) restano senza bottone: si salta
  invece di rischiare un bottone piazzato male.
- Se YouTube cambia ancora la struttura delle sue thumbnail (già successo una
  volta durante lo sviluppo di questo script, `ytd-thumbnail` →
  `yt-thumbnail-view-model`), il bottone sulle thumbnail può smettere di
  comparire finché il selettore in `scripter.user.js` non viene aggiornato. I
  due bottoni del masthead sono su elementi più stabili e più difficili da
  rompere.
