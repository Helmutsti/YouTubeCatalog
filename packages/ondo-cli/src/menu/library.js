// M86 — traduzione di `cli/src/library.rs`.
//
// Il menu Libreria: le viste, e le azioni su un singolo video.

import { existsSync } from 'node:fs';

import * as core from '@catalog/core';
import * as ui from './ui.js';
import { FILTER, STATE } from './ondo.js';

const BACK = Symbol('back');

// `confirm` che si può annullare come nell'originale: Esc/Ctrl-C valgono "no"
// (M88: l'Esc passa da `ui.confirmOpt`, che ritorna `null` per "annullato" —
// qui, su una domanda sì/no, annullare *è* rispondere no).
async function confirmOpt(message, defaultValue = false) {
  return (await ui.confirmOpt({ message, defaultValue })) === true;
}

export async function open(app) {
  while (true) {
    await app.pump();
    ui.screen('Libreria', app);

    const daScaricare =
      app.lib.count(FILTER.PENDING) + app.lib.queue().filter((q) => !q.error).length;
    const falliti = app.lib.count(FILTER.FAILED) + app.lib.queue().filter((q) => q.error).length;

    const voci = [
      { name: `Tutti i video (${app.lib.count(FILTER.ALL)})`, value: FILTER.ALL },
      { name: `Autori (${app.lib.authors().length})`, value: 'authors' },
      { name: `Preferiti (${app.lib.count(FILTER.FAVORITES)})`, value: FILTER.FAVORITES },
      { name: `Da scaricare (${daScaricare})`, value: 'pending' },
      { name: `Archiviati (${app.lib.count(FILTER.ARCHIVED)})`, value: FILTER.ARCHIVED },
      { name: `Rimossi da YouTube (${app.lib.count(FILTER.REMOVED)})`, value: FILTER.REMOVED },
      { name: `Falliti (${falliti})`, value: 'failed' },
      { name: '← indietro', value: BACK }
    ];

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value, pageSize: voci.length });
    if (scelta === null || scelta === BACK) return;
    if (scelta === 'authors') await authorsView(app);
    else if (scelta === 'pending') await pendingView(app);
    else if (scelta === 'failed') await failedView(app);
    else await listView(app, scelta);
  }
}

/** Una vista semplice: elenco di video, si scelgono per agire. */
async function listView(app, filter) {
  while (true) {
    await app.pump();
    ui.screen(`Libreria · ${core.filterLabel(filter)}`, app);

    const video = app.lib.list(filter);
    if (video.length === 0) console.log("Non c'è niente qui.\n");

    const voci = [
      ...video.map((v) => ({ name: ui.videoLine(v), value: v.id })),
      { name: '← indietro', value: BACK }
    ];

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value });
    if (scelta === null || scelta === BACK) return;
    await actions(app, scelta);
  }
}

async function authorsView(app) {
  while (true) {
    await app.pump();
    ui.screen('Libreria · autori', app);

    const autori = app.lib.authors();
    const voci = [
      ...autori.map((a) => ({ name: `${a.author}  (${a.count})`, value: a.author })),
      { name: '← indietro', value: BACK }
    ];

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value });
    if (scelta === null || scelta === BACK) return;
    const autore = scelta;

    while (true) {
      await app.pump();
      ui.screen(`Libreria · ${autore}`, app);
      const video = app.lib.byAuthor(autore);
      // M88 — qui l'autore è già nell'intestazione: le righe non lo ripetono.
      const vociVideo = [
        ...video.map((v) => ({ name: ui.videoLine(v, { autore: false }), value: v.id })),
        { name: '← indietro', value: BACK }
      ];

      const sceltaVideo = await ui.selectOpt({ choices: vociVideo, defaultValue: vociVideo[0].value });
      if (sceltaVideo === null || sceltaVideo === BACK) break;
      await actions(app, sceltaVideo);
    }
  }
}

/**
 * "Da scaricare" mette insieme due cose che per l'utente sono la stessa: i video
 * risolti che aspettano il disco, e i link appena incollati che non hanno ancora
 * un id.
 */
