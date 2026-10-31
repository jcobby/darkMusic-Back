/*
 * DMY Pool — the 8-ball engine: table, physics and rules. The server runs every shot
 * through it (it decides what happened); the game runs the same shot to animate it.
 *
 * KEEP THIS FILE IDENTICAL to frontend/src/lib/pool/engine.ts — copy it across after
 * any change. Only plain arithmetic and Math.sqrt are used, so the same shot from the
 * same position plays out the same in Node and in every browser.
 */

// ---------- The table (logical units; the long side is x) ----------

export const W = 1000;
export const H = 500;
export const R = 11.5; // ball radius
const CORNER_POCKET = 27; // capture radius around each pocket point
const SIDE_POCKET = 23;
export const POCKETS: { x: number; y: number; r: number }[] = [
  { x: 0, y: 0, r: CORNER_POCKET },
  { x: W / 2, y: -4, r: SIDE_POCKET },
  { x: W, y: 0, r: CORNER_POCKET },
  { x: 0, y: H, r: CORNER_POCKET },
  { x: W / 2, y: H + 4, r: SIDE_POCKET },
  { x: W, y: H, r: CORNER_POCKET },
];
export const HEAD_X = W / 4; // the break is played from behind this line
export const FOOT = { x: W * 0.75, y: H / 2 }; // the rack's apex, and where the 8 is re-spotted

// ---------- Physics ----------

export const MAX_SPEED = 2100; // units/s at full power
const FRICTION = 170; // rolling slow-down, units/s²
const STOP_SPEED = 5;
const BALL_RESTITUTION = 1; // balls lose nothing to each other (the cushions and the cloth take it)
const CUSHION_RESTITUTION = 0.8;
export const STEP = 1 / 240; // seconds per simulation step
const MAX_STEPS = 240 * 25; // nothing rolls for longer than this

export interface BallState {
  id: number; // 0 = cue ball, 1–7 solids, 8, 9–15 stripes
  x: number;
  y: number;
  potted: boolean;
}
interface Moving extends BallState {
  vx: number;
  vy: number;
}

/** What one shot did. */
export interface SimResult {
  balls: BallState[]; // where everything ended up
  firstContact: number | null; // the first ball the cue ball touched
  firstContacts: number[]; // every ball it touched at that same first moment (two = a split hit)
  cueLeftKitchen: boolean; // the cue ball was past the head line before it touched a ball
  potted: number[]; // in the order they dropped (0 = the cue ball)
  railAfterContact: boolean; // some ball hit a cushion after the cue ball's first contact
  steps: number;
}

