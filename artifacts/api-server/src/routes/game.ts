import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  CreateRoomBody,
  GetLeaderboardParams,
  GetRoomParams,
  JoinRoomBody,
  JoinRoomParams,
  ListMatchesResponse,
  ListRoomsResponse,
  SubmitPredictionBody,
  SubmitPredictionParams,
} from "@workspace/api-zod";
import {
  db,
  matchesTable,
  playersTable,
  predictionsTable,
  roomPlayersTable,
  roomsTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

type Outcome = "home" | "draw" | "away";

const router: IRouter = Router();
const subscribers = new Map<string, Set<Response>>();

const error = (res: Response, status: number, message: string) =>
  res.status(status).json({ message });

const makeRoomCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () =>
    alphabet[randomInt(0, alphabet.length)],
  ).join("");
};

const outcomeForScore = (homeScore: number, awayScore: number): Outcome =>
  homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";

const oddsForOutcome = (
  match: { homeOdds: number; drawOdds: number; awayOdds: number },
  outcome: Outcome,
) =>
  outcome === "home"
    ? match.homeOdds
    : outcome === "draw"
      ? match.drawOdds
      : match.awayOdds;

const serializeMatch = (match: typeof matchesTable.$inferSelect) => ({
  id: match.id,
  homeTeam: match.homeTeam,
  awayTeam: match.awayTeam,
  kickoffAt: match.kickoffAt,
  status: match.status as "scheduled" | "live" | "finished",
  homeOdds: match.homeOdds,
  drawOdds: match.drawOdds,
  awayOdds: match.awayOdds,
  homeScore: match.homeScore,
  awayScore: match.awayScore,
});

const getRoom = async (code: string) => {
  const rows = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.code, code))
    .limit(1);
  return rows[0];
};

const getLeaderboard = async (roomId: string) => {
  const rows = await db
    .select({
      playerId: playersTable.id,
      playerName: playersTable.name,
      points: sql<number>`coalesce(sum(${predictionsTable.points}), 0)`.mapWith(
        Number,
      ),
      predictions: sql<number>`count(${predictionsTable.id})`.mapWith(Number),
      correct: sql<number>`count(*) filter (where ${predictionsTable.points} > 0)`.mapWith(
        Number,
      ),
    })
    .from(roomPlayersTable)
    .innerJoin(playersTable, eq(playersTable.id, roomPlayersTable.playerId))
    .leftJoin(
      predictionsTable,
      and(
        eq(predictionsTable.playerId, roomPlayersTable.playerId),
        eq(predictionsTable.roomId, roomPlayersTable.roomId),
      ),
    )
    .where(eq(roomPlayersTable.roomId, roomId))
    .groupBy(playersTable.id, playersTable.name)
    .orderBy(
      desc(sql<number>`coalesce(sum(${predictionsTable.points}), 0)`),
      asc(playersTable.name),
    );

  return rows.map((row, index) => ({
    rank: index + 1,
    playerId: row.playerId,
    playerName: row.playerName,
    points: row.points,
    predictions: row.predictions,
    correct: row.correct,
  }));
};

const publish = (roomCode: string, event: string, data: unknown) => {
  const roomSubscribers = subscribers.get(roomCode);
  if (!roomSubscribers) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of roomSubscribers) response.write(payload);
};

router.get("/matches", async (_req, res) => {
  const matches = await db
    .select()
    .from(matchesTable)
    .orderBy(asc(matchesTable.kickoffAt));
  res.json(ListMatchesResponse.parse(matches.map(serializeMatch)));
});

