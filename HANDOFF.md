# Handoff pre ďalšieho agenta

## Cieľ projektu

`gpx-trasy` je lokálna webová aplikácia na vizuálne porovnanie dvoch GPX súborov:

- plánovanej trasy exportovanej zo Stravy,
- uskutočnenej aktivity exportovanej z Garmin Connect.

Aplikácia má používateľovi umožniť oba súbory nahrať, zobraziť ich na spoločnej mape a uchovať importy v lokálnom archíve pre ďalšie porovnania a vyhľadávanie.

## Dôležité funkčné požiadavky

- Aplikácia funguje iba v prehliadači a nepotrebuje server ani inštaláciu balíkov.
- GPX dáta sa spracúvajú lokálne. Trasy ani body sa nesmú odosielať mimo prehliadača.
- Úspešné importy sa ukladajú do IndexedDB.
- Duplicitný GPX súbor sa nesmie uložiť opakovane, ani keď má iný názov. Kontrola používa SHA-256 odtlačok obsahu aj stabilný podpis naparsovaných bodov.
- Archív musí podporovať vyhľadávanie podľa názvu, filtrovanie plánovaných a uskutočnených trás a mazanie importu.
- Vyhľadanie mesta cez OpenStreetMap zobrazí uložené trasy s bodom do 2,5 km od stredu mesta. Do služby sa posiela iba názov mesta, nikdy GPX dáta.
- Uskutočnené Garmin trasy sa dajú vybrať pre porovnanie; pri dostupných časových a tepových údajoch sa zobrazujú metriky aktivity.

## Používateľský postup

1. Používateľ exportuje plánovanú trasu zo Stravy vo formáte GPX a importuje ju v časti Strava.
2. Používateľ exportuje uskutočnenú aktivitu z Garmin Connect vo formáte GPX a importuje ju v časti Garmin.
3. Aplikácia vykreslí obe trasy na spoločnej schématickej mape: plán zelenou a uskutočnenú trasu koralovou farbou.
4. Importované trasy môže používateľ neskôr nájsť v archíve, vyfiltrovať, vymazať alebo použiť v ďalšom porovnaní.

## Súbory

- `index.html`: štruktúra a ovládacie prvky stránky.
- `styles.css`: vzhľad a responzívne rozloženie.
- `app.js`: GPX parsovanie, IndexedDB, deduplikácia, mapa, porovnanie a vyhľadávanie.
- `README.md`: používateľská dokumentácia a aktuálny funkčný rozsah.

## Ako pokračovať

1. Najprv prečítať `README.md`, potom relevantnú časť `app.js` a existujúce HTML/CSS v okolí menenej funkcie.
2. Zachovať lokálne spracovanie a existujúci štýl aplikácie; nepridávať backend ani zbytočné závislosti.
3. Pri úpravách GPX importu overiť plánovaný aj Garmin súbor, duplicitný import a prácu s importami po obnovení stránky.
4. Pri vizuálnych zmenách otestovať stránku na desktopovej aj mobilnej šírke.
5. Keďže aplikácia nepotrebuje server, po úpravách stačí otvoriť `index.html` v prehliadači a manuálne overiť zmenený scenár.

## Aktuálny stav konverzácie

V tejto konverzácii sa zatiaľ neupravoval zdrojový kód. Tento dokument bol vytvorený len preto, aby sa pracovný cieľ a kontext dali odovzdať inému agentovi aj po zmene VS Code workspace.
