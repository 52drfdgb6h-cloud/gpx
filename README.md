# Trasy

Lokálna webová aplikácia na vizuálne porovnanie plánovanej GPX trasy zo Stravy a uskutočnenej GPX aktivity z Garmin hodiniek.

## Spustenie

Pre lokálny GPX import stačí otvoriť `index.html` v prehliadači. Pre hromadný import Strava aktivít spustite `npm start` a otvorte `http://localhost:4173`.

## Strava OAuth a hromadný import

1. Skopírujte `.env.example` ako `.env` a doplňte `STRAVA_CLIENT_ID` a `STRAVA_CLIENT_SECRET`. Súbor `.env` je ignorovaný a nepatrí do zdrojového kódu.
2. V Strava API aplikácii nastavte `Authorization Callback Domain` na `localhost`.
3. Spustite `npm start`, otvorte `http://localhost:4173` a kliknite na **Pripojiť Stravu a importovať aktivity**.
4. Po povolení oprávnenia backend stránkuje Strava aktivity, načíta ich GPS streamy a prehliadač ich uloží medzi uskutočnené aktivity v IndexedDB.

Prístupový a obnovovací token sa po OAuth uložia iba lokálne do ignorovaného `.strava-token.json`, takže reštart backendu pripojenie nepreruší. Voliteľný `STRAVA_ACCESS_TOKEN` v `.env` umožní jednorazový import bez OAuth, ale pri expirácii ho treba nahradiť alebo znovu pripojiť Stravu. Na firemnom Windows prostredí backend používa `STRAVA_PROXY` a integrované Windows poverenia; hodnotu možno zmeniť podľa lokálnej siete.

## Databáza a vyhľadávanie

Každý úspešný import sa automaticky uloží do lokálnej databázy prehliadača (IndexedDB). Pred uložením aplikácia porovná SHA-256 odtlačok obsahu GPX aj stabilný podpis naparsovaných bodov trasy. Rovnaký súbor sa preto nedá importovať opakovane ani pod iným názvom; kontrola zahŕňa aj staršie importy. V časti **Uložené importy** možno trasy vyhľadávať podľa názvu alebo filtrovať na plánované a uskutočnené. Kliknutím na výsledok sa trasa načíta do porovnania a mapy.

Každý uložený import sa dá vymazať tlačidlom `×` v pravom hornom rohu záznamu. Vymazanie ho odstráni z lokálnej databázy, z porovnania aj z mapy, ak je práve načítaný.

Vyhľadávanie mesta (napríklad `Malacky`) nájde jeho stred cez OpenStreetMap a zobrazí uložené trasy, ktoré majú aspoň jeden GPX bod do 2,5 km od tohto stredu. Do OpenStreetMap sa posiela iba názov hľadaného mesta, nikdy GPX body ani celá trasa. Pre Malacky je pripravená lokálna záložná poloha, takže toto overenie funguje aj bez pripojenia k službe.

Uskutočnené trasy možno v archíve označiť checkboxom pre porovnanie. Tabuľka zobrazuje dátum, celkový čas pohybu, celkový čas aktivity, priemernú rýchlosť pohybu, celkovú rýchlosť vrátane prestávok a priemerný aj maximálny tep. Hodnoty sú dostupné pre nové Garmin GPX importy, ktoré obsahujú časové body a tepové údaje; staršie importy je potrebné nahrať znova.

## Použitie

1. V Strave exportujte plánovanú trasu vo formáte GPX a nahrajte ju do časti **Strava**.
2. Z Garmin Connect exportujte aktivitu vo formáte GPX a nahrajte ju do časti **Garmin**.
3. Trasy sa zobrazia na spoločnej schématickej mape: zelená je plán, koralová je uskutočnená aktivita.

GPX súbory aj databáza sa spracúvajú lokálne v prehliadači a nikam sa neodosielajú.