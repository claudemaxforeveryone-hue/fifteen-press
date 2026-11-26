// Deep statistics: everything that can be read out of a solve's move log, its move timings and
// the engine's exact distances, then rolled up across a list of solves.
import { decodeMoves, decodeTimes } from "./store.js";
import { trimmedAverage, mean, tps, efficiency } from "./stats.js";

const INV = [1, 0, 3, 2]; // U<->D, L<->R (blank directions)

/* ---------- small numeric helpers ---------- */

export function sorted(values) {
  return values.slice().sort((a, b) => a - b);
}

/** Linear-interpolated quantile of an already sorted list. */
export function quantileSorted(s, q) {
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos),
    hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(values) {
  return quantileSorted(sorted(values), 0.5);
}

export function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1),
  );
}

export function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/** Pearson correlation, or null when it is not defined. */
export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = mean(xs),
    my = mean(ys);
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Full description of one list of numbers. */
export function describe(values) {
  const n = values.length;
  if (!n) return { n: 0 };
  const s = sorted(values);
  const m = mean(values);
  const sd = stdev(values);
  return {
    n,
    mean: m,
    median: quantileSorted(s, 0.5),
    min: s[0],
    max: s[n - 1],
    sd,
    cv: sd != null && m ? sd / m : null,
    p10: quantileSorted(s, 0.1),
    p25: quantileSorted(s, 0.25),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    iqr: quantileSorted(s, 0.75) - quantileSorted(s, 0.25),
    trimmed: n >= 3 ? trimmedAverage(values) : m,
    sum: sum(values),
    range: s[n - 1] - s[0],
  };
}

/* ---------- one solve ---------- */

const cache = new Map();

/** Everything measurable about one solve. Cached until its grading changes. */
export function deepOf(solve) {
  const key = solve.id;
  const stamp = (solve.dist ? solve.dist.length : 0) + ":" + (solve.optimal ?? "");
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = compute(solve);
  cache.set(key, { stamp, value });
  if (cache.size > 6000) cache.delete(cache.keys().next().value);
  return value;
}

