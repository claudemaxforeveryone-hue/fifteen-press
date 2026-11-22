// Every number a solve carries, in one list. The Solves view sorts and shades by these and the
// All stats table summarises each one.
import { deepOf } from "./deep.js";
import { fmtTime, rarity } from "./stats.js";
import { planFor, splitsOf, legs, stageLine } from "./steps.js";

const E = window.FifteenEngine;

const n0 = (x) => (x == null || !isFinite(x) ? "-" : String(Math.round(x)));
const n1 = (x) => (x == null || !isFinite(x) ? "-" : x.toFixed(1));
const n2 = (x) => (x == null || !isFinite(x) ? "-" : x.toFixed(2));
const pc = (x) => (x == null || !isFinite(x) ? "-" : Math.round(x * 100) + "%");
const ms = (x) => (x == null || !isFinite(x) ? "-" : Math.round(x) + " ms");
const tm = (x) => (x == null || !isFinite(x) ? "-" : fmtTime(x));

/** Sum of how far every tile sits from home: a quick difficulty read for any board size. */
export function manhattan(board, N) {
  let d = 0;
  for (let c = 0; c < board.length; c++) {
    const t = board[c];
    if (!t) continue;
    d += Math.abs(Math.floor(c / N) - Math.floor((t - 1) / N)) + Math.abs((c % N) - ((t - 1) % N));
  }
  return d;
}

const hard = new Map();
/** How hard the scramble was: its shortest solution when known, else the tile distance. */
export function difficulty(solve) {
  if (solve.optimal != null) return solve.optimal;
  if (hard.has(solve.id)) return hard.get(solve.id);
  const d = solve.start ? manhattan(solve.start, solve.N) : null;
  hard.set(solve.id, d);
  return d;
}

/** Share of all positions that are easier than this scramble (3x3 and 4x4 only). */
export function easierThan(solve) {
  if (solve.optimal == null) return null;
  const r = rarity(solve.N, solve.optimal);
  return r.harderThan ?? null;
}

const lineCache = new Map();
/** Moves a tile-by-tile solve of this scramble takes with the given order. */
export function methodLine(solve, methodId = "rows") {
  if (!solve.start || solve.N > 5) return null;
  const key = solve.id + ":" + methodId;
  if (lineCache.has(key)) return lineCache.get(key);
  let total = null;
  try {
    const plan = planFor(solve.N, methodId);
    const b = solve.start.slice();
    total = 0;
    for (let k = 0; k < plan.stages.length; k++) {
      const line = stageLine(b, plan, k);
      if (!line) {
        total = null;
        break;
      }
      for (const m of line) E.applyMove(b, solve.N, m);
      total += line.length;
    }
  } catch (e) {
    total = null;
  }
  lineCache.set(key, total);
  if (lineCache.size > 6000) lineCache.delete(lineCache.keys().next().value);
  return total;
}

const D = (get) => (s) => get(deepOf(s), s);

