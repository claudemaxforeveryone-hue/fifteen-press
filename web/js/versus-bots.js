// Engine opponents for 1v1. Each one is the app's own solver played back at a set pace,
// so it is always there to race, on any board size, with no connection at all.
import { run as engineRun } from "./engine-client.js";

const E = window.FifteenEngine;

// tps is turns per second on a tile by tile solution (about 82 moves on a 4x4).
// The top two play the shortest solution the solver can find in the countdown instead.
export const BOTS = [
  { id: "moth", name: "Moth", elo: 400, tps: 1.6 },
  { id: "wick", name: "Wick", elo: 600, tps: 2.4 },
  { id: "candle", name: "Candle", elo: 800, tps: 3.4 },
  { id: "lantern", name: "Lantern", elo: 1000, tps: 4.8 },
  { id: "hearth", name: "Hearth", elo: 1200, tps: 6.5 },
  { id: "kiln", name: "Kiln", elo: 1400, tps: 8.5 },
  { id: "forge", name: "Forge", elo: 1600, tps: 11 },
  { id: "furnace", name: "Furnace", elo: 1800, tps: 14 },
  { id: "comet", name: "Comet", elo: 2000, tps: 18 },
  { id: "nova", name: "Nova", elo: 2200, tps: 20, best: true },
  { id: "engine", name: "Full engine", elo: 2500, tps: 30, best: true },
];

// rough length of the line each kind of engine plays, for the "about 12 s" column
const TYPICAL = { 3: { staged: 22, best: 22 }, 4: { staged: 82, best: 53 }, 5: { staged: 186, best: 150 } };
// a 3x3 line is already the shortest there is, so the engines take it a little slower per move
const SIZE_PACE = { 3: 0.62, 4: 1, 5: 1 };

export function botById(id) {
  return BOTS.find((b) => b.id === id) || null;
}

export function nearestBot(elo) {
  let pick = BOTS[0];
  for (const b of BOTS) if (Math.abs(b.elo - elo) < Math.abs(pick.elo - elo)) pick = b;
  return pick;
}

export function typicalMs(bot, N) {
  const t = TYPICAL[N] || TYPICAL[4];
  return ((bot.best ? t.best : t.staged) / (bot.tps * (SIZE_PACE[N] || 1))) * 1000;
}

function staged(board, N) {
  return E.solveStaged(board.slice(), N, { useOptimalCore: false, timeLimit: 0 }).moves;
}

async function line(bot, board, N, budget) {
  if (!bot.best || N === 3) return N === 3 ? E.solve3(board.slice()) : staged(board, N);
  // the shortest line the solver finds before the countdown ends, or the tile by tile one
  try {
    const res = await Promise.race([
      engineRun("solve", { board: board.slice(), N, timeLimit: Math.max(300, budget - 500), coreTimeLimit: 600 }, { lane: "versus", replace: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), Math.max(400, budget - 150))),
    ]);
    if (res && Array.isArray(res.moves) && res.moves.length) return res.moves;
  } catch (e) {
    /* fall through to the tile by tile line */
  }
  return staged(board, N);
}

/**
 * The engine's whole race, decided before the board shows: which moves, and when each one lands.
 * Returns { moves, at, ms }: at[i] is the time in ms from "go" that move i is made, ms is the finish time.
 */
export async function planRace(bot, board, N, budget = 2500, rnd = Math.random) {
  const moves = await line(bot, board, N, budget);
  const n = moves.length;
  const day = 0.9 + rnd() * 0.24; // every race is a little faster or slower
  const total = (n / (bot.tps * (SIZE_PACE[N] || 1) * day)) * 1000;
  // uneven hands: most moves close to the beat, a look at the board now and then
  const w = new Array(n);
  let sum = 0;
  let nextLook = 5 + Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    let x = 0.6 + rnd() * 0.8;
    if (i === nextLook) {
      x += 1.2 + rnd() * 1.6;
      nextLook += 7 + Math.floor(rnd() * 10);
    }
    w[i] = x;
    sum += x;
  }
  const at = new Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += (w[i] / sum) * total;
    at[i] = t;
  }
  const ms = Math.max(1, Math.round(n ? at[n - 1] : 1));
  if (n) at[n - 1] = ms;
  return { moves, at, ms };
}

/** Plays a plan back against the clock. step(elapsed) returns the board at that moment and how far in it is. */
export class BotRun {
  constructor(plan, board, N) {
    this.plan = plan;
    this.N = N;
    this.board = board.slice();
    this.i = 0;
  }
  step(elapsed) {
    const { moves, at } = this.plan;
    let moved = false;
    while (this.i < moves.length && at[this.i] <= elapsed) {
      E.applyMove(this.board, this.N, moves[this.i]);
      this.i++;
      moved = true;
    }
    return { moved, moves: this.i, done: this.i >= moves.length };
  }
}
