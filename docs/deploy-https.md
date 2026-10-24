# Pubblicazione HTTPS dietro reverse proxy

In produzione Fastify serve `web/dist`, API e callback OAuth dalla stessa origine. Esponi pubblicamente il reverse proxy sulla porta HTTPS; tieni `HOST=127.0.0.1` e la porta Fastify non pubblica sulla rete. In alternativa, usa un socket o una rete privata tra proxy e backend.

## Configurazione applicativa

Nel `.env` di produzione usa:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_BASE_URL=https://guardian.example.it
DISCORD_REDIRECT_URI=https://guardian.example.it/api/v1/auth/discord/callback
CORS_ORIGINS=https://guardian.example.it
TRUST_PROXY=127.0.0.1
REQUEST_BODY_LIMIT_BYTES=1048576
SHUTDOWN_TIMEOUT_MS=30000
```

Sostituisci il dominio d’esempio. Registra in Discord Developer Portal lo stesso redirect URI, carattere per carattere. `SESSION_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, `DISCORD_CLIENT_SECRET` e `BOT_TOKEN` restano nel `.env` del backend o in un secret store del deployment; non inserirli nel frontend, nei file statici o nei log. La build web usa solo le variabili `VITE_*` previste per il client.

Fastify in produzione richiede URL HTTPS per `APP_BASE_URL` e `DISCORD_REDIRECT_URI`, abilita cookie `Secure` e HSTS, applica CSP, limiti di dimensione e rate limit. `TRUST_PROXY` deve elencare soltanto l’indirizzo o gli indirizzi reali del proxy fidato: non usare `*` o `true` se la rete non è sotto il tuo controllo.

## Esempio Caddy

```caddyfile
guardian.example.it {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy può gestire certificato e rinnovo TLS se DNS e porte pubbliche sono configurati correttamente.

## Esempio Nginx

```nginx
server {
    listen 80;
    server_name guardian.example.it;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name guardian.example.it;

    ssl_certificate     /etc/letsencrypt/live/guardian.example.it/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/guardian.example.it/privkey.pem;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 40s;
    }
}
```

Se Nginx gira su un altro host/container, sostituisci `127.0.0.1` in `TRUST_PROXY` con l’indirizzo privato esatto del proxy e in `proxy_pass` con l’indirizzo privato del backend. Blocca l’accesso diretto alla porta 3000 dal firewall.

## Verifica e limiti

Verifica il certificato da una rete esterna, il redirect HTTP→HTTPS, `GET /health`, il callback OAuth e l’assenza di accesso alla porta backend. L’applicazione imposta intestazioni e cookie sicuri, convalida gli input, limita le richieste e serve solo `web/dist`; il firewall, la terminazione TLS, la gestione dei certificati, la protezione DDoS e l’isolamento della macchina dipendono dal proxy, dal sistema e dal servizio di hosting. Queste misure riducono i rischi ma non garantiscono sicurezza assoluta.