function compute(solve) {
  const moves = decodeMoves(solve.moves);
  const times = decodeTimes(solve.times);
  const M = moves.length;
  const out = {
    M,
    duration: solve.duration,
    tps: tps(solve),
    msPerMove: M ? solve.duration / M : null,
    efficiency: efficiency(solve),
    excess: solve.optimal != null ? M - solve.optimal : null,
    msPerOptimal: solve.optimal ? solve.duration / solve.optimal : null,
    inspect: solve.inspect ?? null,
  };

  // gaps between moves; the first move starts the clock so it has no think time
  const gaps = [];
  for (let i = 1; i < Math.min(M, times.length); i++) gaps.push(times[i] - times[i - 1]);
  out.gaps = gaps;
  if (gaps.length) {
    const g = sorted(gaps);
    const med = quantileSorted(g, 0.5);
    out.gapMedian = med;
    out.gapMean = mean(gaps);
    out.gapP90 = quantileSorted(g, 0.9);
    out.gapMin = g[0];
    out.gapMax = g[g.length - 1];
    out.gapMaxAt = gaps.indexOf(out.gapMax) + 2; // move number that followed the longest stop
    out.gapSd = stdev(gaps);
    out.rhythm = out.gapSd != null && out.gapMean ? out.gapSd / out.gapMean : null;
    // a hesitation is a stop of at least three times your normal gap (and never under 250 ms)
    const limit = Math.max(250, med * 3);
    out.hesitations = gaps.filter((x) => x >= limit).length;
    out.hesitationMs = sum(gaps.filter((x) => x >= limit).map((x) => x - med));
    // time spent actually sliding at your own rhythm
    out.flowShare = solve.duration > 0 ? 1 - out.hesitationMs / solve.duration : null;
  }

  // fastest 10-move burst and first half against second half
  const W = Math.min(10, M);
  if (W >= 4 && times.length >= M) {
    let best = 0;
    for (let i = W; i <= M; i++) {
      const t0 = i - W === 0 ? 0 : times[i - W - 1];
      const dt = times[i - 1] - t0;
      if (dt > 0) best = Math.max(best, W / (dt / 1000));
    }
    out.burstTps = best || null;
    const half = Math.floor(M / 2);
    const tHalf = times[half - 1] || 0;
    out.tpsFirst = tHalf > 0 ? half / (tHalf / 1000) : null;
    out.tpsSecond =
      solve.duration - tHalf > 0 ? (M - half) / ((solve.duration - tHalf) / 1000) : null;
  }

  // shape of the move sequence
  let backtracks = 0,
    turns = 0,
    runs = 0,
    longestRun = M ? 1 : 0,
    run = 1;
  const dirs = [0, 0, 0, 0];
  for (let i = 0; i < M; i++) {
    dirs[moves[i]]++;
    if (i === 0) continue;
    if (moves[i] === INV[moves[i - 1]]) backtracks++;
    if (moves[i] >> 1 !== moves[i - 1] >> 1) turns++;
    if (moves[i] === moves[i - 1]) {
      run++;
      if (run === 2) runs++;
      longestRun = Math.max(longestRun, run);
    } else run = 1;
  }
  out.backtracks = backtracks;
  out.turnRate = M > 1 ? turns / (M - 1) : null;
  out.runs = runs;
  out.longestRun = longestRun;
  out.dirs = dirs;

  // engine line: exact distance to solved before and after every move
  const d = parseDist(solve);
  if (d) {
    let good = 0,
      bad = 0,
      streak = 0,
      bestStreak = 0,
      firstError = null,
      badMs = 0,
      goodMs = 0,
      goodN = 0,
      badN = 0;
    const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };
    let chain = 0;
    const closeChain = () => {
      if (!chain) return;
      counts[chain >= 4 ? "blunder" : chain >= 2 ? "mistake" : "inaccuracy"]++;
      chain = 0;
    };
    for (let i = 0; i < M; i++) {
      if (d.d[i] == null || d.d[i + 1] == null || !d.exact[i] || !d.exact[i + 1]) {
        closeChain();
        continue;
      }
      const think = i > 0 && gaps[i - 1] != null ? gaps[i - 1] : null;
      if (d.d[i + 1] < d.d[i]) {
        good++;
        streak++;
        bestStreak = Math.max(bestStreak, streak);
        closeChain();
        if (think != null) {
          goodMs += think;
          goodN++;
        }
      } else {
        bad++;
        streak = 0;
        chain++;
        if (firstError == null) firstError = i + 1;
        if (think != null) {
          badMs += think;
          badN++;
        }
      }
    }
    closeChain();
    const graded = good + bad;
    if (graded >= M * 0.6 && graded > 0) {
      out.graded = true;
      out.good = good;
      out.bad = bad;
      out.accuracy = good / graded;
      out.cleanStreak = bestStreak;
      out.firstError = firstError;
      out.mistakes = counts;
      out.episodes = counts.inaccuracy + counts.mistake + counts.blunder;
      out.thinkGood = goodN ? goodMs / goodN : null;
      out.thinkBad = badN ? badMs / badN : null;
      // every wrong-way move costs itself plus the move that undoes it
      out.wastedMoves = bad * 2;
      out.wastedMs = out.msPerMove != null ? bad * 2 * out.msPerMove : null;
      out.perfect = bad === 0;
    }
  }
  if (out.excess != null && out.msPerMove != null) {
    // what the clock would read at your own pace on the engine's line
    out.engineLineMs = solve.optimal * out.msPerMove;
    out.lostMs = out.excess * out.msPerMove;
  }
  return out;
}

function parseDist(solve) {
  if (!solve.dist || solve.distEstimate) return null;
  const d = solve.dist.split(",").map((x) => (x === "" ? null : Number(x)));
  const exact = solve.distExact
    ? d.map(() => true)
    : (solve.distMask || "").split("").map((c) => c === "1");
  return { d, exact };
}

/* ---------- averages ---------- */

export const AVERAGE_SIZES = [5, 12, 25, 50, 100, 200, 500, 1000];

