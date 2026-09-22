import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  CreateMatchBody,
  CreateMatchParams,
  CreateRoomBody,
  GetLeaderboardParams,
  GetRoomParams,
  JoinRoomBody,
  JoinRoomParams,
  ListMatchesResponse,
  ListRoomsResponse,
  SettleMatchBody,
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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

type Outcome = "a" | "draw" | "b";
type PlayerRecord = { wins: number; losses: number };

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
  homeScore > awayScore ? "a" : homeScore < awayScore ? "b" : "draw";

const oddsForOutcome = (
  match: { homeOdds: number; drawOdds: number; awayOdds: number },
  outcome: Outcome,
) =>
  outcome === "a"
    ? match.homeOdds
    : outcome === "draw"
      ? match.drawOdds
      : match.awayOdds;

const playerKey = (name: string) => name.trim().toLocaleLowerCase();

const calculateOdds = (playerA: PlayerRecord, playerB: PlayerRecord) => {
  const aStrength = (playerA.wins + 1) / (playerA.losses + 1);
  const bStrength = (playerB.wins + 1) / (playerB.losses + 1);
  const drawStrength = 0.5;
  const total = aStrength + bStrength + drawStrength;

  return {
    playerAOdds: Number((total / aStrength).toFixed(2)),
    drawOdds: Number((total / drawStrength).toFixed(2)),
    playerBOdds: Number((total / bStrength).toFixed(2)),
  };
};

const getPlayerRecords = async (roomId?: string) => {
  const finishedMatches = await db
    .select({
      playerAName: matchesTable.homeTeam,
      playerBName: matchesTable.awayTeam,
      result: matchesTable.result,
      playerAScore: matchesTable.homeScore,
      playerBScore: matchesTable.awayScore,
    })
    .from(matchesTable)
    .where(
      roomId
        ? and(eq(matchesTable.roomId, roomId), eq(matchesTable.status, "finished"))
        : eq(matchesTable.status, "finished"),
    );

  const records = new Map<string, PlayerRecord>();
  const ensure = (name: string) => {
    const key = playerKey(name);
    const existing = records.get(key);
    if (existing) return existing;
    const next = { wins: 0, losses: 0 };
    records.set(key, next);
    return next;
  };

  for (const match of finishedMatches) {
    const result =
      match.result === "a" || match.result === "b" || match.result === "draw"
        ? match.result
        : match.playerAScore !== null && match.playerBScore !== null
          ? outcomeForScore(match.playerAScore, match.playerBScore)
          : null;
    if (!result) continue;
    const playerA = ensure(match.playerAName);
    const playerB = ensure(match.playerBName);
    if (result === "a") {
      playerA.wins += 1;
      playerB.losses += 1;
    } else if (result === "b") {
      playerB.wins += 1;
      playerA.losses += 1;
    }
  }

  return records;
};

const serializeMatch = (
  match: typeof matchesTable.$inferSelect,
  records: Map<string, PlayerRecord>,
) => {
  const playerARecord = records.get(playerKey(match.homeTeam)) ?? {
    wins: 0,
    losses: 0,
  };
  const playerBRecord = records.get(playerKey(match.awayTeam)) ?? {
    wins: 0,
    losses: 0,
  };

  return {
  id: match.id,
  playerAName: match.homeTeam,
  playerBName: match.awayTeam,
  scheduledAt: match.kickoffAt,
  status: match.status as "scheduled" | "live" | "finished",
  playerAOdds: match.homeOdds,
  drawOdds: match.drawOdds,
  playerBOdds: match.awayOdds,
  result:
    match.result === "a" || match.result === "draw" || match.result === "b"
      ? match.result
      : null,
  creatorPlayerId: match.createdBy,
  playerARecord,
  playerBRecord,
  };
};

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
  const records = await getPlayerRecords();
  res.json(ListMatchesResponse.parse(matches.map((match) => serializeMatch(match, records))));
});

router.put("/matches/:matchId/result", async (req, res) => {
  const parsed = SettleMatchBody.safeParse(req.body);
  if (!parsed.success) return error(res, 400, "Invalid match result");

  const configuredKey = process.env.GAME_ADMIN_KEY ?? process.env.SESSION_SECRET;
  const providedKey = req.get("x-admin-key") ?? "";
  const adminAuthorized = Boolean(
    configuredKey &&
      providedKey &&
      Buffer.byteLength(configuredKey) === Buffer.byteLength(providedKey) &&
      timingSafeEqual(Buffer.from(configuredKey), Buffer.from(providedKey)),
  );

  const matches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.id, req.params.matchId))
    .limit(1);
  const match = matches[0];
  if (!match) return error(res, 404, "Match not found");
  if (match.status === "finished") return error(res, 409, "Match is already settled");

  const room = match.roomId
    ? (
        await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.id, match.roomId))
          .limit(1)
      )[0]
    : undefined;
  const creatorAuthorized = Boolean(
    room &&
      (match.createdBy === parsed.data.actorPlayerId ||
        room.hostPlayerId === parsed.data.actorPlayerId),
  );
  if (!adminAuthorized && !creatorAuthorized) {
    return error(res, 403, "Only the challenge creator, room host, or moderator can settle this match");
  }
  if (match.kickoffAt > new Date()) {
    return error(res, 409, "This match has not reached its scheduled time");
  }

  const result = parsed.data.result as Outcome;
  const homeScore = result === "a" ? 1 : 0;
  const awayScore = result === "b" ? 1 : 0;

  const [updated] = await db
    .update(matchesTable)
    .set({ status: "finished", result, homeScore, awayScore })
    .where(eq(matchesTable.id, match.id))
    .returning();

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
          (prediction.outcome === "home" ? "a" : prediction.outcome === "away" ? "b" : prediction.outcome) === result
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
      const records = await getPlayerRecords(room.id);
      publish(room.code, "match_settled", serializeMatch(updated, records));
      publish(room.code, "leaderboard_updated", {
        leaderboard: await getLeaderboard(room.id),
      });
    }
  }

  const records = await getPlayerRecords(match.roomId ?? undefined);
  return res.json(serializeMatch(updated, records));
});

