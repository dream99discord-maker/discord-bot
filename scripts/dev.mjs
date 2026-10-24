import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const root = process.cwd();
const apiPort = readApiPort();
let api;
let web;
let apiExited = false;
let webExited = true;
let stopping = false;
let exitCode = 0;

function readApiPort() {
  if (process.env['PORT'] && /^\d+$/.test(process.env['PORT'])) return Number(process.env['PORT']);
  try {
    const line = readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/).find((item) => /^\s*PORT\s*=/.test(item));
    const value = line?.split('=').slice(1).join('=').trim();
    if (value && /^\d+$/.test(value)) return Number(value);
  } catch { /* Il file .env è facoltativo per la selezione della porta di sviluppo. */ }
  return 3000;
}

function finishIfStopped() {
  if (stopping && apiExited && webExited) process.exitCode = exitCode;
}

function stopChildren(signal) {
  if (stopping) return;
  stopping = true;
  if (api && api.exitCode === null && api.signalCode === null) api.kill(signal);
  if (web && web.exitCode === null && web.signalCode === null) web.kill(signal);
  finishIfStopped();
}

function startApi() {
  apiExited = false;
  api = spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'], {
    cwd: root, env: process.env, stdio: 'inherit',
  });
  api.on('error', () => {
    exitCode = 1;
    apiExited = true;
    stopChildren('SIGTERM');
  });
  api.on('exit', (code, signal) => {
    apiExited = true;
    if (!stopping) {
      exitCode = code ?? (signal ? 1 : 0);
      stopChildren('SIGTERM');
    } else if (code && code !== 0) exitCode = code;
    finishIfStopped();
  });
}

function startWeb() {
  if (stopping || apiExited) return;
  webExited = false;
  web = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts'], {
    cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  web.on('error', () => {
    exitCode = 1;
    webExited = true;
    stopChildren('SIGTERM');
  });
  web.on('exit', (code, signal) => {
    webExited = true;
    if (!stopping) {
      exitCode = code ?? (signal ? 1 : 0);
      stopChildren('SIGTERM');
    } else if (code && code !== 0) exitCode = code;
    finishIfStopped();
  });
}

async function waitForApiListener() {
  while (!stopping && !apiExited) {
    const listening = await new Promise((resolveResult) => {
      const socket = createConnection({ host: '127.0.0.1', port: apiPort });
      const finish = (result) => { socket.destroy(); resolveResult(result); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (listening) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  return false;
}

process.on('SIGINT', () => stopChildren('SIGINT'));
process.on('SIGTERM', () => stopChildren('SIGTERM'));
if (process.platform === 'win32') process.on('SIGBREAK', () => stopChildren('SIGINT'));

startApi();
if (await waitForApiListener()) startWeb();
