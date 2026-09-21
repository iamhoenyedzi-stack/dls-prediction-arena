---
name: Game server decisions
description: Durable product decisions for the DLS prediction game server.
---

The first release is an API-first, points-only multiplayer game. Players submit
one prediction per room and fixture until kickoff, and a correct outcome scores
the locked odds multiplied by ten. There are no money movement features.

**Why:** The user explicitly described a skilled-based prediction app with no
real-money involvement, so scoring and room competition are the product core.

**How to apply:** Keep future client work centered on rooms, fixtures,
predictions, score settlement, leaderboards, and live room updates. If auth is
added later, map authenticated users to the existing player identity boundary
instead of changing scoring rules.