async function pendingView(app) {
  while (true) {
    await app.pump();
    ui.screen('Libreria · da scaricare', app);

    // Chi sta scaricando adesso va in cima e lo dice: sta succedendo, non è in
    // attesa come gli altri. L'ordinamento è stabile, quindi dentro i due gruppi
    // resta l'ordine di `list`.
    const video = app.lib
      .list(FILTER.PENDING)
      .map((v, i) => ({ v, i }))
      .sort((a, b) => {
        const aDown = a.v.state === STATE.DOWNLOADING ? 0 : 1;
        const bDown = b.v.state === STATE.DOWNLOADING ? 0 : 1;
        return aDown - bDown || a.i - b.i;
      })
      .map((x) => x.v);

    const links = app.lib.queue().filter((q) => !q.error).map((q) => q.url);

    const voci = [];
    const scaricaTutti = video.length > 0 || links.length > 0;
    if (scaricaTutti) {
      voci.push({ name: `Scarica tutti (${video.length + links.length})`, value: 'all' });
    } else {
      console.log('Niente in attesa.\n');
    }
    for (const v of video) {
      const tag = v.state === STATE.DOWNLOADING ? 'In download' : 'In attesa';
      voci.push({ name: ui.videoLineTagged(v, tag), value: { video: v.id } });
    }
    for (const url of links) {
      voci.push({
        name: `${ui.style.yellow('○')} ${url}  ${ui.style.cyan('da risolvere')}`,
        value: { link: url }
      });
    }
    voci.push({ name: '← indietro', value: BACK });

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value });
    if (scelta === null || scelta === BACK) return;

    if (scelta === 'all') {
      // La risoluzione si chiede **una volta** per tutto il gruppo: chiederla
      // per ognuno sarebbe un interrogatorio.
      const cap = await ui.resolveQuality(app.lib.config().quality, 'Che risoluzione, per tutti?');
      if (cap === null) continue;

      let n = 0;
      let inCorso = 0;
      for (const v of video) {
        // Chi sta già scaricando si lascia in pace: rimetterlo in coda vorrebbe
        // dire un secondo download sullo stesso video.
        if (v.state === STATE.DOWNLOADING) {
          inCorso += 1;
          continue;
        }
        const url = await app.lib.retry(v.id);
        if (url) {
          app.dl.pushWith(url, cap.maxHeight);
          n += 1;
        }
      }
      for (const url of links) {
        app.dl.pushWith(url, cap.maxHeight);
        n += 1;
      }
      const salta = inCorso > 0 ? ` (${inCorso} già in corso, lasciati stare)` : '';
      ui.ok(app, `${n} accodati${salta} — guardali in «Download rapido»`);
    } else if (scelta.video) {
      await actions(app, scelta.video);
    } else if (scelta.link) {
      await linkActions(app, scelta.link);
    }
  }
}

/**
 * I falliti, con il loro motivo: video che hanno provato e link che non si sono
 * nemmeno lasciati risolvere.
 */
async function failedView(app) {
  while (true) {
    await app.pump();
    ui.screen('Libreria · falliti', app);

    const video = app.lib.list(FILTER.FAILED);
    const linkFalliti = app.lib.queue().filter((q) => q.error);

    // Una voce di menu resta su **una** riga: l'elenco misura le voci per
    // disegnare la selezione, e una voce a due righe gli fa perdere il conto.
    const voci = [
      ...video.map((v) => ({
        name: `${ui.videoLine(v)}  ${ui.style.dim(ui.style.red(motivo(v.error)))}`,
        value: { video: v.id }
      })),
      ...linkFalliti.map((q) => ({
        name: `${ui.style.red('✗')} ${q.url}  ${ui.style.dim(ui.style.red(motivo(q.error?.message)))}`,
        value: { link: q.url }
      }))
    ];
    if (voci.length === 0) console.log('Nessun fallimento.\n');
    voci.push({ name: '← indietro', value: BACK });

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value });
    if (scelta === null || scelta === BACK) return;
    if (scelta.video) await actions(app, scelta.video);
    else if (scelta.link) await linkActions(app, scelta.link);
  }
}

/**
 * Il motivo di un fallimento ridotto a una riga: quello che serve per capire
 * *quale* fallimento è. Per intero si vede fra le statistiche del video.
 */
function motivo(error) {
  let testo = String(error ?? 'motivo non registrato').replace(/[\n\r]/g, ' ');
  // Il pezzo utile di un errore di yt-dlp sta dopo `ERROR:`.
  const i = testo.indexOf('ERROR:');
  if (i !== -1) testo = testo.slice(i + 'ERROR:'.length).trim();
  const chars = [...testo];
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : testo;
}

/** Cosa si può fare con un link che non è (ancora) un video. */
async function linkActions(app, url) {
  ui.screen('Link in coda', app);
  console.log(`${url}\n`);
  const voci = [
    { name: 'Riprova adesso', value: 'retry' },
    { name: 'Toglilo dalla coda', value: 'dequeue' },
    { name: '← indietro', value: BACK }
  ];
  const scelta = await ui.selectOpt({ choices: voci, defaultValue: 'retry', pageSize: voci.length });
  if (scelta === 'retry') {
    const cap = await ui.resolveQuality(app.lib.config().quality, 'Che risoluzione?');
    if (cap === null) return;
    app.dl.pushWith(url, cap.maxHeight);
    ui.ok(app, 'accodato');
  } else if (scelta === 'dequeue') {
    await app.lib.dequeue(url);
    ui.ok(app, 'togliato dalla coda');
  }
}

