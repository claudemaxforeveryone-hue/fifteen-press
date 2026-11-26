// Steps: the order a person places tiles, cut into single tiles and pairs. Shared by the live
// coach, the stage drills and the split clock.
import { methodsFor, chunks } from "./method.js";
import { decodeMoves, decodeTimes } from "./store.js";

const E = window.FifteenEngine;

export const METHODS = [
  { value: "rows", label: "Rows first", title: "Row 1, row 2, then the left columns as pairs, then the last three" },
  { value: "fringe", label: "Fringe", title: "A row, then a column, shrinking the board each time" },
  { value: "cols", label: "Columns first", title: "Column 1, column 2, then the top rows as pairs" },
];

// tile direction for each blank direction
export const TILE_WORD = ["down", "up", "right", "left"];
export const TILE_ARROW = ["↓", "↑", "→", "←"];

const plans = new Map();

function stepName(tiles) {
  if (tiles.length === 1) return `Place ${tiles[0]}`;
  if (tiles.length === 2) return `Place ${tiles[0]} and ${tiles[1]} as a pair`;
  return `Finish ${tiles.slice(0, -1).join(", ")} and ${tiles[tiles.length - 1]}`;
}

/** The plan for a board size: stages (rows, pairs, the last three) and the steps inside them. */
export function planFor(N, methodId = "rows") {
  const key = N + ":" + methodId;
  if (plans.has(key)) return plans.get(key);
  const all = methodsFor(N);
  const m = all[methodId] || all.rows;
  const stages = m.groups.map((g, k) => ({ index: k, name: g.name, kind: g.kind, tiles: g.tiles.slice() }));
  const steps = [];
  for (const st of stages)
    for (const c of chunks(st))
      steps.push({ index: steps.length, stage: st.index, stageName: st.name, kind: st.kind, tiles: c, name: stepName(c) });
  // cells that must stay put while a step is worked on
  const locks = [];
  const lk = new Uint8Array(N * N);
  for (const s of steps) {
    locks.push(lk.slice());
    for (const t of s.tiles) lk[t - 1] = 1;
  }
  const stageLocks = [];
  const sl = new Uint8Array(N * N);
  for (const st of stages) {
    stageLocks.push(sl.slice());
    for (const t of st.tiles) sl[t - 1] = 1;
  }
  const plan = { N, id: m.id, name: m.name, stages, steps, locks, stageLocks };
  plans.set(key, plan);
  return plan;
}

const home = (board, tiles) => {
  for (let i = 0; i < tiles.length; i++) if (board[tiles[i] - 1] !== tiles[i]) return false;
  return true;
};

/** First step that is not finished yet (steps.length when the board is solved). */
export function stepIndex(board, plan) {
  for (let i = 0; i < plan.steps.length; i++) if (!home(board, plan.steps[i].tiles)) return i;
  return plan.steps.length;
}

export function stageIndex(board, plan) {
  for (let i = 0; i < plan.stages.length; i++) if (!home(board, plan.stages[i].tiles)) return i;
  return plan.stages.length;
}

export const stageDone = (board, plan, k) => stageIndex(board, plan) > k;

/** Shortest way to finish step i from this board without touching what is already placed. */
export function lineFor(board, plan, i) {
  if (i >= plan.steps.length) return [];
  try {
    return E.placeGroup(board.slice(), plan.N, plan.steps[i].tiles, plan.locks[i]);
  } catch (e) {
    return null;
  }
}

/** A tile-by-tile line for a whole stage (what the stage drills compare you with). */
export function stageLine(board, plan, k) {
  const b = board.slice();
  const out = [];
  for (const s of plan.steps) {
    if (s.stage !== k) continue;
    try {
      out.push(...E.placeGroup(b, plan.N, s.tiles, plan.locks[s.index]));
    } catch (e) {
      return null;
    }
  }
  return out;
}

/** Cells a tile passes through while `moves` are played from `board`. */
export function routeOf(board, N, moves, tile) {
  const b = board.slice();
  const cells = [b.indexOf(tile)];
  for (const m of moves) {
    const blank = b.indexOf(0);
    const n = E.neighbor(blank, m, N);
    if (n < 0) break;
    if (b[n] === tile) cells.push(blank);
    b[blank] = b[n];
    b[n] = 0;
  }
  return cells;
}

/** Cells the gap passes through for the first `limit` moves. */
export function blankPath(board, N, moves, limit = 6) {
  const cells = [board.indexOf(0)];
  let at = cells[0];
  for (const m of moves.slice(0, limit)) {
    const n = E.neighbor(at, m, N);
    if (n < 0) break;
    cells.push(n);
    at = n;
  }
  return cells;
}

