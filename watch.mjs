// HardverApró figyelő: ntfy.sh push értesítés, ha jó ár-érték arányú, hibátlan 8 TB+ HDD jelenik meg.
// Futtatás: NTFY_TOPIC=<topic> node watch.mjs   (próba küldés és mentés nélkül: DRY_RUN=1 node watch.mjs)
import { readFile, writeFile } from 'node:fs/promises';

const LIST_URL =
  'https://hardverapro.hu/aprok/hardver/merevlemez_ssd/merevlemez/asztali_hdd_3_5/8tb_es_nagyobb/index.html';
const MAX_PRICE = 72_000; // Ft
const MIN_TB = 8;
const MAX_FT_PER_TB = 6_500;
const MAX_HOURS = 60_000; // üzemóra; ha a leírás nem adja meg, az nem kizáró ok
const DETAIL_DELAY_MS = 3_000; // a HardverApró gyors egymás utáni lekérésre letilt

// Asztali (SMR vagy nem 24/7-re szánt) típusok: Seagate Barracuda/ST…DM, WD Blue/…EZAZ, Seagate Archive.
const DESKTOP_MODEL = /barracuda|(?<![a-z])st\d{3,5}dm\d|(?<![a-z])wd\d{2,4}ez[a-z]{2}|wd[\s-]?blue|archive/i;
// "HIBÁS" a címben, de nem "0 hibás szektor" és nem "hibátlan".
const BROKEN_TITLE = /(?<!\d\s?)hib[áa]s(?![\s-]*szektor)|defekt|alkatrésznek/i;
const BAD_SECTOR_KEY = /reallo\w*|újraosztott|áthelyezett|pending|függőben|uncorrectable|javíthatatlan|hibás szektor|bad sector/gi;
const HOURS = /(?:üzemóra|üzemidő|power[\s-]*on(?:\s*(?:hours|time|time count))?|működési idő|futási idő)[^\d]{0,12}?(\d{1,3}(?:[.\s ]\d{3})+|\d{3,6})/gi;

const STATE_FILE = new URL('./seen.json', import.meta.url);
const STATE_VERSION = 2;
const NTFY_URL = 'https://ntfy.sh/';
const USER_AGENT = 'Mozilla/5.0 (compatible; hardverapro-hdd-figyelo/2.0)';

const DRY_RUN = process.env.DRY_RUN === '1';
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A HardverApró az első lekérésre egy sütit állít be, és 302-vel ugyanoda (?_tc=1) irányít.
// A fetch a sütiket nem viszi tovább az átirányításon, ezért kézzel követjük.
const cookies = new Map();