export interface Shot {
  dx: number; // aim direction (any length)
  dy: number;
  power: number; // 0–1
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Play a shot out from the given position. `onStep` (the game's animation) sees the
 * balls after every step.
 */
export function simulate(start: BallState[], shot: Shot, onStep?: (balls: readonly BallState[], step: number) => void): SimResult {
  const balls: Moving[] = start.map((b) => ({ ...b, vx: 0, vy: 0 }));
  const cue = balls.find((b) => b.id === 0 && !b.potted);
  const potted: number[] = [];
  let firstContact: number | null = null;
  const firstContacts: number[] = [];
  let cueLeftKitchen = false;
  let railAfterContact = false;
  if (cue) {
    const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    const speed = clamp(shot.power, 0, 1) * MAX_SPEED;
    cue.vx = (shot.dx / len) * speed;
    cue.vy = (shot.dy / len) * speed;
  }
  const slow = FRICTION * STEP;
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    let moving = false;
    // Move and slow down
    for (const b of balls) {
      if (b.potted || (b.vx === 0 && b.vy === 0)) continue;
      b.x += b.vx * STEP;
      b.y += b.vy * STEP;
      if (b.id === 0 && firstContact === null && b.x > HEAD_X) cueLeftKitchen = true;
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const nv = v - slow;
      if (nv <= STOP_SPEED) {
        b.vx = 0;
        b.vy = 0;
      } else {
        b.vx = (b.vx / v) * nv;
        b.vy = (b.vy / v) * nv;
        moving = true;
      }
    }
    // Pockets, then cushions
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx * dx + dy * dy <= p.r * p.r) {
          b.potted = true;
          b.vx = 0;
          b.vy = 0;
          potted.push(b.id);
          break;
        }
      }
      if (b.potted) continue;
      let cushion = true;
      if (b.x < R) {
        b.x = R;
        b.vx = -b.vx * CUSHION_RESTITUTION;
      } else if (b.x > W - R) {
        b.x = W - R;
        b.vx = -b.vx * CUSHION_RESTITUTION;
      } else cushion = false;
      if (b.y < R) {
        b.y = R;
        b.vy = -b.vy * CUSHION_RESTITUTION;
        cushion = true;
      } else if (b.y > H - R) {
        b.y = H - R;
        b.vy = -b.vy * CUSHION_RESTITUTION;
        cushion = true;
      }
      if (cushion && firstContact !== null) railAfterContact = true;
    }
    // Ball on ball (in a fixed order, so it always plays out the same)
    const lookingForFirst = firstContact === null;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.potted) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 4 * R * R || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        // Push them apart, then swap the speed along the line between them
        const overlap = (2 * R - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel > 0) {
          const k = (rel * (1 + BALL_RESTITUTION)) / 2;
          a.vx -= k * nx;
          a.vy -= k * ny;
          b.vx += k * nx;
          b.vy += k * ny;
          moving = true;
        }
        if (lookingForFirst && (a.id === 0 || b.id === 0)) firstContacts.push(a.id === 0 ? b.id : a.id);
      }
    }
    if (lookingForFirst && firstContacts.length) firstContact = firstContacts[0];
    onStep?.(balls, step);
    if (!moving) break;
  }
  return {
    balls: balls.map(({ id, x, y, potted: p }) => ({ id, x, y, potted: p })),
    firstContact,
    firstContacts,
    cueLeftKitchen,
    potted,
    railAfterContact,
    steps: step + 1,
  };
}

// ---------- The rack ----------

/**
 * A fresh rack: the 8 in the middle of the third row, a solid and a stripe in the back
 * corners, the rest in the given order (the server shuffles it), the cue ball behind
 * the head line.
 */
export function rack(order: number[]): BallState[] {
  const rest = order.filter((id) => id !== 8 && id !== 1 && id !== 9);
  // Row by row from the apex: 1, 2, 3, 4, 5 balls
  const slots: number[] = [];
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      if (row === 2 && i === 1) slots.push(8);
      else if (row === 4 && i === 0) slots.push(1);
      else if (row === 4 && i === 4) slots.push(9);
      else slots.push(rest[k++]);
    }
  }
  // A real rack is never perfectly tight — small, fixed gaps let the break spread the balls
  // (a perfectly packed one passes it all down the line, like a Newton's cradle).
  const gap = 2 * R + 0.8;
  const dxRow = gap * 0.8660254037844386; // √3/2
  const balls: BallState[] = [{ id: 0, x: HEAD_X, y: H / 2, potted: false }];
  let n = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const wobble = (((n * 7) % 5) - 2) * 0.1;
      balls.push({ id: slots[n++], x: FOOT.x + row * dxRow + wobble, y: H / 2 + (i - row / 2) * gap - wobble, potted: false });
    }
  }
  return balls;
}

// ---------- Placing the cue ball (ball in hand) ----------

/** Can the cue ball go here? On the table, clear of the other balls and the pockets — behind the head line on a break (or after a scratch on it). */
export function canPlaceCue(balls: BallState[], x: number, y: number, behindHeadLine: boolean): boolean {
  if (!(x >= R && x <= W - R && y >= R && y <= H - R)) return false;
  if (behindHeadLine && x > HEAD_X) return false;
  for (const p of POCKETS) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= (p.r + R) * (p.r + R)) return false;
  }
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy < 4 * R * R) return false;
  }
  return true;
}

/**
 * Somewhere free for the cue ball: the head spot if it's clear (just behind the head
 * line if it has to be behind it), otherwise the nearest clear spot to it.
 */
export function freeCueSpot(balls: BallState[], behindHeadLine: boolean): { x: number; y: number } {
  const sx = behindHeadLine ? HEAD_X * 0.8 : HEAD_X;
  const sy = H / 2;
  for (let ring = 0; ring <= 60; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        if (canPlaceCue(balls, sx + i * R, sy + j * R, behindHeadLine)) return { x: sx + i * R, y: sy + j * R };
      }
    }
  }
  return { x: sx, y: sy };
}

