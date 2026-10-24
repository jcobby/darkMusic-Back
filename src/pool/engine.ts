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
  potted: number[]; // in the order they dropped (0 = the cue ball)
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
      if (b.x < R) {
        b.x = R;
        b.vx = -b.vx * CUSHION_RESTITUTION;
      } else if (b.x > W - R) {
        b.x = W - R;
        b.vx = -b.vx * CUSHION_RESTITUTION;
      }
      if (b.y < R) {
        b.y = R;
        b.vy = -b.vy * CUSHION_RESTITUTION;
      } else if (b.y > H - R) {
        b.y = H - R;
        b.vy = -b.vy * CUSHION_RESTITUTION;
      }
    }
    // Ball on ball (in a fixed order, so it always plays out the same)
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
        if (firstContact === null && (a.id === 0 || b.id === 0)) firstContact = a.id === 0 ? b.id : a.id;
      }
    }
    onStep?.(balls, step);
    if (!moving) break;
  }
  return { balls: balls.map(({ id, x, y, potted: p }) => ({ id, x, y, potted: p })), firstContact, potted, steps: step + 1 };
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

/** Can the cue ball go here? On the table, clear of the other balls and the pockets — behind the head line on a break. */
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

  let foul: string | null = null;
  if (first === null) foul = "The cue ball didn't hit a ball";
  else if (scratch) foul = "The cue ball went in";
  else if (!before.breakShot) {
    if (myGroup === null) {
      if (first === 8) foul = "Hit the 8 first";
    } else if (onEight) {
      if (first !== 8) foul = "Had to hit the 8 first";
    } else if (groupOf(first) !== myGroup) {
      foul = `Hit ${myGroup === "solids" ? "a stripe" : "a solid"} first`;
    }
  }

  const frame: Frame = { ...before, balls, groups: [...before.groups] as Frame["groups"], breakShot: false, ballInHand: false };
  const outcome: Outcome = { foul, potted: pottedBalls, keepsTurn: false, assigned: null, frameWinner: null, frameReason: null };

  // The 8
  if (pottedBalls.includes(8)) {
    if (before.breakShot) {
      respotEight(frame.balls);
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

  // Carry on after potting one of yours (any ball on the break or an open table)
  const pottedAny = pottedBalls.some((id) => id !== 8);
  const pottedMine = pottedBalls.some((id) => groupOf(id) === myGroup);
  outcome.keepsTurn = !foul && (before.breakShot || myGroup === null ? pottedAny : pottedMine);

  if (foul) {
    frame.turn = them;
    frame.ballInHand = true;
    if (scratch) {
      const cue = frame.balls.find((b) => b.id === 0)!;
      cue.potted = false; // back in hand
      cue.x = HEAD_X;
      cue.y = H / 2;
    }
  } else if (!outcome.keepsTurn) {
    frame.turn = them;
  }
  return { frame, outcome };
}

/** A player ran out of time: the turn passes and the opponent has ball in hand (or breaks instead, if it was the break). */
export function timeOut(before: Frame): Frame {
  return { ...before, turn: before.turn === 0 ? 1 : 0, ballInHand: true };
}
