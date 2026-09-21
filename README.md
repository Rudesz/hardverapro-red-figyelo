# HardverApró Red HDD figyelő

Push értesítést küld a telefonra ([ntfy](https://ntfy.sh)), ha a HardverApró
[Asztali HDD 3,5" – 8 TB és nagyobb](https://hardverapro.hu/aprok/hardver/merevlemez_ssd/merevlemez/asztali_hdd_3_5/8tb_es_nagyobb/index.html)
kategóriájában új hirdetés jelenik meg, amelynek a címében szerepel a „red” szó (WD Red, Red Plus, Red Pro…).

## Működés

- A GitHub Actions 10 percenként lefuttatja a `watch.mjs` szkriptet (Node 24, nincs külső függőség).
- A szkript letölti a lista első oldalát, és kiválogatja azokat a hirdetéseket, amelyek címében szerepel a „red”.
  Egybeírt és toldalékos alakokban is felismeri (WDRED, WD-Red, RedPro, RedPlus, Redek), és WD Red típusszám
  alapján is talál (pl. WD80EFAX, WD8003FFBX, WD141KFGX). Az „eredeti”, a „kéred” és a „redundáns” nem számít találatnak.
- A már látott hirdetések azonosítóit a `seen.json` tárolja. Így egy előresorolt hirdetésről nem jön újra értesítés.
- A jegelt hirdetéseket a szkript kihagyja. Ha az eladó újraaktiválja őket, akkor jön róluk értesítés.
- A vételi hirdetéseket („Red HDD-t keresek”, az ár helyén „Keresem”) is kihagyja. Az ingyenes hirdetésekről küld értesítést.
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

A kulcsszó és a kategória a `watch.mjs` elején állítható (`KEYWORD`, `LIST_URL`).

Ismert korlát: a GitHub ütemezett futásai terhelt időszakban 5–15 percet is késhetnek.
