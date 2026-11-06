/*
 * DMY Pool — the 8-ball engine: table, physics and rules. The server runs every shot
 * through it (it decides what happened); the game runs the same shot to animate it.
 *
 * KEEP THIS FILE IDENTICAL to frontend/src/lib/pool/engine.ts — copy it across after
 * any change. Only plain arithmetic and Math.sqrt are used, so the same shot (aim, power
 * and spin) from the same position plays out the same in Node and in every browser.
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
/*
 * Each ball has a velocity and a spin. The spin is kept as the speed its underside "wants"
 * to roll at (w) plus its side spin (s, about the upright axis). While the ball's underside
 * slips on the cloth (v ≠ w) the cloth's friction pulls the two together — that's how a
 * draw shot comes back after the hit and a follow shot carries on — and once they match,
 * it rolls and slows gently. Side spin doesn't bend a ball on the cloth; it grips the
 * cushions, changing the angle a ball comes off at. Balls hitting each other swap the
 * speed along the line between them and keep their spin.
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const MAX_SPEED = 2100; // units/s at full power, before the top-end boost
/** Power → speed: steady through the middle, with extra at the top for breaks and power shots (×1.5 at 100%). */
export const shotSpeed = (power: number) => {
  const p = clamp(power, 0, 1);
  return p * (1 + 0.5 * p * p) * MAX_SPEED;
};
const SLIDE_FRICTION = 700; // the cloth's grip while a ball slides (≈ 0.18 g), units/s²
const ROLL_FRICTION = 100; // slowing down once it rolls, units/s²
const SIDE_FRICTION = 450; // side spin wearing off, units/s²
const STOP_SPEED = 5;
const BALL_RESTITUTION = 1; // balls lose nothing to each other (the cushions and the cloth take it)
const CUSHION_RESTITUTION = 0.8;
const CUSHION_GRIP = 0.2; // friction between a spinning ball and the cushion
/** Spin from the cue: the tip can hit up to half the ball's radius off centre (5/2 × ½). A centre hit has none. */
export const SPIN = 1.25;
export const STEP = 1 / 240; // seconds per simulation step
const MAX_STEPS = 240 * 30; // nothing rolls for longer than this

export interface BallState {
  id: number; // 0 = cue ball, 1–7 solids, 8, 9–15 stripes
  x: number;
  y: number;
  potted: boolean;
}
interface Moving extends BallState {
  vx: number;
  vy: number;
  wx: number; // roll spin, as the speed the ball's underside wants to go at
  wy: number;
  s: number; // side spin: the speed its equator turns at (one way or the other)
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
  /**
   * Where the tip hits the cue ball, as seen by the shooter: x −1 (left) … 1 (right) for side
   * spin, y −1 (low: draw/backspin) … 1 (high: follow/topspin). (0, 0) is the centre. Kept
   * inside the circle of radius 1.
   */
  spin?: { x: number; y: number };
}


/** The spin point, kept inside the ball (radius 1). */
export function spinOf(shot: Shot): { x: number; y: number } {
  const x = Number.isFinite(shot.spin?.x) ? shot.spin!.x : 0;
  const y = Number.isFinite(shot.spin?.y) ? shot.spin!.y : 0;
  const l = Math.sqrt(x * x + y * y);
  return l > 1 ? { x: x / l, y: y / l } : { x, y };
}

/** A ball comes off a cushion. (nx, ny): the way from the ball into the cushion. */
function bounce(b: Moving, nx: number, ny: number) {
  const vn = b.vx * nx + b.vy * ny;
  if (vn <= 0) return; // already on its way out
  const push = (1 + CUSHION_RESTITUTION) * vn;
  b.vx -= push * nx;
  b.vy -= push * ny;
  // Side spin grips the cushion and pushes the ball along it (a ball's roll doesn't: the
  // cushion meets it at its equator). The faster it hits, the more grip — up to stopping the spin.
  if (b.s !== 0) {
    const tx = -ny;
    const ty = nx;
    const lim = CUSHION_GRIP * push;
    const j = clamp((-2 / 7) * b.s, -lim, lim);
    b.vx += j * tx;
    b.vy += j * ty;
    b.s += 2.5 * j;
  }
  // It comes off rolling the new way (what the cushion does to its roll)
  const wn = b.wx * nx + b.wy * ny;
  const vn2 = b.vx * nx + b.vy * ny;
  b.wx += (vn2 - wn) * nx;
  b.wy += (vn2 - wn) * ny;
}