/** Current, best and worst rolling value for a window, plus where the best one ended. */
export function rolling(values, n, { trimmed = true } = {}) {
  if (values.length < n) return { n, current: null, best: null, worst: null, bestAt: null };
  let best = Infinity,
    worst = -Infinity,
    bestAt = null,
    current = null;
  if (!trimmed) {
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      if (i >= n) acc -= values[i - n];
      if (i >= n - 1) {
        current = acc / n;
        if (current < best) {
          best = current;
          bestAt = i;
        }
        if (current > worst) worst = current;
      }
    }
  } else {
    for (let i = n; i <= values.length; i++) {
      current = trimmedAverage(values.slice(i - n, i));
      if (current < best) {
        best = current;
        bestAt = i - 1;
      }
      if (current > worst) worst = current;
    }
  }
  return { n, current, best, worst, bestAt };
}

/* ---------- personal bests ---------- */

/** Every time the record fell: [{index, date, value, prev}]. lower = better unless `higher`. */
export function progression(solves, valueOf, { higher = false } = {}) {
  const out = [];
  let best = null;
  solves.forEach((s, index) => {
    const v = valueOf(s, index);
    if (v == null || !isFinite(v)) return;
    if (best == null || (higher ? v > best : v < best)) {
      out.push({ index, date: s.date, value: v, prev: best, id: s.id });
      best = v;
    }
  });
  return out;
}

export function averageProgression(solves, n) {
  const times = solves.map((s) => s.duration);
  const out = [];
  let best = null;
  for (let i = n; i <= times.length; i++) {
    const a = trimmedAverage(times.slice(i - n, i));
    if (best == null || a < best) {
      out.push({ index: i - 1, date: solves[i - 1].date, value: a, prev: best });
      best = a;
    }
  }
  return out;
}

/* ---------- sessions ---------- */

export const SESSION_GAP = 30 * 60 * 1000;

/** Splits solves into sittings: a break of 30 minutes starts a new one. */
export function sessions(solves) {
  const out = [];
  let cur = null;
  for (const s of solves) {
    const start = s.date - s.duration;
    if (!cur || start - cur.end > SESSION_GAP) {
      cur = { start, end: s.date, solves: [] };
      out.push(cur);
    }
    cur.solves.push(s);
    cur.end = s.date;
  }
  for (const x of out) {
    const t = x.solves.map((s) => s.duration);
    x.count = t.length;
    x.mean = mean(t);
    x.median = median(t);
    x.best = Math.min(...t);
    x.worst = Math.max(...t);
    x.ao5 = rolling(t, 5).best;
    x.ao12 = rolling(t, 12).best;
    x.boardMs = sum(t);
    x.spanMs = x.end - x.start;
    x.moves = sum(x.solves.map((s) => s.moveCount));
    x.tps = x.boardMs > 0 ? x.moves / (x.boardMs / 1000) : null;
    // warm-up: first three against the rest
    x.warm = t.length >= 6 ? mean(t.slice(0, 3)) - mean(t.slice(3)) : null;
  }
  return out;
}

/* ---------- calendar and clock ---------- */

