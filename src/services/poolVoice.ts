import crypto from "crypto";
import { env } from "../config/env";

/**
 * Live voice between the two players of a DMY Pool match. The sound goes straight between
 * their phones (WebRTC); the server only passes the connection details. Player 1 (index 0)
 * always makes the offer and player 2 answers, so they never call each other at once.
 *
 * Kept in memory: a call is short-lived, and a restart just means pressing Join again.
 */
interface VoiceState {
  joined: [boolean, boolean];
  seen: [number, number]; // when each player's page last checked in — gone quiet for 15 s counts as left
  offer: { id: string; sdp: string } | null;
  answer: { id: string; sdp: string } | null; // id = the offer it answers
  at: number;
}
const calls = new Map<string, VoiceState>();
const STALE_MS = 3 * 3600e3;

function stateOf(code: string): VoiceState {
  const now = Date.now();
  for (const [k, v] of calls) if (now - v.at > STALE_MS) calls.delete(k);
  let s = calls.get(code);
  if (!s) {
    s = { joined: [false, false], seen: [0, 0], offer: null, answer: null, at: now };
    calls.set(code, s);
  }
  return s;
}

/** STUN finds a direct route; a TURN relay (TURN_URLS etc.) gets through networks that block it. */
export function iceServers() {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (env.turn.urls.length) servers.push({ urls: env.turn.urls, username: env.turn.username, credential: env.turn.credential });
  return servers;
}

const QUIET_MS = 15_000;
/** What one player needs to know: are they / is the other on voice, and the offer or answer meant for them. */
export function voiceView(code: string, me: 0 | 1) {
  const s = stateOf(code);
  const them = (1 - me) as 0 | 1;
  s.seen[me] = Date.now();
  // Their page closed without saying goodbye: they've left
  if (s.joined[them] && Date.now() - s.seen[them] > QUIET_MS) {
    s.joined[them] = false;
    s.offer = null;
    s.answer = null;
  }
  return {
    role: me === 0 ? ("offer" as const) : ("answer" as const),
    me: { joined: s.joined[me] },
    them: { joined: s.joined[them] },
    offer: me === 1 ? s.offer : null,
    answer: me === 0 ? s.answer : null,
    myOffer: me === 0 ? (s.offer?.id ?? null) : null, // gone (someone re-joined) → player 1 makes a new one

    iceServers: iceServers(),
  };
}

export type VoiceAction = { action: "join" | "leave" } | { action: "offer"; sdp: string } | { action: "answer"; sdp: string; id: string };

/** A player joins or leaves voice, or sends their side of the connection. Joining or leaving starts a fresh connection. */
export function voiceAct(code: string, me: 0 | 1, a: VoiceAction): string | null {
  const s = stateOf(code);
  s.at = Date.now();
  if (a.action === "offer") {
    if (me !== 0) return "Only player 1 makes the call";
    if (a.sdp.length > 20_000) return "That's too big";
    s.offer = { id: crypto.randomBytes(6).toString("hex"), sdp: a.sdp };
    s.answer = null;
    return null;
  }
  if (a.action === "answer") {
    if (me !== 1) return "Only player 2 answers";
    if (a.sdp.length > 20_000) return "That's too big";
    if (!s.offer || s.offer.id !== a.id) return "That call has changed — try again";
    s.answer = { id: a.id, sdp: a.sdp };
    return null;
  }
  s.joined[me] = a.action === "join";
  s.seen[me] = Date.now();
  s.offer = null;
  s.answer = null;
  return null;
}