router.post("/rooms/:roomCode/matches", async (req, res) => {
  const params = CreateMatchParams.safeParse(req.params);
  const body = CreateMatchBody.safeParse(req.body);
  if (!params.success || !body.success) {
    return error(res, 400, "Invalid challenge details");
  }

  const room = await getRoom(params.data.roomCode);
  if (!room) return error(res, 404, "Room not found");
  if (room.status === "finished") return error(res, 409, "This room is finished");

  const membership = await db
    .select()
    .from(roomPlayersTable)
    .where(
      and(
        eq(roomPlayersTable.roomId, room.id),
        eq(roomPlayersTable.playerId, body.data.creatorPlayerId),
      ),
    )
    .limit(1);
  if (!membership[0]) return error(res, 409, "Join the room before creating a challenge");

  const playerAName = body.data.playerAName.trim();
  const playerBName = body.data.playerBName.trim();
  if (playerKey(playerAName) === playerKey(playerBName)) {
    return error(res, 400, "Player A and Player B must be different");
  }
  if (body.data.scheduledAt <= new Date()) {
    return error(res, 400, "Scheduled time must be in the future");
  }

  const records = await getPlayerRecords(room.id);
  const playerARecord = records.get(playerKey(playerAName)) ?? {
    wins: 0,
    losses: 0,
  };
  const playerBRecord = records.get(playerKey(playerBName)) ?? {
    wins: 0,
    losses: 0,
  };
  const odds = calculateOdds(playerARecord, playerBRecord);
  const [match] = await db
    .insert(matchesTable)
    .values({
      roomId: room.id,
      createdBy: body.data.creatorPlayerId,
      homeTeam: playerAName,
      awayTeam: playerBName,
      kickoffAt: body.data.scheduledAt,
      status: "scheduled",
      homeOdds: odds.playerAOdds,
      drawOdds: odds.drawOdds,
      awayOdds: odds.playerBOdds,
      result: null,
    })
    .returning();

  publish(room.code, "match_created", {
    match: serializeMatch(match, records),
  });
  return res.status(201).json(serializeMatch(match, records));
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
    .where(eq(matchesTable.roomId, room.id))
    .orderBy(asc(matchesTable.kickoffAt));
  const records = await getPlayerRecords(room.id);

  return res.json({
    code: room.code,
    name: room.name,
    status: room.status,
    playerCount: players.length,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    hostPlayerId: room.hostPlayerId,
    players,
    matches: matches.map((match) => serializeMatch(match, records)),
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
    .where(
      and(
        eq(matchesTable.id, body.data.matchId),
        eq(matchesTable.roomId, room.id),
      ),
    )
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
  const room = await getRoom("QBQ5V5");
  if (!room) return;

  const roomMatches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.roomId, room.id));
  if (roomMatches.length) return;

  const legacyMatches = await db
    .select()
    .from(matchesTable)
    .where(isNull(matchesTable.roomId))
    .orderBy(asc(matchesTable.kickoffAt));
  const now = Date.now();
  const seedPlayers = [
    ["Kwame “Ice” Mensah", "Yaw “The Wall” Boateng", 45],
    ["Kojo “Clutch” Asante", "Nana “Rocket” Owusu", 120],
    ["Kofi “Viper” Addo", "Esi “Maestro” Quaye", 240],
  ] as const;

  if (legacyMatches.length) {
    for (const [index, match] of legacyMatches.slice(0, seedPlayers.length).entries()) {
      const [playerAName, playerBName, minutes] = seedPlayers[index];
      const odds = calculateOdds({ wins: 0, losses: 0 }, { wins: 0, losses: 0 });
      await db
        .update(matchesTable)
        .set({
          roomId: room.id,
          createdBy: room.hostPlayerId,
          homeTeam: playerAName,
          awayTeam: playerBName,
          kickoffAt: new Date(now + minutes * 60_000),
          status: "scheduled",
          homeOdds: odds.playerAOdds,
          drawOdds: odds.drawOdds,
          awayOdds: odds.playerBOdds,
          result: null,
          homeScore: null,
          awayScore: null,
        })
        .where(eq(matchesTable.id, match.id));
    }
    return;
  }

  const odds = calculateOdds({ wins: 0, losses: 0 }, { wins: 0, losses: 0 });
  await db.insert(matchesTable).values(
    seedPlayers.map(([playerAName, playerBName, minutes]) => ({
      roomId: room.id,
      createdBy: room.hostPlayerId,
      homeTeam: playerAName,
      awayTeam: playerBName,
      kickoffAt: new Date(now + minutes * 60_000),
      status: "scheduled",
      homeOdds: odds.playerAOdds,
      drawOdds: odds.drawOdds,
      awayOdds: odds.playerBOdds,
      result: null,
    })),
  );
};

export default router;