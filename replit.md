# DLS Prediction Arena

An API-first multiplayer prediction game for Dream League Soccer players to compete on match outcomes and odds-based points.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for the game API and generated client/Zod contracts
- `lib/db/src/schema/index.ts` — persistent players, matches, rooms, room memberships, and predictions
- `artifacts/api-server/src/routes/game.ts` — room lifecycle, scoring, match settlement, and SSE updates

## Architecture decisions

- Prediction values are points only; there are no deposits, withdrawals, purchases, or cash-out flows.
- Odds are locked onto a prediction at submission time so later fixture changes cannot rewrite a player's risk.
- Room updates use server-sent events, which keeps the first client integration simple while still supporting live multiplayer updates.
- The first server version accepts a client-provided player ID; production authentication can later map that identity to a Clerk/Replit user without changing game scoring.

## Product

- Lists seeded DLS-style fixtures with home/draw/away odds.
- Creates and joins six-character multiplayer rooms.
- Accepts one replaceable prediction per player, room, and match until kickoff.
- Scores correct outcomes at `round(odds * 10)` points and exposes ranked room leaderboards.
- Streams player joins, prediction submissions, and settled match updates over SSE.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run `pnpm --filter @workspace/db run push` after schema changes before starting the API.
- Match settlement requires the `X-Admin-Key` header and uses `GAME_ADMIN_KEY`, falling back to the configured `SESSION_SECRET`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