router.put("/matches/:matchId/result", async (req, res) => {
  const configuredKey = process.env.GAME_ADMIN_KEY ?? process.env.SESSION_SECRET;
  const providedKey = req.get("x-admin-key") ?? "";
  if (!configuredKey) return error(res, 503, "Match settlement is not configured");

  const expected = Buffer.from(configuredKey);
  const provided = Buffer.from(providedKey);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return error(res, 403, "Invalid admin key");
  }

  const homeScore = Number(req.body?.homeScore);
  const awayScore = Number(req.body?.awayScore);
  if (
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore) ||
    homeScore < 0 ||
    awayScore < 0
  ) {
    return error(res, 400, "Scores must be non-negative integers");
  }

  const matches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.id, req.params.matchId))
    .limit(1);
  const match = matches[0];
  if (!match) return error(res, 404, "Match not found");

  const [updated] = await db
    .update(matchesTable)
    .set({ status: "finished", homeScore, awayScore })
    .where(eq(matchesTable.id, match.id))
    .returning();

  const result = outcomeForScore(homeScore, awayScore);
  const predictions = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.matchId, match.id));
  const roomIds = new Set<string>();

  for (const prediction of predictions) {
    roomIds.add(prediction.roomId);
    await db
      .update(predictionsTable)
      .set({
        points:
          prediction.outcome === result
            ? Math.round(prediction.odds * 10)
            : 0,
      })
      .where(eq(predictionsTable.id, prediction.id));
  }

  if (roomIds.size) {
    const roomRows = await db
      .select({ id: roomsTable.id, code: roomsTable.code })
      .from(roomsTable)
      .where(inArray(roomsTable.id, [...roomIds]));
    for (const room of roomRows) {
      publish(room.code, "match_settled", serializeMatch(updated));
      publish(room.code, "leaderboard_updated", {
        leaderboard: await getLeaderboard(room.id),
      });
    }
  }

  return res.json(serializeMatch(updated));
});

router.get("/rooms", async (_req, res) => {
  const rooms = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.status, "lobby"))
    .orderBy(desc(roomsTable.createdAt));

  const summaries = await Promise.all(
    rooms.map(async (room) => {
      const players = await db
        .select({ playerId: roomPlayersTable.playerId })
        .from(roomPlayersTable)
        .where(eq(roomPlayersTable.roomId, room.id));
      return {
        code: room.code,
        name: room.name,
        status: room.status as "lobby" | "live" | "finished",
        playerCount: players.length,
        maxPlayers: room.maxPlayers,
        createdAt: room.createdAt,
      };
    }),
  );

  res.json(ListRoomsResponse.parse(summaries));
});

router.post("/rooms", async (req, res) => {
  const parsed = CreateRoomBody.safeParse(req.body);
  if (!parsed.success) return error(res, 400, "Invalid room details");

  let code = makeRoomCode();
  while (await getRoom(code)) code = makeRoomCode();

  const playerId = `player_${randomUUID()}`;
  const [player] = await db
    .insert(playersTable)
    .values({ id: playerId, name: parsed.data.hostName })
    .returning();
  const [room] = await db
    .insert(roomsTable)
    .values({
      code,
      name: parsed.data.name,
      hostPlayerId: player.id,
      maxPlayers: parsed.data.maxPlayers,
    })
    .returning();
  await db
    .insert(roomPlayersTable)
    .values({ roomId: room.id, playerId: player.id });

  publish(room.code, "player_joined", { playerId: player.id, name: player.name });
  return res.status(201).json({
    code: room.code,
    name: room.name,
    status: room.status,
    playerCount: 1,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    hostPlayerId: player.id,
  });
});

router.get("/rooms/:roomCode", async (req, res) => {
  const parsed = GetRoomParams.safeParse(req.params);
  if (!parsed.success) return error(res, 400, "Invalid room code");

  const room = await getRoom(parsed.data.roomCode);
  if (!room) return error(res, 404, "Room not found");

  const players = await db
    .select({
      id: playersTable.id,
      name: playersTable.name,
      joinedAt: roomPlayersTable.joinedAt,
    })
    .from(roomPlayersTable)
    .innerJoin(playersTable, eq(playersTable.id, roomPlayersTable.playerId))
    .where(eq(roomPlayersTable.roomId, room.id))
    .orderBy(asc(roomPlayersTable.joinedAt));
  const matches = await db
    .select()
    .from(matchesTable)
    .orderBy(asc(matchesTable.kickoffAt));

  return res.json({
    code: room.code,
    name: room.name,
    status: room.status,
    playerCount: players.length,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    hostPlayerId: room.hostPlayerId,
    players,
    matches: matches.map(serializeMatch),
    leaderboard: await getLeaderboard(room.id),
  });
});

router.post("/rooms/:roomCode/players", async (req, res) => {
  const params = JoinRoomParams.safeParse(req.params);
  const body = JoinRoomBody.safeParse(req.body);
  if (!params.success || !body.success) {
    return error(res, 400, "Invalid player details");
  }

  const room = await getRoom(params.data.roomCode);
  if (!room) return error(res, 404, "Room not found");

  const existingPlayers = await db
    .select()
    .from(roomPlayersTable)
    .where(eq(roomPlayersTable.roomId, room.id));
  const alreadyJoined = existingPlayers.some(
    (player) => player.playerId === body.data.playerId,
  );
  if (!alreadyJoined && existingPlayers.length >= room.maxPlayers) {
    return error(res, 409, "Room is full");
  }

  const [player] = await db
    .insert(playersTable)
    .values({ id: body.data.playerId, name: body.data.name })
    .onConflictDoUpdate({
      target: playersTable.id,
      set: { name: body.data.name },
    })
    .returning();
  await db
    .insert(roomPlayersTable)
    .values({ roomId: room.id, playerId: player.id })
    .onConflictDoNothing();

  const joinedAt =
    existingPlayers.find((entry) => entry.playerId === player.id)?.joinedAt ??
    new Date();
  publish(room.code, "player_joined", { playerId: player.id, name: player.name });
  return res.status(201).json({ id: player.id, name: player.name, joinedAt });
});

