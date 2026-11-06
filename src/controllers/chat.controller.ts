import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { User } from "../models/User";
import { PoolMatch } from "../models/PoolMatch";
import { GameEvent } from "../models/GameEvent";
import { ChatMessage } from "../models/ChatMessage";
import { bidderName } from "./auction.controller";

/**
 * Chat during game challenges. Two kinds of room:
 *  - "pool-<code>": a DMY Pool match — only its two players read and write (also after it ends, for the GG).
 *  - "event-<slug>": a live event — anyone reads; signed-in members write from an hour before it
 *    starts until an hour after it ends. DMY can hide messages.
 * No links (spam and scams), 200 characters, a moment between messages.
 */
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const MAX_LEN = 200;
const GAP_MS = 1200;
const EVENT_OPEN_MS = 3600e3; // the event room takes messages from an hour before to an hour after
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|gh|io|me|ly|co|xyz|link|site|app)\b)/i;

type Room = { kind: "pool"; code: string; canWrite: boolean } | { kind: "event"; slug: string; canWrite: boolean };

/** Who may read and write in a room (throws if they can't read it). */
async function roomFor(room: string, userId?: string): Promise<Room> {
  const pool = room.match(/^pool-([A-Z0-9]{4,12})$/i);
  if (pool) {
    const m = await PoolMatch.findOne({ code: pool[1].toUpperCase() }).select("players status").lean();
    if (!m) throw httpError(404, "That match doesn't exist");
    const isPlayer = Boolean(userId) && m.players.some((p) => String(p.user) === userId);
    if (!isPlayer) throw httpError(403, "Only the two players can chat in a match");
    return { kind: "pool", code: pool[1].toUpperCase(), canWrite: m.status === "playing" || m.status === "finished" };
  }
  const ev = room.match(/^event-([a-z0-9-]{1,80})$/);
  if (ev) {
    const e = await GameEvent.findOne({ slug: ev[1] }).select("startsAt endsAt cancelled").lean();
    if (!e || e.cancelled) throw httpError(404, "That event doesn't exist");
    const now = Date.now();
    const open = now >= e.startsAt.getTime() - EVENT_OPEN_MS && now <= e.endsAt.getTime() + EVENT_OPEN_MS;
    return { kind: "event", slug: ev[1], canWrite: Boolean(userId) && open };
  }
  throw httpError(404, "No such chat");
}

const view = (m: { _id: unknown; user: unknown; name: string; text: string; at: Date }, userId?: string) => ({
  id: String(m._id),
  name: m.name,
  text: m.text,
  at: m.at,
  mine: Boolean(userId) && String(m.user) === userId,
});

/** GET /api/chat/:room?after=<ISO time> — the newest messages (or only ones after `after`). */
export async function chatMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.fan?.id ? String(req.fan.id) : undefined;
    const room = String(req.params.room);
    const r = await roomFor(room, userId);
    const after = typeof req.query.after === "string" && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after) : null;
    const rows = await ChatMessage.find({ room, hidden: { $ne: true }, ...(after ? { at: { $gt: after } } : {}) })
      .sort({ at: -1 })
      .limit(60)
      .lean();
    res.json({ canWrite: r.canWrite, messages: rows.reverse().map((m) => view(m, userId)), now: new Date() });
  } catch (err) {
    next(err);
  }
}

const lastSent = new Map<string, number>(); // user → when they last wrote (anywhere)

/** POST /api/chat/:room { text } */
export async function chatSend(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    const room = String(req.params.room);
    const r = await roomFor(room, userId);
    if (!r.canWrite) throw httpError(403, r.kind === "event" ? "The chat opens an hour before the event starts" : "The chat isn't open");
    const text = String(req.body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
    if (!text) throw httpError(400, "Type a message");
    if (LINK.test(text)) throw httpError(400, "No links in the chat, please");
    if (Date.now() - (lastSent.get(userId) ?? 0) < GAP_MS) throw httpError(429, "Slow down a little");
    lastSent.set(userId, Date.now());
    if (lastSent.size > 20_000) lastSent.clear();
    const u = await User.findById(userId).select("name").lean();
    const m = await ChatMessage.create({ room, user: userId, name: bidderName(u?.name), text, at: new Date() });
    res.status(201).json(view(m, userId));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/chat/:id — hide a message (event chats). */
export async function adminHideChat(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    await ChatMessage.updateOne({ _id: req.params.id }, { $set: { hidden: true } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
