import {
  ApplicationCommandType, ContextMenuCommandBuilder, SlashCommandBuilder,
} from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('segnala').setDescription('Invia una segnalazione privata allo staff')
    .addStringOption((option) => option.setName('categoria').setDescription('Tipo di segnalazione').setRequired(true)
      .addChoices({ name: 'Giocatore', value: 'giocatore' }, { name: 'Bug', value: 'bug' }, { name: 'Sanzione Discord', value: 'sanzione' }, { name: 'Membro dello staff', value: 'staff' }))
    .addStringOption((option) => option.setName('descrizione').setDescription('Descrivi con precisione la segnalazione').setRequired(true).setMaxLength(2000))
    .addUserOption((option) => option.setName('utente').setDescription('Utente Discord coinvolto').setRequired(false))
    .addStringOption((option) => option.setName('id_roblox').setDescription('ID numerico Roblox, se noto').setRequired(false).setMaxLength(20))
    .addStringOption((option) => option.setName('prove').setDescription('Riferimento alle prove (non apriremo link automaticamente)').setRequired(false).setMaxLength(1500))
    .addBooleanOption((option) => option.setName('riservata').setDescription('Invia nel percorso riservato allo staff autorizzato').setRequired(false)),

  new ContextMenuCommandBuilder().setName('Segnala messaggio').setType(ApplicationCommandType.Message).setDMPermission(false),

  new SlashCommandBuilder().setName('ticket').setDescription('Gestisci il ticket in cui ti trovi')
    .addSubcommand((sub) => sub.setName('assegna').setDescription('Prendi in carico il ticket corrente'))
    .addSubcommand((sub) => sub.setName('aggiungi').setDescription('Aggiungi un partecipante autorizzato al ticket')
      .addUserOption((option) => option.setName('utente').setDescription('Partecipante da aggiungere').setRequired(true)))
    .addSubcommand((sub) => sub.setName('rimuovi').setDescription('Rimuovi un partecipante aggiunto al ticket')
      .addUserOption((option) => option.setName('utente').setDescription('Partecipante da rimuovere').setRequired(true)))
    .addSubcommand((sub) => sub.setName('chiudi').setDescription('Chiudi il ticket con una motivazione')
      .addStringOption((option) => option.setName('motivo').setDescription('Motivo della chiusura').setRequired(true).setMaxLength(500))),

  new SlashCommandBuilder().setName('moderazione').setDescription('Comandi di moderazione con registrazione dei casi')
    .addSubcommand((sub) => sub.setName('avverti').setDescription('Assegna un avvertimento')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('avvertimenti').setDescription('Consulta gli avvertimenti di un utente')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true)))
    .addSubcommand((sub) => sub.setName('revoca-avvertimento').setDescription('Revoca un avvertimento conservandone la cronologia')
      .addIntegerOption((option) => option.setName('caso').setDescription('Numero del caso da revocare').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione della revoca').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('timeout').setDescription('Applica un timeout')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true))
      .addIntegerOption((option) => option.setName('minuti').setDescription('Durata da 1 a 40320 minuti').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('rimuovi-timeout').setDescription('Rimuovi il timeout di un utente')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('espelli').setDescription('Espelli un utente dal server')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('ban').setDescription('Richiedi il ban con conferma esplicita')
      .addUserOption((option) => option.setName('utente').setDescription('Destinatario').setRequired(true))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('sban').setDescription('Rimuovi il ban di un utente')
      .addStringOption((option) => option.setName('id_utente').setDescription('ID Discord dell’utente').setRequired(true).setMaxLength(20))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('pulisci').setDescription('Elimina da 2 a 100 messaggi dopo conferma')
      .addIntegerOption((option) => option.setName('quantita').setDescription('Numero di messaggi').setRequired(true).setMinValue(2).setMaxValue(100)))
    .addSubcommand((sub) => sub.setName('slowmode').setDescription('Imposta lo slowmode nel canale corrente')
      .addIntegerOption((option) => option.setName('secondi').setDescription('Da 0 a 21600 secondi').setRequired(true).setMinValue(0).setMaxValue(21600))
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('blocca-canale').setDescription('Blocca l’invio nel canale corrente registrando lo stato precedente')
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('sblocca-canale').setDescription('Ripristina il blocco creato dal bot nel canale corrente')
      .addStringOption((option) => option.setName('motivo').setDescription('Motivazione').setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName('casi').setDescription('Consulta i casi recenti')
      .addUserOption((option) => option.setName('utente').setDescription('Filtra per utente').setRequired(false))),

  new SlashCommandBuilder().setName('lockdown').setDescription('Blocca temporaneamente l’invio nei canali testuali')
    .addIntegerOption((option) => option.setName('minuti').setDescription('Ripristino automatico dopo 1–1440 minuti').setRequired(false).setMinValue(1).setMaxValue(1440)),
  new SlashCommandBuilder().setName('lockdown-ripristina').setDescription('Ripristina i permessi salvati dal bot dopo il lockdown'),
  new SlashCommandBuilder().setName('sicurezza-stop').setDescription('Arresta le automazioni di sicurezza del server'),
  new SlashCommandBuilder().setName('sicurezza-avvia').setDescription('Riabilita le automazioni di sicurezza del server'),

  new SlashCommandBuilder().setName('annuncio').setDescription('Prepara un annuncio e mostralo in anteprima prima della pubblicazione')
    .addStringOption((option) => option.setName('tipo').setDescription('Tipo di comunicazione').setRequired(true)
      .addChoices({ name: 'Annuncio', value: 'annuncio' }, { name: 'Manutenzione', value: 'manutenzione' }, { name: 'Aggiornamento', value: 'aggiornamento' }, { name: 'Evento', value: 'evento' }))
    .addStringOption((option) => option.setName('titolo').setDescription('Titolo').setRequired(true).setMaxLength(100))
    .addStringOption((option) => option.setName('testo').setDescription('Contenuto').setRequired(true).setMaxLength(4000))
    .addStringOption((option) => option.setName('data').setDescription('Data ISO 8601 per la programmazione (facoltativa)').setRequired(false).setMaxLength(40))
    .addRoleOption((option) => option.setName('menzione_ruolo').setDescription('Un ruolo esplicitamente autorizzato da menzionare').setRequired(false)),
];

export const commandPayload = commands.map((command) => command.toJSON());
