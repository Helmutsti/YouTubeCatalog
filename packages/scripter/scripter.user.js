// ==UserScript==
// @name         Ondo Scripter
// @namespace    ondo-catalog
// @version      1.4.1
// @description  Scarica video YouTube nella libreria Ondo direttamente da youtube.com, senza passare dalla webapp
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

// M93 — client "scripter": parla con l'API del server (packages/server) via
// GM_xmlhttpRequest invece del fetch/EventSource nativi della pagina. Motivo:
// youtube.com è un'origine pubblica (https) e il server gira in locale
// (localhost/127.0.0.1) — Chrome tratta questo salto come Private Network
// Access e lo blocca a meno che il server non risponda al preflight con
// `Access-Control-Allow-Private-Network: true`, cosa che oggi non fa (il CORS
// aperto in packages/server/src/index.js basta per un client same-machine
// "normale", non per una pagina pubblica che chiama verso il locale). Una
// richiesta GM_xmlhttpRequest parte dal contesto privilegiato dell'estensione
// (Tampermonkey/Violentmonkey), non dal motore della pagina: non passa da
// nessuna delle due restrizioni. Prezzo: niente EventSource nativo, quindi
// niente stream SSE (vedi jobManager.js) — la percentuale di avanzamento è
// letta con polling su GET /api/jobs, che ora la espone (vedi `progress` sul
// job in core/src/jobs/jobManager.js, aggiunto apposta per questo client).

