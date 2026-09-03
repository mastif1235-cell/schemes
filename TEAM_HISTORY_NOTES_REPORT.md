# Team notes/history — feature branch checkpoint

Date: 2026-09-03. Branch: `feature/team-history-notes`.
**No production deploy, D1 migration, main merge, secret change or production-data write.**
App version remains 3.4.2; this is not a new production release.

## Commits

| Commit | Change |
|---|---|
| b1a9c32 | Exact captured production Worker baseline |
| 5d16eeb | Additive notes/activity migration |
| aa27d86 | Notes, activity, tie-safe incremental sync |
| f13d7c2 | Field merge, atomic reorder, photo seq, favorites checks |
| df86a41 | Bounded reorder queries; history seq ties |
| a6933f5 | Local team stores/outbox; independent photo preservation |
| 7d1053b | Viewer notes and compact accessible actions |
| 42a384d | Large notebook snapshots within D1 parameter limits |
| 0289f41 | Team history, field editor, explicit reorder; atomic photo attach |
| ab52097 | Backfill notes for clients whose old cursor already passed them |
| 3036972 | Explicit per-note conflict resolution |
| 569d2f8 | Real-IndexedDB retry-key regression fix |

The commit containing this report also adds local runtime test harnesses and backend syntax checking to CI.
All work in this session is committed locally; it has not been pushed or published.

## Files and migration

- `backend/worker.js`: canonical backend implementation. Auth/session helpers remain the captured baseline.
- `backend/migrations/0001_team_history_notes.sql`: creates only `spread_notes`, `activity_events` and their indexes. Existing tables/data are not rebuilt.
- `backend/README.md`: provenance and binding names only, no secret values.
- `v3-core.js`: additive IndexedDB v3 stores; transaction-complete local outbox writes.
- `v3-sync.js`: new entities in the existing queue/sync, scoped capabilities/cache, one-time notes backfill, per-field/per-note conflicts, safe photo response mapping.
- `v3-photos.js`: separate notes list, own-note controls, conflict UI, atomic photo attachment, compact actions and 44 CSS px top buttons. Existing zoom/pan/rotation toolbar retained.
- `v3-history.js`: shared actor/time/notebook/spread/action/details view, cached offline events, legacy history access, navigation.
- `v3-ui.js`: field-level editor, preserved legacy fields/tags, drag and ↑/↓ reorder with explicit save and server confirmation.
- `app-v3-manifest.json`: regenerated hashes, version unchanged.
- `tests/backend-worker.test.mjs`, `tests/sync-safety.test.mjs`: expanded automated coverage.
- `tests/team-runtime.test.mjs`: isolated Chromium end-to-end test (optional Playwright installation).
- `tests/serve-team-preview.mjs`, `tests/team-preview-fixture.js`: local-only browser fallback with a unique synthetic DB, blocked external connections and mocked API.
- `package.json`, `.github/workflows/ci.yml`: test commands and backend/test syntax checks.

Previously committed camera/gallery choice and notebook search selector remain unchanged.

## Backend contract

| Route | Method | Purpose / authorization |
|---|---|---|
| `/api/spreads/:id/notes` | GET | Active member/owner reads notes |
| `/api/spreads/:id/notes` | POST | Active member/owner creates; author from session, notebook from spread |
| `/api/notes/:id` | PATCH | Own note only, revision + client_ref |
| `/api/notes/:id` | DELETE | Own note only, soft delete, old text retained in activity |
| `/api/notebooks/:id/activity` | GET | Shared member history + compatible legacy events |
| `/api/spreads/:id/activity` | GET | Shared spread history |
| `/api/spreads/:id` | PATCH | `changes`, `base_values`, `client_ref`; same-field 409, independent fields merge; current_photo_id rejected |
| `/api/notebooks/:id/spreads/order` | PUT | Full active set, expected revisions/numbers, atomic temporary→final numbering; max 200 |
| `/api/sync` | GET | Existing envelope plus spread_notes/activity_events; boundary seq ties included |
| `/api/notebooks/:id/snapshot` | GET | Existing keys retained, spread_notes added |
| `/api/me` | GET | Existing identity plus feature capabilities |
| `/api/favorites/:spreadId` | PUT | Existing route now checks existence, non-deleted spread and active membership |

