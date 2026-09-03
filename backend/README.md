# blocknot-proxy backend

`worker.js` is the canonical source for the Cloudflare Worker named
`blocknot-proxy`.

The initial baseline was downloaded read-only from the production Worker on
2026-09-03. Active production version at capture time:
`0ae45fb4-6df7-4bad-aef7-809046d13984`.

Bindings used by the Worker:

- `DB` — Cloudflare D1 database binding.
- `BOT_TOKEN` — secret.
- `CHAT_ID` — secret.
- `BOOTSTRAP_SECRET` — secret.

Secret values must never be committed. Production deployment and production D1
migrations are intentionally outside the current feature-branch work.

Forward-only SQL migrations are stored in `migrations/`.