/** Put the 8 back on the foot spot (or the nearest free spot towards the foot cushion). */
function respotEight(balls: BallState[]) {
  const eight = balls.find((b) => b.id === 8)!;
  for (let x = FOOT.x; x <= W - R; x += R) {
    const clear = balls.every((b) => b.id === 8 || b.potted || (b.x - x) * (b.x - x) + (b.y - FOOT.y) * (b.y - FOOT.y) >= 4 * R * R);
    if (clear) {
      eight.x = x;
      eight.y = FOOT.y;
      eight.potted = false;
      return;
    }
  }
  eight.x = FOOT.x;
  eight.y = FOOT.y;
  eight.potted = false;
}

// ---------- 8-ball rules ----------

export type Group = "solids" | "stripes";
export const groupOf = (id: number): Group | null => (id >= 1 && id <= 7 ? "solids" : id >= 9 && id <= 15 ? "stripes" : null);
const other = (g: Group): Group => (g === "solids" ? "stripes" : "solids");

/** One frame (rack) in progress. */
export interface Frame {
  balls: BallState[];
  turn: 0 | 1; // whose shot
  groups: [Group | null, Group | null]; // decided by the first legal pot after the break
  ballInHand: boolean; // the shooter places the cue ball first
  breakShot: boolean; // the next shot is the break (cue ball from behind the head line)
  // After the cue ball went in: ball in hand behind the head line, and a ball that's
  // behind the line can't be hit first unless the cue ball crosses the line before it
  kitchen?: boolean;
  // The other player fouled, so the shooter has two shots: a miss with the first one doesn't
  // end the turn, it uses up the spare. Potting carries on as usual and keeps the spare.
  twoShots?: boolean;
  winner: 0 | 1 | null;
}

export function newFrame(order: number[], breaker: 0 | 1): Frame {
  return { balls: rack(order), turn: breaker, groups: [null, null], ballInHand: true, breakShot: true, winner: null };
}

/** The balls a player still has to pot before the 8. */
export const ballsLeft = (f: Frame, player: 0 | 1) => {
  const g = f.groups[player];
  return g ? f.balls.filter((b) => !b.potted && groupOf(b.id) === g).length : null;
};

export interface Outcome {
  foul: string | null; // why it was a foul, if it was
  potted: number[];
  keepsTurn: boolean;
  assigned: Group | null; // the shooter's group, if this shot decided it
  respotted?: boolean; // the 8 went in on the break and was put back on its spot
  rebreak?: boolean; // the break missed every ball: the other player breaks instead
  kitchen?: boolean; // the cue ball went in: the other player has it in hand behind the head line
  twoShots?: boolean; // a foul: the other player gets two shots
  secondShot?: boolean; // a miss with the first of two shots: the shooter plays again
  frameWinner: 0 | 1 | null;
  frameReason: string | null;
}

/**
 * Apply the rules to a played shot. `before` is the frame as the shot was taken
 * (after any cue-ball placement); `sim` is what the shot did.
 */