router.post("/rooms/:roomCode/predictions", async (req, res) => {
  const params = SubmitPredictionParams.safeParse(req.params);
  const body = SubmitPredictionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    return error(res, 400, "Invalid prediction");
  }

  const room = await getRoom(params.data.roomCode);
  if (!room) return error(res, 404, "Room not found");

  const membership = await db
    .select()
    .from(roomPlayersTable)
    .where(
      and(
        eq(roomPlayersTable.roomId, room.id),
        eq(roomPlayersTable.playerId, body.data.playerId),
      ),
    )
    .limit(1);
  if (!membership[0]) return error(res, 409, "Player is not in this room");

  const matches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.id, body.data.matchId))
    .limit(1);
  const match = matches[0];
  if (!match) return error(res, 404, "Match not found");
  if (match.status !== "scheduled" || match.kickoffAt <= new Date()) {
    return error(res, 409, "Predictions are locked for this match");
  }

  const odds = oddsForOutcome(match, body.data.outcome as Outcome);
  const [prediction] = await db
    .insert(predictionsTable)
    .values({
      roomId: room.id,
      matchId: match.id,
      playerId: body.data.playerId,
      outcome: body.data.outcome,
      odds,
      points: 0,
    })
    .onConflictDoUpdate({
      target: [
        predictionsTable.roomId,
        predictionsTable.matchId,
        predictionsTable.playerId,
      ],
      set: {
        outcome: body.data.outcome,
        odds,
        points: 0,
        submittedAt: new Date(),
      },
    })
    .returning();

  publish(room.code, "prediction_submitted", {
    playerId: prediction.playerId,
    matchId: prediction.matchId,
  });
  return res.status(201).json(prediction);
});

router.get("/rooms/:roomCode/leaderboard", async (req, res) => {
  const params = GetLeaderboardParams.safeParse(req.params);
  if (!params.success) return error(res, 400, "Invalid room code");
  const room = await getRoom(params.data.roomCode);
  if (!room) return error(res, 404, "Room not found");
  return res.json(await getLeaderboard(room.id));
});

router.get("/rooms/:roomCode/events", async (req, res) => {
  const params = GetRoomParams.safeParse(req.params);
  if (!params.success) return error(res, 400, "Invalid room code");
  const room = await getRoom(params.data.roomCode);
  if (!room) return error(res, 404, "Room not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ roomCode: room.code })}\n\n`);

  const roomSubscribers = subscribers.get(room.code) ?? new Set<Response>();
  roomSubscribers.add(res);
  subscribers.set(room.code, roomSubscribers);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    roomSubscribers.delete(res);
    if (!roomSubscribers.size) subscribers.delete(room.code);
  });
  return;
});

export const seedDemoMatches = async () => {
  const existing = await db.select({ id: matchesTable.id }).from(matchesTable).limit(1);
  if (existing.length) return;

  const now = Date.now();
  await db.insert(matchesTable).values([
    {
      homeTeam: "Red Lions",
      awayTeam: "Blue Sharks",
      kickoffAt: new Date(now + 45 * 60_000),
      status: "scheduled",
      homeOdds: 1.65,
      drawOdds: 3.4,
      awayOdds: 4.8,
    },
    {
      homeTeam: "Golden Eagles",
      awayTeam: "Street Kings",
      kickoffAt: new Date(now + 2 * 60 * 60_000),
      status: "scheduled",
      homeOdds: 2.15,
      drawOdds: 3.1,
      awayOdds: 2.85,
    },
    {
      homeTeam: "Accra Stars",
      awayTeam: "Lagoon FC",
      kickoffAt: new Date(now + 4 * 60 * 60_000),
      status: "scheduled",
      homeOdds: 1.9,
      drawOdds: 3.25,
      awayOdds: 3.65,
    },
  ]);
};

export default router;