export function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function byDay(solves) {
  const map = new Map();
  for (const s of solves) {
    const k = dayKey(s.date);
    let e = map.get(k);
    if (!e) map.set(k, (e = { key: k, date: startOfDay(s.date), n: 0, total: 0, best: Infinity, moves: 0 }));
    e.n++;
    e.total += s.duration;
    e.moves += s.moveCount;
    e.best = Math.min(e.best, s.duration);
  }
  for (const e of map.values()) e.mean = e.total / e.n;
  return map;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Current and longest run of days in a row with at least one solve. */
export function dayStreaks(days) {
  const keys = [...days.values()].map((e) => e.date).sort((a, b) => a - b);
  let longest = 0,
    run = 0,
    prev = null;
  for (const t of keys) {
    run = prev != null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  let current = 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) {
    current++;
    d.setDate(d.getDate() - 1);
  }
  return { current, longest };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function byWeekday(solves) {
  const rows = WEEKDAYS.map((label) => ({ label, list: [] }));
  for (const s of solves) rows[new Date(s.date).getDay()].list.push(s.duration);
  return rows.map((r) => ({ label: r.label, n: r.list.length, mean: mean(r.list), best: r.list.length ? Math.min(...r.list) : null }));
}

export function byHour(solves) {
  const rows = Array.from({ length: 24 }, (_, hour) => ({ hour, list: [] }));
  for (const s of solves) rows[new Date(s.date).getHours()].list.push(s.duration);
  return rows.map((r) => ({ hour: r.hour, n: r.list.length, mean: mean(r.list) }));
}

export function byMode(solves) {
  const names = { random: "Random", daily: "Daily", seed: "Seed", custom: "Custom board" };
  const groups = new Map();
  for (const s of solves) {
    if (!groups.has(s.mode)) groups.set(s.mode, []);
    groups.get(s.mode).push(s);
  }
  return [...groups.entries()].map(([mode, list]) => ({
    label: names[mode] || mode,
    n: list.length,
    mean: mean(list.map((s) => s.duration)),
    best: Math.min(...list.map((s) => s.duration)),
    moves: mean(list.map((s) => s.moveCount)),
  }));
}

/* ---------- the roll-up ---------- */

/** Thresholds for "sub-X" counts that suit the player's own range. */
export function subMarks(bestMs, medianMs) {
  const ladder = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 45, 60, 90, 120, 180, 240, 300, 600, 900, 1800];
  const lo = bestMs / 1000,
    hi = (medianMs / 1000) * 1.6;
  const picks = ladder.filter((x) => x > lo && x <= Math.max(hi, lo * 2));
  return picks.slice(0, 6);
}

export function aggregate(solves) {
  const n = solves.length;
  const deep = solves.map(deepOf);
  const times = solves.map((s) => s.duration);
  const moves = solves.map((s) => s.moveCount);
  const out = { n, solves, deep };
  out.time = describe(times);
  out.moves = describe(moves);
  out.tps = describe(deep.map((d) => d.tps));
  out.tps.overall = out.time.sum > 0 ? out.moves.sum / (out.time.sum / 1000) : null;
  out.msPerMove = describe(deep.filter((d) => d.msPerMove != null).map((d) => d.msPerMove));
  out.msPerMove.overall = out.moves.sum > 0 ? out.time.sum / out.moves.sum : null;

  // averages
  out.mo3 = rolling(times, 3, { trimmed: false });
  out.averages = AVERAGE_SIZES.map((k) => rolling(times, k));
  out.moveAverages = [5, 12, 50, 100].map((k) => rolling(moves, k, { trimmed: false }));

  // sub-X
  if (n) {
    out.subs = subMarks(out.time.min, out.time.median).map((sec) => {
      const c = times.filter((t) => t < sec * 1000).length;
      const first = times.findIndex((t) => t < sec * 1000);
      return { sec, count: c, share: c / n, first: first >= 0 ? solves[first] : null };
    });
  } else out.subs = [];

  // rhythm and pauses
  const withGaps = deep.filter((d) => d.gapMedian != null);
  const pick = (k) => withGaps.map((d) => d[k]).filter((x) => x != null);
  out.pace = {
    n: withGaps.length,
    gapMedian: describe(pick("gapMedian")),
    gapP90: describe(pick("gapP90")),
    gapMax: describe(pick("gapMax")),
    hesitations: describe(pick("hesitations")),
    hesitationMs: describe(pick("hesitationMs")),
    flowShare: describe(pick("flowShare")),
    rhythm: describe(pick("rhythm")),
    burst: describe(pick("burstTps")),
    tpsFirst: describe(pick("tpsFirst")),
    tpsSecond: describe(pick("tpsSecond")),
    inspect: describe(deep.map((d) => d.inspect).filter((x) => x != null)),
  };
  // every gap of every solve in one pool, for the histogram and the true median
  const pool = [];
  for (const d of withGaps) for (const g of d.gaps) pool.push(g);
  out.pace.pool = pool;
  out.pace.poolStats = describe(pool);

  // sequence shape
  out.shape = {
    backtracks: describe(deep.map((d) => d.backtracks)),
    turnRate: describe(deep.filter((d) => d.turnRate != null).map((d) => d.turnRate)),
    longestRun: describe(deep.map((d) => d.longestRun)),
    dirs: deep.reduce((a, d) => a.map((x, i) => x + d.dirs[i]), [0, 0, 0, 0]),
  };

  // against the engine
  const withOpt = solves.filter((s) => s.optimal != null && s.moveCount > 0);
  const dOpt = withOpt.map(deepOf);
  const graded = deep.filter((d) => d.graded);
  out.engine = {
    known: withOpt.length,
    gradedCount: graded.length,
    optimal: describe(withOpt.map((s) => s.optimal)),
    efficiency: describe(dOpt.map((d) => d.efficiency)),
    excess: describe(dOpt.map((d) => d.excess)),
    msPerOptimal: describe(dOpt.map((d) => d.msPerOptimal)),
    engineLineMs: describe(dOpt.map((d) => d.engineLineMs).filter((x) => x != null)),
    lostMs: describe(dOpt.map((d) => d.lostMs).filter((x) => x != null)),
    totalExcess: sum(dOpt.map((d) => d.excess)),
    totalOptimal: sum(withOpt.map((s) => s.optimal)),
    totalMoves: sum(withOpt.map((s) => s.moveCount)),
    perfect: dOpt.filter((d) => d.excess === 0).length,
    within10: dOpt.filter((d) => d.efficiency >= 0.9).length,
    accuracy: describe(graded.map((d) => d.accuracy)),
    good: sum(graded.map((d) => d.good)),
    bad: sum(graded.map((d) => d.bad)),
    wrongWay: describe(graded.map((d) => d.bad)),
    cleanStreak: describe(graded.map((d) => d.cleanStreak)),
    firstError: describe(graded.filter((d) => d.firstError != null).map((d) => d.firstError)),
    thinkGood: describe(graded.map((d) => d.thinkGood).filter((x) => x != null)),
    thinkBad: describe(graded.map((d) => d.thinkBad).filter((x) => x != null)),
    inaccuracies: sum(graded.map((d) => d.mistakes.inaccuracy)),
    mistakes: sum(graded.map((d) => d.mistakes.mistake)),
    blunders: sum(graded.map((d) => d.mistakes.blunder)),
    gradedMoves: sum(graded.map((d) => d.good + d.bad)),
    // does a harder scramble cost you more time, and do extra moves cost more than slow hands?
    rLengthTime: correlation(withOpt.map((s) => s.optimal), withOpt.map((s) => s.duration)),
    rMovesTime: correlation(moves, times),
    rTpsTime: correlation(deep.map((d) => d.tps), times),
  };
  out.engine.overallEfficiency = out.engine.totalMoves ? out.engine.totalOptimal / out.engine.totalMoves : null;
  out.engine.overallAccuracy = out.engine.gradedMoves ? out.engine.good / out.engine.gradedMoves : null;

  // records over time
  out.pb = {
    single: progression(solves, (s) => s.duration),
    moves: progression(solves, (s) => s.moveCount),
    tps: progression(solves, (s) => tps(s), { higher: true }),
    ao5: averageProgression(solves, 5),
    ao12: averageProgression(solves, 12),
  };
  const lastPb = out.pb.single[out.pb.single.length - 1];
  out.pb.sinceLast = lastPb ? n - 1 - lastPb.index : null;

  // where the latest solve sits in the whole history
  if (n) {
    const last = times[n - 1];
    out.lastRank = times.filter((t) => t < last).length + 1;
  }
  return out;
}

/** Counts by time bucket for a histogram. Returns {width, bins:[{x, value, from, to}]}. */
export function histogram(values, targetBins = 16) {
  if (!values.length) return { width: 1, bins: [] };
  const lo = Math.min(...values),
    hi = Math.max(...values);
  const raw = (hi - lo) / targetBins || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const width = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((w) => w >= raw) || raw;
  const first = Math.floor(lo / width);
  const lastBin = Math.floor(hi / width);
  const counts = new Map();
  for (const v of values) {
    const b = Math.floor(v / width);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  const bins = [];
  for (let b = first; b <= lastBin; b++)
    bins.push({ x: b - first, value: counts.get(b) || 0, from: b * width, to: (b + 1) * width });
  return { width, bins };
}

export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return "-";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
}

export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min " + (s % 60 ? (s % 60) + " s" : "").trim();
  const hr = Math.floor(m / 60);
  return hr + " h " + (m % 60) + " min";
}