const spot = (cell, N) => (cell === N * N - 1 ? "the corner spot" : `the ${cell + 1} spot`);

/** "straight up 2" or "via the 7 spot": how a tile gets home, in words. */
export function describeRoute(cells, N) {
  if (cells.length < 2) return "";
  const dirOf = (a, b) => (b === a - N ? "up" : b === a + N ? "down" : b === a - 1 ? "left" : "right");
  const turns = [];
  let prev = dirOf(cells[0], cells[1]);
  for (let i = 2; i < cells.length; i++) {
    const d = dirOf(cells[i - 1], cells[i]);
    if (d !== prev) turns.push(cells[i - 1]);
    prev = d;
  }
  if (!turns.length) return `straight ${dirOf(cells[0], cells[1])}${cells.length > 2 ? " " + (cells.length - 1) : ""}`;
  const via = [...new Set(turns)].slice(0, 2).map((c) => spot(c, N));
  return "via " + via.join(" and ");
}

/* ---------- splits: when each stage locked for good ---------- */

const splitCache = new Map();

/** Time (ms) at which each stage of the plan was finished for good. Null when times are missing. */
export function splitsOf(solve, plan) {
  const key = solve.id + ":" + plan.id;
  if (splitCache.has(key)) return splitCache.get(key);
  let out = null;
  try {
    const N = solve.N;
    const moves = solve.movesArr || decodeMoves(solve.moves);
    const times = solve.timesArr || decodeTimes(solve.times);
    if (moves.length && times.length === moves.length && solve.start) {
      // walk backwards from solved: a tile's lock index is the first position it never leaves again
      const b = solve.start.slice();
      const M = moves.length;
      const lock = new Int32Array(N * N); // 0 = home from the start
      const homeNow = new Uint8Array(N * N);
      for (let c = 0; c < N * N; c++) homeNow[b[c]] = b[c] === c + 1 ? 1 : 0;
      for (let i = 0; i < M; i++) {
        const blank = b.indexOf(0);
        const n = E.neighbor(blank, moves[i], N);
        if (n < 0) break;
        const t = b[n];
        b[blank] = t;
        b[n] = 0;
        const isHome = blank === t - 1;
        if (isHome && !homeNow[t]) lock[t] = i + 1;
        homeNow[t] = isHome ? 1 : 0;
      }
      let prev = 0;
      out = plan.stages.map((st) => {
        let end = prev;
        for (const t of st.tiles) if (lock[t] > end) end = lock[t];
        prev = end;
        return end === 0 ? 0 : times[end - 1];
      });
      out[out.length - 1] = solve.duration;
    }
  } catch (e) {
    out = null;
  }
  splitCache.set(key, out);
  if (splitCache.size > 4000) splitCache.delete(splitCache.keys().next().value);
  return out;
}

/** Mean split per stage over a list of solves, plus how many solves went in. */
export function averageSplits(solves, plan) {
  const sums = new Array(plan.stages.length).fill(0);
  let n = 0;
  for (const s of solves) {
    const sp = splitsOf(s, plan);
    if (!sp) continue;
    n++;
    for (let i = 0; i < sums.length; i++) sums[i] += sp[i];
  }
  return n ? { n, at: sums.map((x) => x / n) } : null;
}

/** Stage lengths (not running totals) from running splits. */
export const legs = (at) => at.map((t, i) => t - (i ? at[i - 1] : 0));

/** A random solvable board where every stage before `k` is already home. */
export function stageScramble(plan, k, rnd = Math.random) {
  const N = plan.N;
  const lock = plan.stageLocks[Math.min(k, plan.stages.length - 1)];
  const free = [];
  for (let c = 0; c < N * N; c++) if (!lock[c]) free.push(c);
  const vals = free.map((c) => (c === N * N - 1 ? 0 : c + 1));
  for (let tries = 0; tries < 50; tries++) {
    for (let i = vals.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    const board = new Array(N * N);
    for (let c = 0; c < N * N; c++) board[c] = lock[c] ? c + 1 : 0;
    free.forEach((c, i) => (board[c] = vals[i]));
    if (!E.isSolvable(board, N)) {
      // swap two tiles (never the gap) to flip the parity
      const a = free.filter((c) => board[c] !== 0);
      if (a.length < 2) continue;
      [board[a[0]], board[a[1]]] = [board[a[1]], board[a[0]]];
    }
    if (!E.isSolvable(board, N)) continue;
    // the stage being drilled must not already be done
    if (stageIndex(board, plan) > k) continue;
    return board;
  }
  return E.scrambleFromSeed(E.randomSeed(8), N);
}
