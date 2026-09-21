// HardverApró figyelő: ntfy.sh push értesítés, ha új "Red" HDD hirdetés jelenik meg.
// Futtatás: NTFY_TOPIC=<topic> node watch.mjs   (próba küldés nélkül: DRY_RUN=1 node watch.mjs)
import { readFile, writeFile } from 'node:fs/promises';

const LIST_URL =
  'https://hardverapro.hu/aprok/hardver/merevlemez_ssd/merevlemez/asztali_hdd_3_5/8tb_es_nagyobb/index.html';
// Önálló "red" szó. Unicode-betűhatár kell, mert a \b az ékezetes betűt nem-betűnek látja
// (a "kéred" illeszkedne), részszöveg-keresésnél pedig az "eredeti" is találat lenne.
const KEYWORD = /(?<![\p{L}\p{N}])red(?![\p{L}\p{N}])/iu;
const STATE_FILE = new URL('./seen.json', import.meta.url);
const NTFY_URL = 'https://ntfy.sh/';
const USER_AGENT = 'Mozilla/5.0 (compatible; hardverapro-red-figyelo/1.0)';

const DRY_RUN = process.env.DRY_RUN === '1';
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchList() {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(LIST_URL, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'hu' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw err;
      console.warn(`Letöltési hiba (${err.message}), újrapróbálás 30 mp múlva...`);
      await sleep(30_000);
    }
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

// Minden hirdetés egy <li class="media ..." data-uadid="123"> blokk; az osztálylista változik
// (uad-business-user, uad-status-iced), ezért nem pontos szövegre keresünk.
function parseAds(html) {
  const starts = [...html.matchAll(/<li class="media([^"]*)" data-uadid="(\d+)"/g)];
  return starts
    .map((start, i) => {
      const chunk = html.slice(start.index, starts[i + 1]?.index ?? html.length);
      const heading = chunk.match(/uad-col-title">\s*<h1>\s*<a href="([^"]+)">([^<]*)<\/a>/);
      if (!heading) return null;
      const price = chunk.match(/class="uad-price[^"]*">\s*<span class="text-nowrap">([^<]*)</)?.[1];
      const city = chunk.match(/class="uad-cities">([^<]*)</)?.[1];
      return {
        id: start[2],
        link: heading[1],
        title: decodeEntities(heading[2]).trim(),
        price: price ? decodeEntities(price).trim() : null,
        city: city ? decodeEntities(city).trim() : null,
        // Jegelt (szüneteltetett) hirdetés: kihagyjuk, így újraaktiváláskor jön róla értesítés.
        iced: start[1].includes('uad-status-iced'),
      };
    })
    .filter(Boolean);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveState(state) {
  if (DRY_RUN) return;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function notify(message) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${message.title}\n  ${message.message.replaceAll('\n', '\n  ')}\n  -> ${message.click}`);
    return;
  }
  // JSON törzzsel küldünk: a HTTP fejlécekben az ékezetes cím nem jutna át megbízhatóan.
  const res = await fetch(NTFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
}

function adMessage(ad) {
  return {
    title: `Új Red HDD – ${ad.price ?? 'ár nélkül'}`,
    message: [ad.title, ad.city].filter(Boolean).join('\n'),
    click: ad.link,
    tags: ['floppy_disk'],
    priority: 4,
  };
}

async function main() {
  if (!DRY_RUN && !NTFY_TOPIC) throw new Error('Hiányzik a NTFY_TOPIC környezeti változó.');

  const ads = parseAds(await fetchList());
  if (ads.length === 0) {
    throw new Error('0 hirdetés a listaoldalon: megváltozott az oldal szerkezete, vagy blokkolják a lekérést.');
  }
  const matches = ads.filter((ad) => !ad.iced && KEYWORD.test(ad.title));
  const now = new Date().toISOString();
  let state = await loadState();

  // Első futás: a már fent lévő hirdetéseket csak elmentjük, és egy összefoglalót küldünk.
  if (state === null) {
    await notify({
      title: 'HardverApró figyelő elindult',
      message:
        `Jelenleg ${matches.length} Red hirdetés van fent:\n` +
        matches.map((ad) => `• ${ad.title} – ${ad.price ?? '?'}`).join('\n'),
      click: LIST_URL,
      tags: ['white_check_mark'],
    });
    state = Object.fromEntries(matches.map((ad) => [ad.id, { title: ad.title, firstSeen: now }]));
    await saveState(state);
    console.log(`Inicializálva: ${ads.length} hirdetés, ${matches.length} Red találat elmentve.`);
    return;
  }

  const fresh = matches.filter((ad) => !state[ad.id]);
  console.log(`${ads.length} hirdetés, ${matches.length} Red találat, ${fresh.length} új.`);
  try {
    for (const ad of fresh) {
      await notify(adMessage(ad));
      // Csak sikeres küldés után jelöljük látottnak, így hiba esetén a következő futás újrapróbálja.
      state[ad.id] = { title: ad.title, firstSeen: now };
      console.log(`Elküldve: ${ad.title} (${ad.price ?? 'ár nélkül'})`);
    }
  } finally {
    await saveState(state);
  }
}

main().catch((err) => {
  console.error(`Hiba: ${err.message}`);
  process.exitCode = 1;
});
