# livepad

One shared text pad, live on all your devices. Type or paste on one, and it appears on the others.
Runs on Cloudflare Workers with a single Durable Object and no third-party packages.

- Live sync over WebSocket, with offline edits merged on reconnect
- Installable as an app; on Android, text can be sent to the pad from the share menu
- Stays logged in on each device

**Scope:** one pad and one login per deployment. The pad is stored unencrypted in your Cloudflare
account, so it isn't meant for passwords or other secrets.

## Deploy

You need Node.js and a Cloudflare account.

    npx wrangler login
    npx wrangler deploy
    npx wrangler secret put PAD_USER
    npx wrangler secret put PAD_PASS
    npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32

Until all three secrets are set, login returns an error. To use your own domain, uncomment `routes` in `wrangler.toml`.

## Run locally

    cp .dev.vars.example .dev.vars
    npx wrangler dev

## Security notes

- Login attempts are limited per IP address (10 a minute by default). Cloudflare counts these per location,
  so use a long password.
- Every device shares one session token. Logging out clears only that browser; changing `PAD_USER`,
  `PAD_PASS` or `SESSION_SECRET` logs out every device.
- The Android share link can only add text. It changes only with `SESSION_SECRET`.
- If you use a custom domain, be aware that other sites on the same parent domain count as same-site for the cookie.

## How sync works

The server holds the text and a version number. A client sends one edit at a time against the version it
last saw. The server rejects a stale edit, and the client rebases it onto the newer text and retries.

## Known limitation

If a connection drops after the server saves an edit but before the client hears about it, and another device
edits before reconnect, that first edit can appear twice.

## License

MIT