export async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      let target = url;
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetch(target, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'hu',
            Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
        for (const header of res.headers.getSetCookie()) {
          const [pair] = header.split(';');
          const eq = pair.indexOf('=');
          cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          target = new URL(res.headers.get('location'), target).href;
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      }
      throw new Error('túl sok átirányítás');
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

const parsePrice = (text) => (/\d/.test(text ?? '') ? parseInt(text.replace(/\D/g, ''), 10) : null);

// Minden hirdetés egy <li class="media ..." data-uadid="123"> blokk; az osztálylista változik
// (uad-business-user, uad-status-iced), ezért nem pontos szövegre keresünk.
function parseAds(html) {
  const starts = [...html.matchAll(/<li class="media([^"]*)" data-uadid="(\d+)"/g)];
  return starts
    .map((start, i) => {
      const chunk = html.slice(start.index, starts[i + 1]?.index ?? html.length);
      const heading = chunk.match(/uad-col-title">\s*<h1>\s*<a href="([^"]+)">([^<]*)<\/a>/);
      if (!heading) return null;
      const priceText = chunk.match(/class="uad-price[^"]*">\s*<span class="text-nowrap">([^<]*)</)?.[1];
      const city = chunk.match(/class="uad-cities">([^<]*)</)?.[1];
      const price = priceText ? decodeEntities(priceText).trim() : null;
      return {
        id: start[2],
        link: heading[1],
        title: decodeEntities(heading[2]).trim(),
        price,
        priceFt: parsePrice(price),
        city: city ? decodeEntities(city).trim() : null,
        // Jegelt (szüneteltetett) hirdetés: kihagyjuk, így újraaktiváláskor jön róla értesítés.
        iced: start[1].includes('uad-status-iced'),
        // Vételi hirdetés: az ár helyén "Keresem" áll.
        wanted: price === 'Keresem',
      };
    })
    .filter(Boolean);
}

// A címben szereplő legkisebb, legalább MIN_TB-os kapacitás. Több méretet felsoroló hirdetésnél
// az ár jellemzően a legkisebbre vonatkozik, így a Ft/TB nem lesz túl optimista.
function capacityTb(title) {
  const sizes = [...title.matchAll(/(\d{1,2})\s?tb/gi)].map((m) => Number(m[1])).filter((tb) => tb >= MIN_TB);
  return sizes.length ? Math.min(...sizes) : null;
}

// Gyors szűrés a listaoldal adataiból; csak az ezen átmenő hirdetések leírását töltjük le.
function listCandidate(ad) {
  if (ad.iced || ad.wanted || !ad.priceFt || ad.priceFt > MAX_PRICE) return null;
  const tb = capacityTb(ad.title);
  if (!tb) return null;
  const ftPerTb = Math.round(ad.priceFt / tb);
  if (ftPerTb > MAX_FT_PER_TB) return null;
  return { tb, ftPerTb };
}

export function parseDescription(html) {
  const start = html.indexOf('uad-content">');
  if (start < 0) return '';
  const end = html.indexOf('Hirdető:', start);
  return decodeEntities(
    html
      .slice(start, end > start ? end : start + 20_000)
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// A leírás alapján: hibás szektor, asztali típus, túl sok üzemóra. A képeken lévő SMART-ot nem látja.
export function evaluate(ad, description) {
  const text = `${ad.title}\n${description}`;
  const problems = [];
  if (BROKEN_TITLE.test(ad.title)) problems.push('hibásként hirdetve');
  if (DESKTOP_MODEL.test(text)) problems.push('asztali/SMR típus');

  // "(198)" és hasonló attribútum-azonosítók ne számítsanak darabszámnak.
  const smart = text.replace(/\(\s*\d{1,3}\s*\)/g, ' ');
  // A darabszám a kulcsszó után ("Reallokált szektor: 0") vagy előtte ("8 realloc szektorral") áll.
  // Az előtte álló számot csak akkor vesszük, ha utána nincs szám: a "hibaküszöb 25 Újraosztott
  // szektor 0"-ban a 25 az előző attribútumhoz tartozik.
  for (const match of smart.matchAll(BAD_SECTOR_KEY)) {
    const after = smart.slice(match.index + match[0].length, match.index + match[0].length + 30);
    const count =
      after.match(/^[^\d\n]{0,20}?(\d+)/)?.[1] ??
      smart.slice(Math.max(0, match.index - 12), match.index).match(/(?<![\d.])(\d+)\s*(?:db\s*)?$/)?.[1];
    if (count && Number(count) > 0) {
      problems.push(`${match[0].toLowerCase()}: ${count}`);
      break;
    }
  }

  const hoursFound = [...smart.matchAll(HOURS)].map((m) => parseInt(m[1].replace(/\D/g, ''), 10));
  const hours = hoursFound.length ? Math.max(...hoursFound) : null;
  if (hours && hours > MAX_HOURS) problems.push(`${hours.toLocaleString('hu-HU')} üzemóra`);

  return { ok: problems.length === 0, problems, hours };
}

async function loadState() {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return state.version === STATE_VERSION ? state : null;
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

const ft = (n) => `${n.toLocaleString('hu-HU')} Ft`;
const hoursText = (hours) => (hours ? `${hours.toLocaleString('hu-HU')} üzemóra` : 'üzemóra nincs megadva, kérdezz rá');

function adMessage(ad, result) {
  return {
    title: `HDD: ${ad.tb} TB, ${ft(ad.priceFt)} (${ft(ad.ftPerTb)}/TB)`,
    message: [ad.title, hoursText(result.hours), ad.city].filter(Boolean).join('\n'),
    click: ad.link,
    tags: ['floppy_disk'],
    priority: 4,
  };
}

async function main() {
  if (!DRY_RUN && !NTFY_TOPIC) throw new Error('Hiányzik a NTFY_TOPIC környezeti változó.');

  const ads = parseAds(await fetchPage(LIST_URL));
  if (ads.length === 0) {
    throw new Error('0 hirdetés a listaoldalon: megváltozott az oldal szerkezete, vagy blokkolják a lekérést.');
  }
  const candidates = ads.flatMap((ad) => {
    const extra = listCandidate(ad);
    return extra ? [{ ...ad, ...extra }] : [];
  });
  const now = new Date().toISOString();
  const loaded = await loadState();
  const state = loaded ?? { version: STATE_VERSION, ads: {} };

  // Csak az új vagy azóta átárazott hirdetések leírását töltjük le.
  const toCheck = candidates.filter((ad) => state.ads[ad.id]?.priceFt !== ad.priceFt);
  console.log(`${ads.length} hirdetés, ${candidates.length} az ár/kapacitás szerint jelölt, ${toCheck.length} ellenőrizendő.`);

  const good = [];
  try {
    for (const ad of toCheck) {
      await sleep(DETAIL_DELAY_MS);
      const result = evaluate(ad, parseDescription(await fetchPage(ad.link)));
      console.log(`${result.ok ? 'JÓ  ' : 'NEM '} ${ad.title} – ${ad.price}` + (result.ok ? '' : ` (${result.problems.join(', ')})`));
      if (result.ok) {
        good.push([ad, result]);
        // Első futáskor csak összefoglaló megy, egyenként nem értesítünk.
        if (loaded) await notify(adMessage(ad, result));
      }
      // Csak sikeres küldés után mentjük, így hiba esetén a következő futás újrapróbálja.
      state.ads[ad.id] = { title: ad.title, priceFt: ad.priceFt, ok: result.ok, problems: result.problems, firstSeen: state.ads[ad.id]?.firstSeen ?? now };
    }
    if (!loaded) {
      await notify({
        title: 'HDD-figyelő átállítva',
        message:
          `≤ ${ft(MAX_PRICE)}, ≥ ${MIN_TB} TB, ≤ ${ft(MAX_FT_PER_TB)}/TB, hibátlan. Most ${good.length} ilyen van fent` +
          (good.length ? ':\n' : '.') +
          good.map(([ad, r]) => `• ${ad.tb} TB, ${ft(ad.priceFt)}, ${hoursText(r.hours)} – ${ad.title}`).join('\n'),
        click: LIST_URL,
        tags: ['white_check_mark'],
      });
    }
  } finally {
    await saveState(state);
  }
}

if (import.meta.main) main().catch((err) => {
  console.error(`Hiba: ${err.message}`);
  process.exitCode = 1;
});
