# Trasy

Lokálna webová aplikácia na vizuálne porovnanie plánovanej GPX trasy zo Stravy a uskutočnenej GPX aktivity z Garmin hodiniek.

## Spustenie

Spustite `npm start` a otvorte `http://localhost:4173`. Backend ukladá lokálne GPX importy aj Strava aktivity do PostgreSQL.

## Strava OAuth a hromadný import

1. Uložte `client_id` a `client_secret` pre službu `strava` do Windows Credential Managera. Backend ich načíta cez Python balík `keyring`; `.env` neobsahuje Strava poverenia.
2. V Strava API aplikácii nastavte `Authorization Callback Domain` na `localhost`.
3. Spustite `npm start`, otvorte `http://localhost:4173` a kliknite na **Pripojiť Stravu a importovať aktivity**.
4. Po povolení oprávnenia backend stránkuje Strava aktivity, načíta ich GPS streamy a prehliadač ich uloží medzi uskutočnené aktivity v PostgreSQL.

Prístupový a obnovovací token sa po OAuth uložia iba do Windows Credential Managera pre službu `strava`, takže reštart backendu pripojenie nepreruší. Na firemnom Windows prostredí backend používa `STRAVA_PROXY` a integrované Windows poverenia; hodnotu možno zmeniť podľa lokálnej siete.

## Databáza a vyhľadávanie

Každý úspešný import sa automaticky uloží do lokálnej PostgreSQL databázy. Konfigurácia bez hesla je v `.env` (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` a `PG_PSQL_PATH`); heslo je uložené iba vo Windows Credential Manageri pre službu `gpx-trasy-postgres` a kľúč `postgres`. Pred uložením aplikácia porovná SHA-256 odtlačok obsahu GPX aj stabilný podpis naparsovaných bodov trasy. Rovnaký súbor sa preto nedá importovať opakovane ani pod iným názvom; kontrola zahŕňa aj staršie importy. V časti **Uložené importy** možno trasy vyhľadávať podľa názvu alebo filtrovať na plánované a uskutočnené. Kliknutím na výsledok sa trasa načíta do porovnania a mapy.

Každý uložený import sa dá vymazať tlačidlom `×` v pravom hornom rohu záznamu. Vymazanie ho odstráni z lokálnej databázy, z porovnania aj z mapy, ak je práve načítaný.

Vyhľadávanie mesta (napríklad `Malacky`) nájde jeho stred cez OpenStreetMap a zobrazí uložené trasy, ktoré majú aspoň jeden GPX bod do 2,5 km od tohto stredu. Do OpenStreetMap sa posiela iba názov hľadaného mesta, nikdy GPX body ani celá trasa. Pre Malacky je pripravená lokálna záložná poloha, takže toto overenie funguje aj bez pripojenia k službe.

Uskutočnené trasy možno v archíve označiť checkboxom pre porovnanie. Tabuľka zobrazuje dátum, celkový čas pohybu, celkový čas aktivity, priemernú rýchlosť pohybu, celkovú rýchlosť vrátane prestávok a priemerný aj maximálny tep. Hodnoty sú dostupné pre nové Garmin GPX importy, ktoré obsahujú časové body a tepové údaje; staršie importy je potrebné nahrať znova.

## Použitie

1. V Strave exportujte plánovanú trasu vo formáte GPX a nahrajte ju do časti **Strava**.
2. Z Garmin Connect exportujte aktivitu vo formáte GPX a nahrajte ju do časti **Garmin**.
3. Trasy sa zobrazia na spoločnej schématickej mape: zelená je plán, koralová je uskutočnená aktivita.

GPX súbory a databáza sa spracúvajú lokálne na počítači a nikam sa neodosielajú.

test