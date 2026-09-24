import {
  integer,
  real,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  uuid,
  pgTable,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const playersTable = pgTable(
  "players",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const matchesTable = pgTable("matches", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id"),
  createdBy: text("created_by"),
  playerAId: text("player_a_id"),
  playerBId: text("player_b_id"),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("scheduled"),
  homeOdds: real("home_odds").notNull(),
  drawOdds: real("draw_odds").notNull(),
  awayOdds: real("away_odds").notNull(),
  result: text("result"),
  resultReported: text("result_reported"),
  playerAConfirmed: boolean("player_a_confirmed").notNull().default(false),
  playerBConfirmed: boolean("player_b_confirmed").notNull().default(false),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const roomsTable = pgTable(
  "rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("lobby"),
    hostPlayerId: text("host_player_id").notNull(),
    maxPlayers: integer("max_players").notNull().default(20),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex("rooms_code_idx").on(table.code),
  }),
);

export const roomPlayersTable = pgTable(
  "room_players",
  {
    roomId: uuid("room_id").notNull(),
    playerId: text("player_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomId, table.playerId] }),
  }),
);

export const predictionsTable = pgTable(
  "predictions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull(),
    matchId: uuid("match_id").notNull(),
    playerId: text("player_id").notNull(),
    outcome: text("outcome").notNull(),
    odds: real("odds").notNull(),
    points: integer("points").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    playerMatchIdx: uniqueIndex("predictions_player_match_idx").on(
      table.roomId,
      table.matchId,
      table.playerId,
    ),
  }),
);

export const insertPlayerSchema = createInsertSchema(playersTable);
export const insertMatchSchema = createInsertSchema(matchesTable);
export const insertRoomSchema = createInsertSchema(roomsTable);
export const insertRoomPlayerSchema = createInsertSchema(roomPlayersTable);
export const insertPredictionSchema = createInsertSchema(predictionsTable);

export type Player = typeof playersTable.$inferSelect;
export type Match = typeof matchesTable.$inferSelect;
export type Room = typeof roomsTable.$inferSelect;
export type RoomPlayer = typeof roomPlayersTable.$inferSelect;
export type Prediction = typeof predictionsTable.$inferSelect;