(function () {
  'use strict';

  // ── Configurazione ────────────────────────────────────────────────────────
  //
  // Niente indirizzo del server nel menu a tendina in pagina (scelta esplicita:
  // il menu fa solo "scarica"). Si cambia dal menu di Tampermonkey stesso
  // (icona dell'estensione → comandi dello script), che GM_registerMenuCommand
  // aggiunge da solo — un posto che l'utente già conosce, senza inventarne uno
  // nuovo dentro la pagina.
  const DEFAULT_API_BASE = 'http://localhost:3001';
  const DOWNLOAD_JOB_TYPES = new Set(['downloadSingle', 'downloadPending', 'quickDownload']);
  const POLL_MS = 1000;
  const POLL_MS_BACKOFF = 5000; // dopo errori ripetuti (server non raggiungibile)

  function getApiBase() {
    return String(GM_getValue('apiBase', DEFAULT_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, '');
  }
  function setApiBase(value) {
    GM_setValue('apiBase', value);
  }

  GM_registerMenuCommand('Ondo: cambia indirizzo del server…', () => {
    const next = window.prompt('Indirizzo del server Ondo (es. http://localhost:3001):', getApiBase());
    if (next && next.trim()) setApiBase(next.trim());
  });

  // ── API ──────────────────────────────────────────────────────────────────

  function apiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: getApiBase() + path,
        headers: { 'Content-Type': 'application/json' },
        data: body !== undefined ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload(res) {
          let parsed = null;
          try { parsed = res.responseText ? JSON.parse(res.responseText) : null; } catch { /* risposta non JSON */ }
          if (res.status >= 200 && res.status < 300) resolve(parsed);
          else reject(new Error(parsed?.error || `Richiesta fallita (${res.status})`));
        },
        onerror() {
          reject(new Error(`Server non raggiungibile su ${getApiBase()}.`));
        },
        ontimeout() {
          reject(new Error('Richiesta scaduta.'));
        }
      });
    });
  }

  const api = {
    downloadSingle: (url) => apiRequest('POST', '/api/videos/download-single', { url, download: true }),
    listJobs: (limit = 40) => apiRequest('GET', `/api/jobs?limit=${limit}`),
    clearJobs: () => apiRequest('DELETE', '/api/jobs'),
    cancelJob: (id) => apiRequest('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`)
  };

  const RESULT_MESSAGES = {
    'download': 'Download avviato.',
    'already-downloaded': 'Questo video è già scaricato.',
    'already-downloading': 'Il download è già in corso.',
    'already-present': 'Il video è già in libreria.'
  };

  // ── Utility DOM ──────────────────────────────────────────────────────────

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  let toastHost = null;
  function toast(message, kind = 'info') {
    if (!toastHost) {
      toastHost = el('div', { className: 'scripter-toast-host' });
      document.body.appendChild(toastHost);
    }
    const node = el('div', { className: `scripter-toast scripter-toast-${kind}`, text: message });
    toastHost.appendChild(node);
    setTimeout(() => node.classList.add('scripter-toast-out'), 3200);
    setTimeout(() => node.remove(), 3600);
  }

  function resolveThumb(url) {
    if (!url) return null;
    return /^https?:\/\//i.test(url) ? url : getApiBase() + url;
  }

  function currentWatchUrl() {
    if (location.pathname !== '/watch') return null;
    const v = new URLSearchParams(location.search).get('v');
    return v ? `https://www.youtube.com/watch?v=${v}` : null;
  }

  // Estrae l'URL del video da un contenitore-thumbnail, in entrambi i layout
  // che YouTube usa oggi (verificato a mano sulla pagina reale):
  //  - layout "legacy" (ytd-thumbnail, risultati di ricerca/sidebar): il link
  //    è DENTRO il contenitore (`ytd-thumbnail > a#thumbnail`);
  //  - layout "lockup" (yt-thumbnail-view-model, home/griglia/correlati): è il
  //    contrario, il contenitore è DENTRO il link.
  // Alcuni contenitori (shelf, mix, annunci) non hanno nessuno dei due schemi:
  // si salta silenziosamente, non tutti i riquadri devono avere il bottone.
  function extractWatchUrl(thumbEl) {
    const inner = thumbEl.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch"]');
    const href = inner?.getAttribute('href') ?? thumbEl.closest('a[href*="/watch"]')?.getAttribute('href');
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/watch?v=${v}` : null;
    } catch {
      return null;
    }
  }

  // ── Stili ────────────────────────────────────────────────────────────────
  //
  // Riusa le custom property di YouTube (tema chiaro/scuro gratis) con un
  // fallback scuro letterale: se YouTube le rinomina in un redesign futuro
  // (già successo una volta, --yt-spec-* → --yt-sys-color-baseline--*), lo
  // script degrada al fallback invece di sparire.
  //
  // Il bottone sulla thumbnail è visibile SEMPRE (opacità ridotta), non solo
  // al passaggio del mouse come sembrerebbe naturale. Verificato sulla pagina
  // reale: dopo che il mouse resta fermo un attimo su una thumbnail, YouTube
  // sostituisce l'anteprima statica con `ytd-video-preview` (autoplay muto) —
  // un elemento SEPARATO, non dentro `ytd-thumbnail`, con z-index proprio a
  // livello del contenitore condiviso. Un bottone mostrato solo su
  // `ytd-thumbnail:hover` sparisce non appena l'anteprima prende il posto
  // dell'immagine, proprio mentre l'utente ha ancora il mouse lì — quindi
  // niente hover-reveal: il bottone c'è da subito, un click rapido lo trova
  // sempre, prima che l'anteprima abbia il tempo di partire.
  //
  // Viola Ondo (#9184d9, lo stesso accento di packages/web) su ogni controllo
  // cliccabile nostro — non solo un tocco di stile: è il modo in cui l'utente
  // distingue a colpo d'occhio "questo è di Ondo" da "questo è di YouTube",
  // che altrimenti si confondono (icone nello stesso masthead, stessa forma a
  // pillola dei bottoni). Il resto (sfondi, testo) riusa ancora i token di
  // YouTube per restare a tema chiaro/scuro gratis.
  GM_addStyle(`
    :root {
      --ondo-accent: #9184d9;
      --ondo-accent-contrast: #111;
    }
    @keyframes scripter-spin { to { transform: rotate(360deg); } }
    .scripter-btn-icon { display: inline-flex; align-items: center; justify-content: center; }
    .scripter-spinner {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid currentColor; border-top-color: transparent;
      border-radius: 50%; animation: scripter-spin .6s linear infinite;
    }
    .scripter-panel {
      position: absolute; top: 48px; z-index: 2200;
      background: var(--yt-sys-color-baseline--raised-background, #212121);
      color: var(--yt-sys-color-baseline--text-primary, #f1f1f1);
      border: 1px solid var(--ondo-accent);
      border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
    }
    .scripter-dropdown-item {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      padding: 10px 12px; background: none; border: none; border-radius: 8px;
      cursor: pointer; font-size: 14px; color: var(--ondo-accent); font-weight: 600;
    }
    .scripter-dropdown-item:hover { background: color-mix(in srgb, var(--ondo-accent) 18%, transparent); }
    .scripter-history-btn {
      margin-left: 8px; height: 36px; padding: 0 14px; border-radius: 18px;
      background: var(--yt-sys-color-baseline--raised-background, #212121);
      color: var(--ondo-accent);
      border: 1px solid var(--ondo-accent);
      cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      font-size: 14px; font-weight: 600;
    }
    .scripter-history-btn:hover { background: color-mix(in srgb, var(--ondo-accent) 15%, transparent); }
    /* Variante a riga intera per il bottone sotto il video (vedi
       injectWatchActionButton): lì non è più affiancato ad altri bottoni
       nello stesso rigo, quindi niente margine a sinistra, e centrato invece
       che allineato a un fianco. */
    .scripter-watch-btn { margin: 8px 0 0; width: 100%; justify-content: center; }
    /* Stesso esito visivo di is-busy/is-ok/is-error del pallino sulla
       thumbnail, ma qui applicato a un bottone a pillola (quello sotto il
       video): il colore di fondo si spegne/riaccende, il bordo segue. */
    .scripter-history-btn.is-busy { opacity: .7; }
    .scripter-history-btn.is-ok { background: rgba(76,175,80,.25); border-color: #4caf50; color: #4caf50; }
    .scripter-history-btn.is-error { background: rgba(210,80,70,.25); border-color: #f28b82; color: #f28b82; }
    .scripter-badge {
      background: var(--ondo-accent);
      color: var(--ondo-accent-contrast); border-radius: 999px; font-size: 11px; font-weight: 700;
      padding: 1px 6px; min-width: 14px; text-align: center;
    }
    .scripter-panel { left: 0; width: 340px; max-height: 420px; display: flex; flex-direction: column; }
    .scripter-panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--yt-sys-color-baseline--outline, rgba(255,255,255,.15));
      font-size: 14px; font-weight: 600;
    }
    .scripter-clear-btn {
      background: none; border: none; color: var(--ondo-accent);
      cursor: pointer; font-size: 13px; font-weight: 600;
    }
    .scripter-clear-btn:hover { text-decoration: underline; }
    .scripter-panel-list { overflow-y: auto; }
    .scripter-panel-empty, .scripter-panel-error {
      padding: 24px 14px; text-align: center; font-size: 13px;
      color: var(--yt-sys-color-baseline--text-secondary, #aaa);
    }
    .scripter-job-row { display: flex; gap: 10px; padding: 8px 14px; align-items: center; }
    .scripter-job-thumb { width: 64px; height: 36px; border-radius: 6px; object-fit: cover; background: #000; flex: none; }
    .scripter-job-info { flex: 1; min-width: 0; }
    .scripter-job-title {
      font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .scripter-job-status { font-size: 11px; color: var(--yt-sys-color-baseline--text-secondary, #aaa); margin-top: 2px; }
    .scripter-progress {
      height: 3px; background: var(--yt-sys-color-baseline--outline, rgba(255,255,255,.15));
      border-radius: 2px; margin-top: 4px; overflow: hidden;
    }
    .scripter-progress-fill { height: 100%; background: var(--ondo-accent); transition: width .3s linear; }
    .scripter-job-cancel {
      flex: none; width: 24px; height: 24px; border-radius: 50%; border: none; cursor: pointer;
      background: transparent; color: var(--ondo-accent); font-size: 13px;
    }
    .scripter-job-cancel:hover { background: color-mix(in srgb, var(--ondo-accent) 20%, transparent); }
    .scripter-job-status-success { color: #4caf50; }
    .scripter-job-status-failed { color: #f28b82; }

    ytd-thumbnail, yt-thumbnail-view-model { overflow: visible; }
    /* A destra confligge con i controlli che YouTube stesso mostra lì durante
       l'anteprima video al hover (muto/sottotitoli) — a sinistra è libero. */
    .scripter-thumb-wrap { position: absolute; top: 4px; left: 4px; z-index: 100; }
    .scripter-thumb-btn {
      width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer;
      background: var(--ondo-accent); color: var(--ondo-accent-contrast); font-size: 13px;
      display: flex; align-items: center; justify-content: center;
      opacity: .8; transition: opacity .15s;
    }
    .scripter-thumb-btn:hover,
    .scripter-thumb-btn:focus { opacity: 1; }
    .scripter-thumb-btn.is-busy { opacity: 1; }
    .scripter-thumb-btn.is-ok { opacity: 1; background: rgba(76,175,80,.9); color: #fff; }
    .scripter-thumb-btn.is-error { opacity: 1; background: rgba(210,80,70,.9); color: #fff; }
    .scripter-thumb-dropdown {
      position: absolute; top: 30px; left: 0; z-index: 101; min-width: 160px; padding: 6px;
      background: var(--yt-sys-color-baseline--raised-background, #212121);
      color: var(--yt-sys-color-baseline--text-primary, #f1f1f1);
      border: 1px solid var(--ondo-accent); border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.5);
    }

    .scripter-toast-host {
      position: fixed; bottom: 20px; right: 20px; z-index: 3000;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    }
    .scripter-toast {
      background: var(--yt-sys-color-baseline--raised-background, #212121);
      color: var(--yt-sys-color-baseline--text-primary, #f1f1f1);
      border: 1px solid var(--ondo-accent);
      border-radius: 8px; padding: 10px 14px; font-size: 13px; max-width: 320px;
      box-shadow: 0 4px 16px rgba(0,0,0,.4); opacity: 1; transition: opacity .4s;
    }
    .scripter-toast-error { border-color: rgba(210,80,70,.7); }
    .scripter-toast-out { opacity: 0; }
  `);

  // ── Stato job / polling ──────────────────────────────────────────────────
  //
  // Nessuna sottoscrizione push (niente SSE, vedi commento in testa al file):
  // un solo timer di polling condiviso da pannello e badge. Attivo solo
  // quando serve — pannello aperto o almeno un job ancora in corso — così una
  // sessione di solo browsing su YouTube non tiene viva una richiesta al
  // secondo per niente.

  let knownJobs = [];
  let pollTimer = null;
  let pollInterval = POLL_MS;
  let consecutiveFailures = 0;
  let panelEl = null;
  let historyBtnEl = null;

  function hasActiveJobs() {
    return knownJobs.some((j) => j.status === 'queued' || j.status === 'running');
  }
  function panelIsOpen() {
    return panelEl && !panelEl.hidden;
  }

  async function refreshHistory() {
    try {
      const jobs = await api.listJobs(40);
      knownJobs = (jobs ?? []).filter((j) => DOWNLOAD_JOB_TYPES.has(j.type));
      consecutiveFailures = 0;
      pollInterval = POLL_MS;
      renderPanel(null);
      updateBadge();
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) pollInterval = POLL_MS_BACKOFF;
      renderPanel(err.message);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    const tick = async () => {
      await refreshHistory();
      if (panelIsOpen() || hasActiveJobs()) {
        pollTimer = setTimeout(tick, pollInterval);
      } else {
        pollTimer = null;
      }
    };
    pollTimer = setTimeout(tick, 0);
  }

  function updateBadge() {
    if (!historyBtnEl) return;
    const active = knownJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
    const badge = historyBtnEl.querySelector('.scripter-badge');
    if (active > 0) {
      badge.textContent = String(active);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function statusLabel(job) {
    if (job.status === 'success') return 'Completato';
    if (job.status === 'failed') return job.error?.message ? `Errore: ${job.error.message}` : 'Errore';
    if (job.status === 'queued') return 'In coda…';
    if (typeof job.progress === 'number') return `${Math.round(job.progress)}%`;
    return 'In corso…';
  }

  function jobTitle(job) {
    return job.title || job.params?.url || job.params?.videoId || job.type;
  }

  function renderJobRow(job) {
    const thumbUrl = resolveThumb(job.thumbnails?.[0]);
    const thumb = el('img', { className: 'scripter-job-thumb', src: thumbUrl || undefined });
    if (!thumbUrl) thumb.hidden = true;
    thumb.addEventListener('error', () => { thumb.hidden = true; });

    const active = job.status === 'queued' || job.status === 'running';
    const statusEl = el('div', {
      className: `scripter-job-status${job.status === 'success' ? ' scripter-job-status-success' : ''}${job.status === 'failed' ? ' scripter-job-status-failed' : ''}`,
      text: statusLabel(job)
    });

    const info = el('div', { className: 'scripter-job-info' }, [
      el('div', { className: 'scripter-job-title', text: jobTitle(job), title: jobTitle(job) }),
      statusEl
    ]);
    if (active) {
      const pct = typeof job.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : (job.status === 'running' ? 3 : 0);
      info.appendChild(el('div', { className: 'scripter-progress' }, [
        el('div', { className: 'scripter-progress-fill', style: `width:${pct}%` })
      ]));
    }

    const row = el('div', { className: 'scripter-job-row' }, [thumb, info]);
    if (active) {
      row.appendChild(el('button', {
        className: 'scripter-job-cancel', type: 'button', title: 'Annulla', text: '✕',
        onClick: async () => {
          try { await api.cancelJob(job.id); await refreshHistory(); }
          catch (err) { toast(err.message, 'error'); }
        }
      }));
    }
    return row;
  }

  function buildPanel() {
    const list = el('div', { className: 'scripter-panel-list' });
    const panel = el('div', { className: 'scripter-panel', hidden: '' }, [
      el('div', { className: 'scripter-panel-header' }, [
        el('span', { text: 'Download' }),
        el('button', {
          className: 'scripter-clear-btn', type: 'button', text: 'Cancella tutto',
          onClick: async () => {
            try { await api.clearJobs(); await refreshHistory(); }
            catch (err) { toast(err.message, 'error'); }
          }
        })
      ]),
      list
    ]);
    panel.hidden = true;
    document.body.appendChild(panel);
    panelEl = panel;
    return panel;
  }

  function renderPanel(errorMessage) {
    if (!panelEl) return;
    const list = panelEl.querySelector('.scripter-panel-list');
    list.textContent = '';
    if (errorMessage) {
      list.appendChild(el('div', { className: 'scripter-panel-error', text: errorMessage }));
      return;
    }
    if (knownJobs.length === 0) {
      list.appendChild(el('div', { className: 'scripter-panel-empty', text: 'Nessun download.' }));
      return;
    }
    for (const job of knownJobs) list.appendChild(renderJobRow(job));
  }

  // ── Download trigger ─────────────────────────────────────────────────────
  //
  // `resolveVideoInfo` (dentro /api/videos/download-single) chiama yt-dlp e
  // risponde solo a risoluzione finita — qualche secondo, non istantaneo.
  // Cambiare solo l'opacità del bottone lì non bastava a dire "sta
  // funzionando": un'icona che gira, cambiata DAVVERO (non solo attenuata), è
  // il segnale che l'utente aspetta subito dopo il click, prima ancora che
  // arrivi la risposta del server.
  function setButtonState(btn, state) {
    btn.classList.remove('is-busy', 'is-ok', 'is-error');
    const icon = btn.querySelector('.scripter-btn-icon');
    if (!icon) return;
    // NON innerHTML = '': youtube.com applica Trusted Types (CSP), che blocca
    // qualunque scrittura su innerHTML priva di una policy registrata — il
    // blocco faceva fallire silenziosamente ogni click (M93.2, era il bug
    // dietro "non fa niente"). replaceChildren() ottiene lo stesso risultato
    // senza passare da quel sink.
    icon.replaceChildren();
    if (state === 'busy') {
      btn.classList.add('is-busy');
      icon.appendChild(el('span', { className: 'scripter-spinner' }));
    } else if (state === 'ok') {
      btn.classList.add('is-ok');
      icon.textContent = '✓';
    } else if (state === 'error') {
      btn.classList.add('is-error');
      icon.textContent = '✕';
    } else {
      icon.textContent = '⬇';
    }
  }

  async function startDownload(url, triggerBtn) {
    if (triggerBtn) setButtonState(triggerBtn, 'busy');
    try {
      const result = await api.downloadSingle(url);
      toast(RESULT_MESSAGES[result?.action] || 'Fatto.');
      if (triggerBtn) setButtonState(triggerBtn, 'ok');
      await refreshHistory();
      startPolling();
    } catch (err) {
      toast(err.message, 'error');
      if (triggerBtn) setButtonState(triggerBtn, 'error');
    } finally {
      if (triggerBtn) {
        setTimeout(() => setButtonState(triggerBtn, 'idle'), 2000);
      }
    }
  }

  // ── Iniezione: "Scarica con Ondo" fra i bottoni del video ────────────────
  //
  // Prima era un bottone a parte nel masthead, accanto a "Crea": spostato qui
  // — nella riga sotto il titolo, insieme a Mi piace/Condividi/Salva/Scarica —
  // perché è lì che l'utente guarda quando pensa "voglio tenermi questo
  // video", non su in alto vicino a "Crea".
  //
  // M93.1 — NON dentro `#flexible-item-buttons`/`#top-level-buttons-computed`
  // (dove vivono Salva/Scarica nativi): verificato sulla pagina reale con la
  // finestra stretta, YouTube stesso li AZZERA (0 figli, 0×0) quando la riga
  // non ci sta più e sposta i suoi bottoni nel menu "⋮" — un bottone nostro
  // messo lì dentro spariva con loro, invisibile e non cliccabile, pur
  // esistendo nel DOM (è la causa del bug "non fa niente" segnalato: non era
  // il click a non funzionare, era il contenitore a essere collassato a
  // zero). `#actions-inner` (il loro contenitore comune, un livello sopra)
  // non viene mai azzerato da YouTube — ci si appende un bottone a riga
  // intera, sotto invece che affiancato quando lo spazio manca, ma sempre
  // visibile e cliccabile a qualunque larghezza.
  let watchBtnEl = null;

  function injectWatchActionButton() {
    if (location.pathname !== '/watch') return;
    const container = document.querySelector('#actions-inner') || document.querySelector('#actions');
    if (!container) return;
    if (document.getElementById('scripter-watch-btn')) return; // già agganciato

    if (!watchBtnEl) {
      watchBtnEl = el('button', {
        id: 'scripter-watch-btn', className: 'scripter-history-btn scripter-watch-btn', type: 'button', title: 'Ondo — scarica questo video',
        onClick: () => {
          const url = currentWatchUrl();
          if (!url) { toast('Apri un video per scaricarlo.'); return; }
          startDownload(url, watchBtnEl);
        }
      }, [
        el('span', { className: 'scripter-btn-icon', text: '⬇' }),
        document.createTextNode(' Scarica con Ondo')
      ]);
    }

    container.appendChild(watchBtnEl);
  }

  // ── Iniezione: cronologia download (accanto alla ricerca) ───────────────
  //
  // Stesso principio: pannello e bottone si costruiscono una volta (il
  // pannello vive attaccato a `document.body`, fuori da `#center`, quindi
  // sopravvive già da solo alla ri-renderizzazione — è il bottone che va
  // ririagganciato).

  function injectHistoryButton() {
    const center = document.querySelector('ytd-masthead #center');
    if (!center) return;
    if (document.getElementById('scripter-history-btn')) return; // già agganciato

    if (!historyBtnEl) {
      const panel = buildPanel();
      const btn = el('button', {
        id: 'scripter-history-btn', className: 'scripter-history-btn', type: 'button', title: 'Cronologia download'
      }, [
        document.createTextNode('⬇'),
        el('span', { className: 'scripter-badge', hidden: '' })
      ]);
      historyBtnEl = btn;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = panel.hidden;
        panel.hidden = !panel.hidden;
        if (willOpen) {
          const r = btn.getBoundingClientRect();
          panel.style.left = `${Math.round(r.left)}px`;
          panel.style.top = `${Math.round(r.bottom + 8 + window.scrollY)}px`;
          panel.style.position = 'fixed';
          refreshHistory();
          startPolling();
        }
      });
      document.addEventListener('click', (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true;
      });
    }

    center.appendChild(historyBtnEl);
  }

  // ── Iniezione: bottone + menu a comparsa su ogni thumbnail ───────────────
  //
  // Non scarica al click diretto sul pallino: apre un piccolo menu a tendina
  // (stesso pattern del menu nel masthead) con la sola voce "Scarica con
  // Ondo". Oltre a essere coerente con l'altro menu, evita un click accidentale
  // mentre si scorre l'elenco — il pallino da solo, sulle liste dense di
  // risultati, è troppo vicino ad altri controlli per un click diretto sicuro.

  const THUMB_SELECTOR = 'ytd-thumbnail, yt-thumbnail-view-model';
  const PROCESSED_ATTR = 'data-scripter-injected';
  let scanTimer = null;
  let openThumbDropdown = null;

  function closeThumbDropdown() {
    if (openThumbDropdown) { openThumbDropdown.hidden = true; openThumbDropdown = null; }
  }

  function processThumbnails() {
    for (const thumbEl of document.querySelectorAll(THUMB_SELECTOR)) {
      if (thumbEl.hasAttribute(PROCESSED_ATTR)) continue;
      const url = extractWatchUrl(thumbEl);
      if (!url) continue; // shelf/mix/annuncio: niente link riconoscibile, si salta
      thumbEl.setAttribute(PROCESSED_ATTR, '1');

      const dropdown = el('div', { className: 'scripter-thumb-dropdown', hidden: '' }, [
        el('button', {
          className: 'scripter-dropdown-item', type: 'button', text: 'Scarica con Ondo',
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeThumbDropdown();
            startDownload(url, btn);
          }
        })
      ]);
      dropdown.hidden = true;

      const btn = el('button', {
        className: 'scripter-thumb-btn', type: 'button', title: 'Ondo — scarica video',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          const willOpen = dropdown.hidden;
          closeThumbDropdown();
          if (willOpen) {
            dropdown.hidden = false;
            openThumbDropdown = dropdown;
          }
        }
      }, [el('span', { className: 'scripter-btn-icon', text: '⬇' })]);

      thumbEl.appendChild(el('div', { className: 'scripter-thumb-wrap' }, [btn, dropdown]));
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; processThumbnails(); }, 250);
  }

  function observeThumbnails() {
    processThumbnails();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  }

  // Chiude il menu di una thumbnail al click altrove — stesso pattern del menu
  // del masthead. I bottoni che aprono un menu chiamano già stopPropagation
  // sul proprio click, quindi non richiudono se stessi qui.
  document.addEventListener('click', closeThumbDropdown);

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  //
  // ytd-masthead esiste da subito su youtube.com, ma i suoi contenuti NON
  // sono stabili: verificato sulla pagina reale, un bottone iniettato in
  // `#end #buttons` spariva passando dalla home a un video, perché YouTube
  // ri-renderizza quel contenitore nella navigazione SPA e butta via
  // qualunque figlio non suo — capita anche se l'id resta lo stesso. Lo
  // stesso vale, ancora di più, per `#flexible-item-buttons` sotto il video:
  // cambia ad ogni video, non solo ad ogni navigazione. Un MutationObserver
  // mirato su un nodo specifico sarebbe fragile quanto il nodo stesso; un
  // controllo periodico invece non deve indovinare QUANDO YouTube
  // ri-renderizza, gli basta guardare ogni paio di secondi se il bottone c'è
  // ancora — le tre `inject*` sono già idempotenti (escono subito se l'id è
  // già presente, o se non è una pagina `/watch`), quindi il costo di
  // richiamarle a vuoto è solo un paio di querySelector.
  function boot() {
    injectWatchActionButton();
    injectHistoryButton();
    observeThumbnails();
    refreshHistory().then(() => { if (hasActiveJobs()) startPolling(); });
    setInterval(() => {
      injectWatchActionButton();
      injectHistoryButton();
    }, 2000);
  }

  function waitForMasthead() {
    if (document.querySelector('ytd-masthead #end #buttons') && document.querySelector('ytd-masthead #center')) {
      boot();
      return;
    }
    setTimeout(waitForMasthead, 300);
  }

  waitForMasthead();
})();
