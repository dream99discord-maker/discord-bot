# Pannelli ticket dalla interfaccia web

## Creazione

Nella pagina **Ticket** seleziona **Crea pannello ticket** e scegli il server nella procedura guidata. Richiede un account che appartenga ancora al server e abbia `Gestisci canali` oppure sia il proprietario. Il bot deve essere online e avere `Gestisci canali`, oltre a visualizzare e scrivere nel canale del pannello. L’app non richiede il permesso **Amministratore** come scorciatoia.

La procedura consente di creare o scegliere un canale testuale, una categoria per il pannello e una categoria privata distinta per i ticket; scegliere ruoli staff, tipologie e moduli; configurare titolo, descrizione, colore, menu o pulsanti e i limiti; vedere l’anteprima; confermare. I moduli supportano fino a cinque campi Discord per tipologia. Discord limita i componenti a 25 opzioni/pulsanti per messaggio.

Il canale del pannello concede visualizzazione a `@everyone` e nega l’invio ordinario. Il bot crea la categoria privata con `ViewChannel` negato a `@everyone`; i canali ticket ricevono permessi separati per autore, bot, ruoli staff e partecipanti. Anche il proprietario e gli amministratori Discord conservano i privilegi previsti dalla piattaforma.

Per selezionare una categoria ticket esistente, questa deve già negare la visualizzazione a `@everyone`. Scegli una categoria vuota e riservata: la creazione non modifica categorie esistenti né sincronizza i ticket con categorie pubbliche.

## Operazioni idempotenti e ripristino

La interfaccia web invia un UUID di idempotenza e il backend registra la richiesta prima di contattare Discord. Categoria, canale e messaggio vengono registrati progressivamente. Un nuovo invio con la stessa chiave e gli stessi dati riprende l’operazione; una chiave riutilizzata con dati diversi viene rifiutata. Se una risposta di rete si interrompe, la interfaccia web mostra lo stato e gli ID conservati.

In caso d’errore il backend elimina soltanto un messaggio creato da quella richiesta e canali/categorie nuovi rimasti vuoti. Risorse preesistenti, contenuti aggiunti dagli utenti e ticket con conversazioni non vengono eliminati. La pagina mostra gli ID rimasti e offre **Verifica / ripara**. Se una risorsa selezionata è stata eliminata, la riparazione crea un sostituto con un identificativo stabile, ricollega il canale del pannello e conserva le risorse e i ticket precedenti.

Disattivare un pannello disabilita i controlli Discord per nuove aperture e conserva ticket e risorse. Eliminare un pannello richiede conferma dell’ID del messaggio: elimina solo quel messaggio e conserva canale, categorie e ticket. Più pannelli possono vivere nello stesso server e hanno limiti e moduli indipendenti.

## Prove su un server reale

I test automatici usano Discord simulato. Prima di aprire il pannello ai membri, verifica su un server di prova: ruoli effettivi di operatore e bot, privacy categoria/canale, apertura da menu e pulsante, moduli obbligatori, staff per singola tipologia, ruolo revocato, doppio clic, messaggio o canale eliminato, bot offline, riparazione, chiusura e download autenticato della trascrizione.