export function judge(before: Frame, sim: SimResult): { frame: Frame; outcome: Outcome } {
  const me = before.turn;
  const them: 0 | 1 = me === 0 ? 1 : 0;
  const myGroup = before.groups[me];
  const onEight = myGroup !== null && ballsLeft(before, me) === 0;
  const balls = sim.balls.map((b) => ({ ...b }));
  const pottedBalls = sim.potted.filter((id) => id !== 0);
  const scratch = sim.potted.includes(0);
  const first = sim.firstContact;
  // Touching two balls at the same instant (a split) is fine if either of them was a legal one to hit
  const hits = sim.firstContacts?.length ? sim.firstContacts : first === null ? [] : [first];
  const startX = (id: number) => before.balls.find((b) => b.id === id)?.x ?? W;

  let foul: string | null = null;
  if (first === null) foul = "The cue ball didn't hit a ball";
  else if (scratch) foul = "The cue ball went in";
  else if (!before.breakShot) {
    if (before.kitchen && !sim.cueLeftKitchen && hits.every((id) => startX(id) <= HEAD_X)) {
      foul = "Hit a ball behind the line without crossing it first";
    } else if (myGroup === null) {
      if (hits.every((id) => id === 8)) foul = "Hit the 8 first";
    } else if (onEight) {
      if (!hits.includes(8)) foul = "Had to hit the 8 first";
    } else if (!hits.some((id) => groupOf(id) === myGroup)) {
      foul = `Hit ${hits.includes(8) ? "the 8" : myGroup === "solids" ? "a stripe" : "a solid"} first`;
    }
    // After the hit, a ball has to go in or some ball has to reach a cushion (no gentle nudges for safety)
    if (!foul && pottedBalls.length === 0 && !sim.railAfterContact) foul = "No ball hit a cushion after the hit";
  }

  // A break that misses every ball: nothing moved but the cue ball, so the other player breaks instead
  if (before.breakShot && first === null) {
    const cue = balls.find((b) => b.id === 0)!;
    if (cue.potted || cue.x > HEAD_X) Object.assign(cue, freeCueSpot(balls, true), { potted: false });
    return {
      frame: { ...before, balls, turn: them, ballInHand: true, breakShot: true, kitchen: false, twoShots: false },
      outcome: { foul, potted: [], keepsTurn: false, assigned: null, rebreak: true, frameWinner: null, frameReason: null },
    };
  }

  const frame: Frame = { ...before, balls, groups: [...before.groups] as Frame["groups"], breakShot: false, ballInHand: false, kitchen: false, twoShots: false };
  const outcome: Outcome = { foul, potted: pottedBalls, keepsTurn: false, assigned: null, frameWinner: null, frameReason: null };

  // The 8
  if (pottedBalls.includes(8)) {
    if (before.breakShot) {
      respotEight(frame.balls);
      outcome.respotted = true;
    } else {
      const won = onEight && !foul;
      frame.winner = won ? me : them;
      outcome.frameWinner = frame.winner;
      outcome.frameReason = won ? "Potted the 8" : onEight ? `Potted the 8 on a foul — ${foul?.toLowerCase()}` : "Potted the 8 too early";
      return { frame, outcome };
    }
  }

  // Groups: decided by the first ball potted on a legal shot once the break is over
  if (!foul && myGroup === null && !before.breakShot) {
    const firstGroup = pottedBalls.map(groupOf).find((g): g is Group => g !== null);
    if (firstGroup) {
      frame.groups[me] = firstGroup;
      frame.groups[them] = other(firstGroup);
      outcome.assigned = firstGroup;
    }
  }

  // Carry on after potting one of yours (any ball on an open table; on the break, any ball — the 8 included, as it's re-spotted)
  const pottedAny = pottedBalls.some((id) => id !== 8);
  const pottedMine = pottedBalls.some((id) => groupOf(id) === myGroup);
  outcome.keepsTurn = !foul && (before.breakShot ? pottedBalls.length > 0 : myGroup === null ? pottedAny : pottedMine);

  if (foul) {
    // Two shots for the other player, from where the cue ball stopped — or, if it went in,
    // with it in hand behind the head line
    frame.turn = them;
    frame.twoShots = true;
    outcome.twoShots = true;
    if (scratch) {
      frame.ballInHand = true;
      frame.kitchen = true;
      outcome.kitchen = true;
      const cue = frame.balls.find((b) => b.id === 0)!;
      Object.assign(cue, freeCueSpot(frame.balls, true), { potted: false }); // back in hand, somewhere free
    }
  } else if (outcome.keepsTurn) {
    frame.twoShots = before.twoShots === true;
  } else if (before.twoShots) {
    outcome.secondShot = true; // the spare shot: same player again, from where the cue ball stopped
  } else {
    frame.turn = them;
  }
  return { frame, outcome };
}

/**
 * A player ran out of time: like a foul, the opponent gets two shots, from where the cue
 * ball is (in hand behind the line if it was in hand). On the break, they break instead.
 */
export function timeOut(before: Frame): Frame {
  return { ...before, turn: before.turn === 0 ? 1 : 0, twoShots: !before.breakShot };
}