/**
 * Le azioni su un video, contestuali al suo stato. Usata anche dalla ricerca: un
 * solo posto dove si decide cosa si può fare con un video.
 *
 * Le statistiche stanno **in alto**, sopra le voci: è quello che si vuole sapere
 * prima di decidere, e rende inutile una voce «Dettagli».
 */
export async function actions(app, id) {
  while (true) {
    await app.pump();
    const v = app.lib.get(id);
    if (!v) return;

    ui.screen(`${v.author} — ${v.title}`, app);
    statistiche(app, v);

    // Le voci si costruiscono in base allo stato: niente azioni impossibili da
    // scegliere e poi rifiutare. Senza icone, come il resto dei menu.
    const voci = [];
    if (v.state === STATE.DOWNLOADED) {
      voci.push({ name: 'Riproduci', value: 'play' });
      voci.push({ name: 'Solo audio', value: 'audio' });
    }
    if (v.state === STATE.PENDING || v.state === STATE.FAILED) {
      voci.push({ name: 'Scarica ora', value: 'download' });
    }
    voci.push({ name: v.favorite ? 'Togli dai preferiti' : 'Aggiungi ai preferiti', value: 'favorite' });
    voci.push({ name: v.archived ? 'Ripristina' : 'Archivia', value: 'archive' });
    voci.push({ name: 'Togli dalla libreria', value: 'remove' });
    voci.push({ name: '← indietro', value: BACK });

    const scelta = await ui.selectOpt({ choices: voci, defaultValue: voci[0].value, pageSize: voci.length });
    if (scelta === null || scelta === BACK) return;

    try {
      if (scelta === 'play') {
        await app.lib.play(id, core.PLAYBACK_MODE.VIDEO);
        ui.ok(app, 'VLC avviato');
      } else if (scelta === 'audio') {
        await app.lib.play(id, core.PLAYBACK_MODE.AUDIO);
        ui.ok(app, 'VLC avviato (solo audio)');
      } else if (scelta === 'download') {
        // Se la qualità è «chiedi ogni volta», si chiede adesso: è il momento in
        // cui il download parte.
        const cap = await ui.resolveQuality(app.lib.config().quality, 'Che risoluzione?');
        if (cap === null) continue;
        const url = await app.lib.retry(id);
        if (url) {
          app.dl.pushWith(url, cap.maxHeight);
          ui.ok(app, 'accodato — guardalo in «Download rapido»');
        } else {
          ui.err(app, 'questo video non ha un URL da riscaricare');
        }
      } else if (scelta === 'favorite') {
        const on = !v.favorite;
        await app.lib.setFavorite(id, on);
        ui.ok(app, on ? 'nei preferiti' : 'togliato dai preferiti');
      } else if (scelta === 'archive') {
        const on = !v.archived;
        await app.lib.setArchived(id, on);
        ui.ok(app, on ? 'archiviato' : 'ripristinato');
      } else if (scelta === 'remove') {
        const conferma = await confirmOpt(`Togliere «${v.title}» dalla libreria?`, false);
        if (conferma) {
          const ancheFile =
            v.state === STATE.DOWNLOADED && (await confirmOpt('Cancellare anche il file dal disco?', false));
          await app.lib.remove(id, ancheFile);
          ui.ok(app, ancheFile ? 'togliato, file cancellato' : 'togliato dalla libreria');
          return;
        }
      }
    } catch (e) {
      if (ui.isInterruzione(e)) throw e; // Ctrl-C attraversa: esce dal programma (M89)
      ui.err(app, e);
    }
  }
}

/** Le statistiche del video, sopra le voci del menu. */
function statistiche(app, v) {
  const riga = (k, val) => console.log(`  ${ui.style.dim(String(k).padEnd(12))} ${val}`);
  riga('stato', ui.style.cyan(core.stateLabel(v.state)));
  riga('durata', core.durationLabel(v.durationSeconds));
  riga('pubblicato', v.uploadDate ?? '—');
  riga(
    'risoluzione',
    v.width && v.height
      ? `${v.width}×${v.height}${v.fps ? ` @ ${Math.round(v.fps)}fps` : ''}`
      : '—'
  );
  if (v.sizeBytes > 0) riga('dimensione', ui.sizeLabel(v.sizeBytes));
  riga('url', v.url);
  if (v.state === STATE.DOWNLOADED) {
    const file = app.lib.filePath(v);
    const manca = existsSync(file) ? '' : ui.style.red("  (non è al suo posto)");
    riga('file', `${file}${manca}`);
  }
  if (v.tags.length > 0) riga('tag', v.tags.slice(0, 8).join(', '));
  if (v.error) {
    riga('errore', ui.style.red(v.error));
    riga('tentativi', String(v.attempts));
  }
  console.log();
}
