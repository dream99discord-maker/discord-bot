# Operazioni e arresto controllato

## Avvio

- Sviluppo integrato: `npm run dev`. Vite serve la interfaccia web; Fastify gestisce API, OAuth e callback. Il bot e il pianificatore restano nello stesso processo backend.
- Produzione: configura il reverse proxy HTTPS come descritto in [deploy-https.md](./deploy-https.md), poi esegui `npm run build` e `npm start`.

Vite aggiorna il frontend durante lo sviluppo. Se modifichi il backend o le migrazioni, riavvia il processo con `app stop` e `npm run dev` per applicare il codice e le migrazioni.

Nel terminale interattivo del backend sono disponibili `sito stop`, `sito avvia`, `app stop` e `aiuto`. Sono comandi locali del terminale; non esiste un endpoint pubblico per arrestare il servizio.

## Arresto del solo sito

`sito stop` chiude l’ascolto HTTP Fastify e attende le richieste attive. Il client Discord, gli eventi del bot e il pianificatore restano in esecuzione. `sito avvia` crea una nuova istanza HTTP/API con la configurazione corrente. In sviluppo Vite è un processo separato: quando Fastify è fermo, la pagina può ancora caricarsi, ma le API non sono disponibili.

Su sistemi POSIX `SIGUSR2` arresta soltanto il sito. Su Windows usa il comando terminale. Il riavvio del sito si esegue con `sito avvia`.

## Arresto dell’intera applicazione

`app stop`, `Ctrl+C` (`SIGINT`) o `SIGTERM` arrestano il sito, impediscono l’avvio di nuove operazioni del bot, fermano il pianificatore, attendono le operazioni già iniziate e poi chiudono il client Discord e SQLite. Le richieste ripetute condividono lo stesso arresto e non chiudono due volte le risorse.

`SHUTDOWN_TIMEOUT_MS` imposta il tempo d’attesa iniziale, da 1 a 120 secondi (predefinito 30). Se una richiesta Discord supera quel tempo, lo stato incompleto rimane persistito; il processo mantiene aperto il database finché i componenti attivi non hanno smesso di usarlo. I task programmati che risultano ancora `running` vengono riportati a `pending` all’avvio successivo e riconciliati dai rispettivi servizi.

Ticket e pannelli conservano stato, identificativi Discord e dati del modulo nel database. All’avvio il bot riconcilia pannelli e ticket incompleti usando marcatori stabili e non ripubblica un riepilogo già presente. Gli annunci programmati usano la procedura di deduplicazione descritta nel README.

## Database e backup

Arresta prima il processo con la procedura completa; quindi copia il file SQLite e i relativi file WAL soltanto se restano dopo la chiusura. Non collocare backup sotto la radice pubblica `web/dist`. Conserva backup e `.env` in una cartella con accesso limitato e cifratura del disco.

Le migrazioni 001–003 vengono applicate all’avvio. Prima di ripristinare un backup, conserva una copia del database corrente; il ripristino non richiede la cancellazione delle risorse Discord.
