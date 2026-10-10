# HardverApró HDD ár-figyelő

Push értesítést küld a telefonra ([ntfy](https://ntfy.sh)), ha a HardverApró
[Asztali HDD 3,5" – 8 TB és nagyobb](https://hardverapro.hu/aprok/hardver/merevlemez_ssd/merevlemez/asztali_hdd_3_5/8tb_es_nagyobb/index.html)
kategóriájában jó ár-érték arányú, hibátlan lemez jelenik meg.

## Mi számít jónak

A listaoldal alapján (a határok a `watch.mjs` elején állíthatók):

- az ár legfeljebb 72 000 Ft (`MAX_PRICE`);
- a címben legalább 8 TB szerepel (`MIN_TB`); több méretnél a legkisebbel számol;
- legfeljebb 6 500 Ft/TB (`MAX_FT_PER_TB`).

Ha ezen átmegy, letölti a hirdetés leírását, és kiszűri:

- a hibásként hirdetett lemezt („HIBÁS” a címben; a „0 hibás szektor” nem számít);
- az asztali és SMR típusokat (Barracuda, ST…DM, WD Blue, WD…EZAZ, Archive);
- ha a leírás 0-nál több reallocated, pending, uncorrectable (198) vagy hibás szektort említ;
- ha az üzemóra több mint 60 000 (`MAX_HOURS`). Ha a leírás nem adja meg, az értesítés jelzi, hogy kérdezz rá.

A képeken lévő SMART-képernyőt nem látja, azt neked kell megnézned.

## Működés

- A `watch.mjs` szkript (Node 24, nincs külső függőség) GitHub Actionsben fut, 10 percenként.
  Az indítást a [cron-job.org](https://console.cron-job.org) végzi a GitHub API-n keresztül (`workflow_dispatch`),
  mert a GitHub saját ütemezője ennél a repónál nem indult el. A `schedule` tartaléknak bent maradt.
  A cron-job.org egy csak erre a repóra szóló, *Actions: Read and write* jogú tokennel dolgozik. Ha a token lejár,
  a cron-job.org hibát jelez; ilyenkor új tokent kell létrehozni, és be kell írni a cronjob `Authorization` fejlécébe.
- A HardverApró az első lekérésre sütit állít be és átirányít; a szkript ezt kézzel követi.
- A leírásokat egyenként, 3 mp szünettel tölti le, és csak az új vagy átárazott hirdetésekét, mert a gyors
  egymás utáni lekérésre az oldal letilt.
- A már értékelt hirdetéseket a `seen.json` tárolja (ár és eredmény). Ha egy hirdetés ára változik, újra értékeli.
- A jegelt hirdetéseket kihagyja. Ha az eladó újraaktiválja őket, akkor értékeli és jelzi őket.
- A vételi hirdetéseket (az ár helyén „Keresem”) kihagyja.
- Első futáskor (vagy ha a `seen.json` régi formátumú) egy összefoglalót küld a most fent lévő jó ajánlatokról.
- Ha a szkript egy hirdetést sem talál (megváltozott az oldal, vagy blokkolják a lekérést), a futás hibával áll le, és a GitHub e-mailt küld.

## Beállítás

1. Telepítsd az **ntfy** appot (Android / iOS), és iratkozz fel a titkos topic nevére (*Subscribe to topic*).
2. A repóban a topic neve a `NTFY_TOPIC` secretben van: `gh secret set NTFY_TOPIC`.
   A topic neve jelszóként működik: aki ismeri, olvashatja az értesítéseket.

## Használat

```sh
gh workflow run watch.yml          # azonnali ellenőrzés
gh run list --workflow watch.yml   # korábbi futások
DRY_RUN=1 node watch.mjs           # helyi próba, küldés és mentés nélkül
```

Ismert korlát: a GitHub ütemezett futásai terhelt időszakban 5–15 percet is késhetnek.