// better: "low" | "high" | null (neither is better, it only describes the solve)
export const METRICS = [
  { key: "time", label: "Time", short: "Time", get: (s) => s.duration, fmt: tm, better: "low", group: "Result" },
  { key: "moves", label: "Moves", short: "Moves", get: (s) => s.moveCount ?? deepOf(s).M, fmt: n0, better: "low", group: "Result" },
  { key: "tps", label: "Tiles per second", short: "TPS", get: D((d) => d.tps), fmt: n2, better: "high", group: "Result" },
  { key: "msPerMove", label: "Time per move", short: "ms/move", get: D((d) => d.msPerMove), fmt: ms, better: "low", group: "Result" },
  { key: "diff", label: "Scramble length", short: "Scramble", get: difficulty, fmt: n0, better: null, group: "Scramble", note: "Shortest solution of the scramble. Higher is a harder scramble." },
  { key: "easier", label: "Harder than", short: "Harder than", get: easierThan, fmt: pc, better: null, group: "Scramble", note: "Share of all positions that are easier than this scramble." },
  { key: "perOptimal", label: "Time per scramble move", short: "ms/scr", get: D((d) => d.msPerOptimal), fmt: ms, better: "low", group: "Scramble", note: "Time divided by scramble length: a fair way to compare easy and hard scrambles." },
  { key: "excess", label: "Moves over the engine", short: "Over", get: D((d) => d.excess), fmt: n0, better: "low", group: "Engine" },
  { key: "efficiency", label: "Efficiency", short: "Eff.", get: D((d) => d.efficiency), fmt: pc, better: "high", group: "Engine" },
  { key: "lostMs", label: "Time lost to extra moves", short: "Lost", get: D((d) => d.lostMs), fmt: tm, better: "low", group: "Engine" },
  { key: "accuracy", label: "Accuracy", short: "Acc.", get: D((d) => (d.graded ? d.accuracy : null)), fmt: pc, better: "high", group: "Engine" },
  { key: "bad", label: "Wrong-way moves", short: "Wrong", get: D((d) => (d.graded ? d.bad : null)), fmt: n0, better: "low", group: "Engine" },
  { key: "wasted", label: "Wasted moves", short: "Wasted", get: D((d) => (d.graded ? d.wastedMoves : null)), fmt: n0, better: "low", group: "Engine" },
  { key: "cleanStreak", label: "Longest clean streak", short: "Streak", get: D((d) => (d.graded ? d.cleanStreak : null)), fmt: n0, better: "high", group: "Engine" },
  { key: "firstError", label: "First wrong move at", short: "1st error", get: D((d) => (d.graded ? d.firstError : null)), fmt: n0, better: "high", group: "Engine" },
  { key: "overLine", label: "Moves over your method line", short: "Over line", get: (s) => { const l = methodLine(s); return l == null ? null : (s.moveCount ?? deepOf(s).M) - l; }, fmt: n0, better: "low", group: "Method", note: "Against a tile-by-tile rows-first solve of the same scramble." },
  { key: "stops", label: "Stops", short: "Stops", get: D((d) => d.hesitations), fmt: n0, better: "low", group: "Rhythm", note: "Gaps of at least three times your normal gap." },
  { key: "stopMs", label: "Time in stops", short: "Stop time", get: D((d) => d.hesitationMs), fmt: tm, better: "low", group: "Rhythm" },
  { key: "gapMax", label: "Longest stop", short: "Longest", get: D((d) => d.gapMax), fmt: ms, better: "low", group: "Rhythm" },
  { key: "gapMedian", label: "Median gap", short: "Gap", get: D((d) => d.gapMedian), fmt: ms, better: "low", group: "Rhythm" },
  { key: "gapP90", label: "Slow gap (90th percentile)", short: "P90 gap", get: D((d) => d.gapP90), fmt: ms, better: "low", group: "Rhythm" },
  { key: "rhythm", label: "Unevenness", short: "Uneven", get: D((d) => d.rhythm), fmt: n2, better: "low", group: "Rhythm", note: "Spread of your gaps over their mean. Lower is steadier." },
  { key: "flow", label: "Flow", short: "Flow", get: D((d) => d.flowShare), fmt: pc, better: "high", group: "Rhythm", note: "Share of the solve spent moving at your own rhythm." },
  { key: "burst", label: "Fastest 10 moves", short: "Burst", get: D((d) => d.burstTps), fmt: n2, better: "high", group: "Speed" },
  { key: "tpsFirst", label: "TPS, first half", short: "TPS 1st", get: D((d) => d.tpsFirst), fmt: n2, better: "high", group: "Speed" },
  { key: "tpsSecond", label: "TPS, second half", short: "TPS 2nd", get: D((d) => d.tpsSecond), fmt: n2, better: "high", group: "Speed" },
  { key: "backtracks", label: "Straight take-backs", short: "Backs", get: D((d) => d.backtracks), fmt: n0, better: "low", group: "Shape", note: "A move followed at once by its opposite." },
  { key: "turnRate", label: "Turn rate", short: "Turns", get: D((d) => d.turnRate), fmt: pc, better: null, group: "Shape" },
  { key: "longestRun", label: "Longest straight run", short: "Run", get: D((d) => d.longestRun), fmt: n0, better: null, group: "Shape" },
  { key: "inspect", label: "Inspection", short: "Inspect", get: (s) => s.inspect ?? null, fmt: tm, better: null, group: "Result" },
];

/** Stage times for a size, as extra metrics ("Row 1 time", ...). */
export function stageMetrics(N, methodId = "rows") {
  if (N > 5) return [];
  const plan = planFor(N, methodId);
  return plan.stages.map((st, k) => ({
    key: "stage" + k,
    label: st.name + " time",
    short: st.name,
    get: (s) => {
      if (s.N !== N) return null;
      const sp = splitsOf(s, plan);
      return sp ? legs(sp)[k] : null;
    },
    fmt: tm,
    better: "low",
    group: "Stages",
  }));
}

export const metric = (key) => METRICS.find((m) => m.key === key);

/** 0 (best) to 1 (worst) for a value inside a sorted list of the shown values. Null when it has no better side. */
export function rankOf(sortedVals, v) {
  if (v == null || !sortedVals.length) return null;
  let lo = 0,
    hi = sortedVals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedVals[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  let up = lo;
  while (up < sortedVals.length && sortedVals[up] === v) up++;
  return sortedVals.length > 1 ? ((lo + up - 1) / 2) / (sortedVals.length - 1) : 0.5;
}

/** A background colour for a 0..1 score where 0 is good (blue) and 1 is bad (red). */
export function heatColor(score, strength = 0.42) {
  if (score == null) return "transparent";
  const t = Math.max(0, Math.min(1, score));
  const side = t < 0.5 ? "var(--heat-good, var(--chart-b))" : "var(--heat-bad, var(--chart-a))";
  const amt = Math.abs(t - 0.5) * 2;
  return `color-mix(in srgb, ${side} ${Math.round(amt * strength * 100)}%, transparent)`;
}

/** One hue, light to dark, for counts and other things with no good or bad side. */
export function inkColor(share, strength = 0.85) {
  if (share == null) return "transparent";
  const t = Math.max(0, Math.min(1, share));
  return `color-mix(in srgb, var(--ink) ${Math.round(t * strength * 100)}%, transparent)`;
}
