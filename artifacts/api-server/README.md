# DLS Prediction Arena API

The API server powers a points-only multiplayer prediction game for Dream
League Soccer players. It is mounted at `/api` and uses the project's
PostgreSQL database.

## Core flow

1. `GET /api/matches` returns scheduled fixtures and home/draw/away odds.
2. `POST /api/rooms` creates a six-character room and its host player.
3. `POST /api/rooms/:code/players` joins another player to the room.
4. `POST /api/rooms/:code/predictions` submits or replaces one prediction per
   player, fixture, and room until kickoff.
5. `GET /api/rooms/:code/leaderboard` returns ranked points and accuracy.
6. `GET /api/rooms/:code/events` opens a server-sent event stream for live room
   updates.

## Scoring

Correct predictions score `round(locked odds * 10)` points. Incorrect
predictions score zero. Odds are copied to the prediction when it is submitted
so later fixture edits cannot change a player's result.

## Settling a match

Match results are an admin operation:

```sh
curl -X PUT "$BASE/api/matches/<match-id>/result" \
  -H "content-type: application/json" \
  -H "x-admin-key: $GAME_ADMIN_KEY" \
  -d '{"homeScore": 3, "awayScore": 1}'
```

The handler accepts `GAME_ADMIN_KEY`; for the starter environment it falls back
to the configured `SESSION_SECRET`. It marks the fixture finished, scores every
prediction, and broadcasts match and leaderboard updates to affected rooms.