Existing photo upload/make-current routes remain. Old photo `is_current=0` changes now receive seq;
`photo.added`/`photo.made_current` events use the real upload/switch operations. No invented rotate endpoint.
CORS includes PUT. New notes/field/reorder mutations allocate seq inside their mutation batch.
Several rows may share seq; pagination deliberately returns the entire boundary group.

Reorder uses JSON bindings and two bulk updates, rather than 3N bound parameters or 2N update queries.
This follows [D1's documented parameter/query and batch limits](https://developers.cloudflare.com/d1/platform/limits/).

## Verification

| Check | Result |
|---|---|
| Syntax of Worker, consolidated modules, new tests | PASS |
| Generated payload/manifest consistency | PASS |
| Backend: all 22 requested scenarios plus races, 200-spread reorder/snapshot and seq ties | PASS — Node SQLite adapter, not deployed D1 |
| Frontend sync: dependency/retry, own-note conflicts, pending photo, late upload response, missing-parent recovery, old-cursor backfill | PASS — isolated VM |
| Existing offline SW, runtime integrity and UI contract suites | PASS |
| Real IndexedDB v2→v3/reopen, original retained, transaction rollback, note/outbox, photo versus stale text | PASS — embedded browser, synthetic data |
| Real IndexedDB per-note conflict retry with a newly generated queue key | PASS — regression found in browser, fixed, rerun successfully |
| Browser UI: note add/own edit controls, field edit, history details/navigation, explicit reorder/confirmation, viewer Back | PASS — embedded browser, mocked API |
| Top viewer button appearance | PASS — white icon, translucent circle, 44 CSS px (fractional layout rounding) |
| Standalone Chromium automated runtime script | BLOCKED locally: sandbox `spawn EPERM`; not reported as PASS |
| GitHub Actions for new commits | NOT RUN — commits are local |
| Production Pages / Worker / D1 changes | NOT ATTEMPTED, by request |
| Real Android, two physical phones, real staging D1/Telegram | NOT TESTED |

Run `npm test`, `npm run check:generated` and the syntax checks without additional dependencies.
For the optional automated browser script, install Playwright in a suitable test environment and run `npm run test:runtime`.
It also accepts `PLAYWRIGHT_MODULE_PATH` and `CHROME_PATH` for existing installations.
For manual isolated checks, run `npm run preview:team` and open its printed localhost URL.
The fallback assembles the same runtime modules but substitutes test initialization/API; it is not a production Pages/network test.

## Remaining risks / release gates

See `UNRESOLVED.md`. Do not promote this branch just because unit tests passed.

## Staged rollout plan — requires separate approval

1. Push **only this feature branch**, run GitHub CI and the full isolated Chromium script. Review the exact diff/SHAs. No Pages deployment.
2. Prepare and test a rollback frontend based on stable 3.4.2 whose DB opener tolerates v3. A blind rollback to the original v2-only opener can fail with VersionError after upgrade. Do not clear/downgrade IndexedDB.
3. In a separately approved staging Worker/D1, load the captured schema and synthetic fixtures, apply only `0001_team_history_notes.sql`, deploy the candidate Worker, and repeat notes/auth/roles/revision/reorder/tie-pagination/photo tests against real D1. Verify DB binding and secret *names*, never log values.
4. Test a non-production frontend with two Android phones, separate browser storage, staging identities and test photos: offline notes, same-note conflicts, independent photo/text, upload interruption, delete/reorder conflict, Back/zoom/pan, cache upgrade and cold-start DB upgrade. Verify original retention.
5. Stop for explicit production approval with test evidence, rollback artifacts and exact migration/Worker/frontend SHAs. No automatic promotion.
6. Only after approval: take a supported production recovery point/export; apply the additive migration; verify schema read-only; deploy Worker while keeping stable frontend; verify old-client compatibility and capabilities.
7. Only after backend verification: publish the approved frontend/version and verify actual Pages artifact/URL/manifest/SW and both phones. Keep backward-compatible backend/migration in place if reverting frontend. Never drop the new tables or clear local user data as rollback.
