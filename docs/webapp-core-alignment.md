# Allineamento web GUI ↔ core

Funzionalità già presenti nel `core` di questo branch (nate per la CLI `ondo`/`packages/cli`) ma senza ancora una controparte in `packages/web`. Non riguardano il `core` stesso — servono solo a tracciare cosa la web GUI potrebbe esporre in futuro.

## 1. Qualità di download globale

`core/src/quality.js` — `getQuality`/`setQuality`/`QUALITY_LEVELS`.

Nessuna pagina/voce di configurazione nella web per impostare un default. La web può comunque scegliere risoluzione/audio per singolo download (`POST /videos/:id/download` accetta già `maxHeight`/`audioStrategy` per richiesta); manca solo l'impostazione di un default globale.

## 2. Coda link

`core/src/services/queueService.js` — `listQueue`/`enqueueLink`/`dequeueLink`/`clearFailedLinks`.

Usata solo dal comando `quick` della CLI, per accodare un link incollato quando non è ancora risolvibile. Nessuna route/UI web equivalente.

## 3. Playback via VLC

`core/src/services/playbackService.js` — `playVideo`.

La CLI apre VLC sulla macchina locale. La web GUI riproduce direttamente nel browser via `/media/videos`, quindi non ne ha bisogno per l'uso normale — resta un gap solo se in futuro serve un "apri in VLC" anche dalla web.

## 4. Installazione automatica strumenti

`core/src/services/toolsSetupService.js` — `setupTools`, dietro il comando `ondo setup`.

La pagina impostazioni della web si limita ad avvisare se yt-dlp/ffmpeg/ffprobe mancano (`reportToolsOnStartup`), senza un'azione per installarli.

## 5. `libraryViewService`

`core/src/services/libraryViewService.js`.

Modello dati pensato per la CLI (shape `Video` piatta con `state`/`filter`/ricerca dedicata). La web usa direttamente `videoService`/`catalogStore`, quindi non è coinvolta — non è un gap funzionale, solo una via di accesso diversa agli stessi dati.
