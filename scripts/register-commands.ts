import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandPayload } from '../src/bot/commands.js';

const token = process.env['BOT_TOKEN'];
const appId = process.env['DISCORD_CLIENT_ID'];
if (!token || !appId) throw new Error('Inserisci BOT_TOKEN e DISCORD_CLIENT_ID nel file .env prima di registrare i comandi.');

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationCommands(appId), { body: commandPayload });
console.info(`Comandi globali registrati: ${commandPayload.length}.`);
