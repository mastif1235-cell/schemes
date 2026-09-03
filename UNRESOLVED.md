# Release gates / remaining checks

No production rollout is authorized or performed.

- Run GitHub CI on the feature commit and the standalone Chromium script. Local spawn was denied; embedded-browser tests are not a substitute for that entire script.
- Run real staging D1/Worker integration tests and two-phone Android scenarios. SQLite unit tests validate SQL/transactions, not all D1 runtime behavior or Telegram delivery.
- Investigate/measure IndexedDB upgrade startup: the embedded fixture temporarily displayed the blocked-upgrade notice and sometimes took tens of seconds to finish, despite eventually passing. Verify a single-tab cold upgrade, multiple tabs, fresh install and reopen on real Chrome/Android before rollout.
- Prepare a DB-v3-compatible rollback frontend. Original production 3.4.2 opens version 2 explicitly; rolling it back after a v3 upgrade is unsafe without the compatible opener. Never clear/downgrade IndexedDB.
- Legacy backend mutations still allocate seq outside their primary mutation, per the scope constraint. New notes/field/reorder writes are atomic; existing legacy cursor interleaving risks are not claimed fixed globally.
- Existing `/api/sync` still binds notebook-id lists; very large memberships need a separate boundary test/refinement against D1's parameter limit. The 200-spread reorder/snapshot path is covered, not arbitrary hundreds of notebooks.
- Legacy history currently shows the latest 100 old events in the new UI; older rows remain in D1. New activity has pagination including seq ties.
- New note content/outbox and photo attachment are atomic locally; tag edits retain the existing separate link/outbox writes. Crash-consistent tag batching remains outside this checkpoint.
- No production auth/session/secrets changes, user reset, production D1 writes or IndexedDB clearing were performed. The only browser data written during tests is synthetic localhost fixture data.
