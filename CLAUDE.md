# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unified Discord bot (Lau#7810) for Nico Barrera Academy. One bot, one token, serving 2 programs (Programa A and Creeser) across 2 Discord servers. Each program has 2 Hotmart products, its own Google Sheet, n8n webhook, and Discord roles. Differentiation is config-driven via `config.js`, not code duplication.

## Commands

```bash
npm install        # Install dependencies
npm start          # Start the bot (alias for node index.js, requires .env configured)
node cleanup-duplicates.js  # One-off: remove duplicate rows by userId in miembros_discord sheets
```

No test framework is configured.

## Architecture

**Single Client pattern**: `index.js` creates one Discord.js Client, calls `setup(client, config)` on all modules **before** `client.login()`, then registers a `ClientReady` listener only for the connection log. Modules must register their own listeners (including `ClientReady`) inside `setup()` before login — if setup is called after `ClientReady` fires, listeners that use `client.once(ClientReady)` internally will never trigger.

**config.js** exports a flat config object with:
- `PROGRAMS` object keyed by program name (`programaA`, `programaB`)
- `getProgramByGuildId(id)` and `getProgramByProductId(id)` helpers
- Each program contains: guildId, roles array, roleColumns array, sheetId, webhookN8n, inviteChannelId, appscript config, email config (title, greeting, body, cta, closing, teamName)

**Modules** (`modules/`):
- `verificacion.js` — 4-step acceptance flow (terms/privacy/rules/disclaimer) → Discord Modal for Hotmart code → POST to n8n webhook → role assignment → calls `markVerified()` → writes roles to Sheet role columns. Detects program by `guildId`. Imports `markVerified` from `roles.js`.
- `roles.js` — Reads Google Sheets every 60s, full bidirectional sync from role columns. Deduplicates rows by userId (keeps row with most roles). Uses `.add()` and `.remove()` selectively on managed roles only (dynamic set built from role column values + `programa.roles` + previous cycle carryover). Skips recently verified users via `isRecentlyVerified()` (120s TTL). Has `isSyncing` guard to skip a tick if the previous sync hasn't finished. `Unknown Member` errors (user left server) are caught per-user and don't abort the sync. Exports `markVerified(guildId, userId)`.
- `invites.js` — Express server on configurable port. Endpoints: `GET /api/invite/:programa` (generates 1-use invite), `POST /api/hotmart/webhook` (receives Hotmart purchases, creates invite, sends branded email via Apps Script). Anti-duplicate invite cache keyed by `txnId` and `email::programName` (30min TTL). Bottleneck rate limiting.
- `miembros.js` — Listens for `guildMemberAdd`, checks if userId already exists in Sheet (with precision-safe comparison), writes new member row if not found. `pendingAdds` Set prevents concurrent writes for the same user.

**Utils** (`utils/`):
- `sheets.js` — Shared Google Auth (service account JSON file), exports `getRows`, `appendRow`, `updateRow`. Uses `valueInputOption: 'RAW'` to prevent Google Sheets from interpreting large userIds as numbers (precision loss). In `updateRow`, the start row is parsed from the cell reference part only (after `!`), not the full range string — sheet names that contain digits (e.g. `datos2025!A2:F`) would otherwise be misparsed.
- `discord.js` — `asignarRoles(guild, userId, roleNames)` using only `.add()`, `enviarBotonVerificacion(channel)`
- `logger.js` — Pino with pino-pretty transport (uses worker thread), `child(programName)` for scoped logs

## Critical Constraints

- **roles.js NEVER uses `member.roles.set()`** — uses selective `.add()` / `.remove()` only on managed roles (built dynamically from Sheet role columns + config + previous cycle). Unmanaged roles (admin, moderator, etc.) are never touched. The old production bug was caused by multiple bots using `.set()` simultaneously. The previous-cycle carryover (`previousManagedByGuild`) ensures that if a role disappears from ALL Sheet rows, it still gets removed from the last user holding it on the next cycle.
- **verificacion.js must call `markVerified(guildId, userId)` immediately after assigning roles** — this puts the user on a 120s skip list so the roles.js sync won't remove their roles while the Sheet write is in flight. Without this, a sync cycle that started before verification read stale (empty) role columns and strips roles within milliseconds of assignment.
- **verificacion.js must ALWAYS write roles to Sheet role columns** after assigning them, so the next roles.js sync (after the skip window expires) sees the correct state.
- **sheets.js must use `valueInputOption: 'RAW'`** — Discord userIds are 18-19 digit integers. With `USER_ENTERED`, Google Sheets interprets them as numbers and loses precision (last digits become 0). This causes userId lookups to fail silently, leading to duplicate rows. Always use `RAW`.
- **miembros.js userId comparison must handle precision loss** — existing Sheet data may have precision-lost userIds from before the `RAW` fix. The check uses `startsWith(id.slice(0, 15))` as fallback for legacy data.
- **roles.js deduplicates rows by userId** — if multiple rows exist for the same user, only the row with the most roles is processed. This prevents stale empty-role duplicates from overriding valid role assignments.
- **Invite cache is keyed by `email::programName`**, not just email — prevents cross-program cache hits when the same person buys both programs (each needs an invite to a different server).
- **Only run ONE bot process at a time** — zombie Node processes from previous runs stay connected to Discord and receive events, causing duplicate Sheet writes. Always verify with `tasklist | grep node` and kill stale `index.js` processes before starting.

## Google Sheets Structure

- Program A verification roles: `["Activo", "2026-1.2", "Iniciador de Mercados"]`. Program B: `["Activo"]`.
- **Programa A**: columns A-G (username, displayName, tag, userId, Estado, Generacion, Nivel). Each role column has one role value.
- **Programa B**: columns A-E (username, displayName, tag, userId, Estado). Single role column.
- `roleColumns` in config maps each role category to its Sheet column index and letter. `roles[]` and `roleColumns[]` are 1:1 positional (roles[0] → roleColumns[0] on verification).

## Module Dependencies

```
verificacion.js ──→ roles.js (markVerified)
verificacion.js ──→ utils/discord.js (asignarRoles)
verificacion.js ──→ utils/sheets.js (updateRow)
roles.js ──→ utils/sheets.js (getRows)
miembros.js ──→ utils/sheets.js (getRows, appendRow)
invites.js ──→ config (getProgramByProductId)
```

## Adding a New Program

Add a new entry in `config.js` → `PROGRAMS` with the same shape as existing entries (including the `email` object for branded invite emails), add corresponding env vars in `.env`, and the modules will pick it up automatically via the `getProgramByGuildId`/`getProgramByProductId` helpers. No module code changes needed.

## Environment Variables (20)

`DISCORD_TOKEN`, `GOOGLE_CREDENTIALS_PATH`, `HOTTOK`, `PORT` + per program (A and B): `GUILD_ID`, `INVITE_CHANNEL_ID`, `HOTMART_PRODUCT_1`, `HOTMART_PRODUCT_2`, `SHEET_ID`, `N8N_WEBHOOK`, `APPSCRIPT_URL`, `APPSCRIPT_TOKEN`