/**
 * Play a shot out from the given position. `onStep` (the game's animation) sees the
 * balls after every step.
 */
export function simulate(start: BallState[], shot: Shot, onStep?: (balls: readonly BallState[], step: number) => void): SimResult {
  const balls: Moving[] = start.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, s: 0 }));
  const cue = balls.find((b) => b.id === 0 && !b.potted);
  const potted: number[] = [];
  let firstContact: number | null = null;
  const firstContacts: number[] = [];
  let cueLeftKitchen = false;
  let railAfterContact = false;
  if (cue) {
    const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    const ux = shot.dx / len;
    const uy = shot.dy / len;
    const speed = shotSpeed(shot.power);
    const sp = spinOf(shot);
    cue.vx = ux * speed;
    cue.vy = uy * speed;
    // High on the ball: it wants to roll faster than it goes (follow); low: backwards (draw)
    cue.wx = ux * speed * SPIN * sp.y;
    cue.wy = uy * speed * SPIN * sp.y;
    // Right of centre: the ball's front turns to the shooter's left, so it comes off a cushion to the right
    cue.s = -speed * SPIN * sp.x;
  }
  const slide = SLIDE_FRICTION * STEP;
  const roll = ROLL_FRICTION * STEP;
  const side = SIDE_FRICTION * STEP;
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    let moving = false;
    // Move, and the cloth works on each ball
    for (const b of balls) {
      if (b.potted) continue;
      if (b.vx === 0 && b.vy === 0 && b.wx === 0 && b.wy === 0) {
        b.s = 0;
        continue;
      }
      b.x += b.vx * STEP;
      b.y += b.vy * STEP;
      if (b.id === 0 && firstContact === null && b.x > HEAD_X) cueLeftKitchen = true;
      const ux = b.vx - b.wx;
      const uy = b.vy - b.wy;
      const slip = Math.sqrt(ux * ux + uy * uy);
      if (slip > 1) {
        // Sliding: friction against the slip slows (or speeds) the ball and turns its spin
        // towards rolling; the slip closes 3.5 times as fast as the speed changes
        const need = slip / 3.5;
        const k = (slide < need ? slide : need) / slip;
        b.vx -= ux * k;
        b.vy -= uy * k;
        b.wx += 2.5 * ux * k;
        b.wy += 2.5 * uy * k;
        if (slide >= need) {
          b.wx = b.vx;
          b.wy = b.vy;
        }
        const v2 = b.vx * b.vx + b.vy * b.vy;
        const w2 = b.wx * b.wx + b.wy * b.wy;
        if (v2 < STOP_SPEED * STOP_SPEED && w2 < STOP_SPEED * STOP_SPEED) {
          b.vx = b.vy = b.wx = b.wy = 0;
        }
      } else {
        // Rolling
        const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        const nv = v - roll;
        if (nv <= STOP_SPEED) {
          b.vx = b.vy = b.wx = b.wy = 0;
        } else {
          b.vx = (b.vx / v) * nv;
          b.vy = (b.vy / v) * nv;
          b.wx = b.vx;
          b.wy = b.vy;
        }
      }
      if (b.s !== 0) b.s = b.s > side ? b.s - side : b.s < -side ? b.s + side : 0;
      if (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0) moving = true;
    }
    // Pockets, then cushions
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx * dx + dy * dy <= p.r * p.r) {
          b.potted = true;
          b.vx = b.vy = b.wx = b.wy = b.s = 0;
          potted.push(b.id);
          break;
        }
      }
      if (b.potted) continue;
      let cushion = true;
      if (b.x < R) {
        b.x = R;
        bounce(b, -1, 0);
      } else if (b.x > W - R) {
        b.x = W - R;
        bounce(b, 1, 0);
      } else cushion = false;
      if (b.y < R) {
        b.y = R;
        bounce(b, 0, -1);
        cushion = true;
      } else if (b.y > H - R) {
        b.y = H - R;
        bounce(b, 0, 1);
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
        // Push them apart, then swap the speed along the line between them (their spin stays)
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
