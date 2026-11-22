// Solve statistics. Averages follow the speedsolving convention:
// an average of n drops the best and worst 5% (at least one each), then takes the mean.
const D = window.FifteenData;

export function trimmedAverage(values) {
  const n = values.length;
  if (n < 3) return null;
  const cut = Math.max(1, Math.ceil(n * 0.05));
  const sorted = values.slice().sort((a, b) => a - b);
  const kept = sorted.slice(cut, n - cut);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function mean(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

// Rolling "current" aoN and the best aoN seen.
export function aoN(values, n) {
  if (values.length < n) return { current: null, best: null };
  let best = Infinity,
    current = null;
  for (let i = n; i <= values.length; i++) {
    const a = trimmedAverage(values.slice(i - n, i));
    if (a < best) best = a;
    current = a;
  }
  return { current, best };
}

// Plain mean of n in a row, as csTimer counts mo3 (nothing trimmed).
export function moN(values, n) {
  if (values.length < n) return { current: null, best: null };
  let best = Infinity,
    current = null;
  for (let i = n; i <= values.length; i++) {
    const m = mean(values.slice(i - n, i));
    if (m < best) best = m;
    current = m;
  }
  return { current, best };
}

/** "92%", or "99.7%" near the ends where whole numbers would round to 100. */
export function pctFine(x) {
  const p = x * 100;
  if (p >= 99 || p <= 1) return (p >= 99.95 ? p.toFixed(2) : p.toFixed(1)) + "%";
  return Math.round(p) + "%";
}

export function rollingSeries(values, n) {
  const out = [];
  for (let i = 0; i < values.length; i++)
    out.push(
      i + 1 >= n ? trimmedAverage(values.slice(i + 1 - n, i + 1)) : null,
    );
  return out;
}

export function tps(solve) {
  return solve.duration > 0 ? solve.moveCount / (solve.duration / 1000) : 0;
}

export function efficiency(solve) {
  if (!solve.optimal || !solve.moveCount) return null;
  return solve.optimal / solve.moveCount;
}

export function summarize(solves) {
  const times = solves.map((s) => s.duration);
  const moves = solves.map((s) => s.moveCount);
  const tpsList = solves.map(tps);
  const effs = solves.map(efficiency).filter((x) => x != null);
  const out = {
    count: solves.length,
    bestTime: times.length ? Math.min(...times) : null,
    bestMoves: moves.length ? Math.min(...moves) : null,
    bestTPS: tpsList.length ? Math.max(...tpsList) : null,
    meanTime: mean(times),
    meanMoves: mean(moves),
    meanTPS: mean(tpsList),
    meanEff: mean(effs),
    bestEff: effs.length ? Math.max(...effs) : null,
    totalMoves: moves.reduce((a, b) => a + b, 0),
    totalTime: times.reduce((a, b) => a + b, 0),
  };
  for (const n of [5, 12, 50, 100]) out["ao" + n] = aoN(times, n);
  out.mo3 = moN(times, 3);
  out.last = times.length ? times[times.length - 1] : null;
  return out;
}

/* ---------- probability of a scramble ---------- */

const TOTAL4 = D.DIST4.reduce((a, b) => a + b, 0);
const TOTAL3 = D.DIST3.reduce((a, b) => a + b, 0);

export function distributionFor(N) {
  if (N === 4) return { counts: D.DIST4, total: TOTAL4 };
  if (N === 3) return { counts: D.DIST3, total: TOTAL3 };
  return null;
}

// How a scramble of optimal length L sits against every position of that size.
export function rarity(N, L) {
  const positions = D.factorial(N * N) / 2;
  const out = { positions, pExact: 1 / positions };
  const dist = distributionFor(N);
  if (!dist || L == null || L >= dist.counts.length) return out;
  let below = 0;
  for (let i = 0; i < L; i++) below += dist.counts[i];
  const at = dist.counts[L];
  out.pLength = at / dist.total; // a random scramble needs exactly L
  out.pAtMost = (below + at) / dist.total;
  out.pAtLeast = (dist.total - below) / dist.total;
  out.harderThan = below / dist.total; // share of positions strictly easier
  out.countAtLength = at;
  out.mode = dist.counts.indexOf(Math.max(...dist.counts));
  out.mean = dist.counts.reduce((a, c, i) => a + c * i, 0) / dist.total;
  return out;
}

export function difficultyWord(r) {
  if (r.harderThan == null) return null;
  const h = r.harderThan;
  if (h > 0.999) return "legendary";
  if (h > 0.98) return "brutal";
  if (h > 0.85) return "hard";
  if (h > 0.6) return "above average";
  if (h > 0.4) return "average";
  if (h > 0.15) return "friendly";
  if (h > 0.02) return "easy";
  return "gift";
}

/* ---------- formatting ---------- */

export function fmtTime(ms, { precise = true } = {}) {
  if (ms == null || !isFinite(ms)) return "-";
  // round first so 119.999 s reads 2:00.00, never 1:60.00
  const step = precise ? 10 : 100;
  const units = Math.round(ms / step);
  const s = (units * step) / 1000;
  const dp = precise ? 2 : 1;
  if (s < 60) return s.toFixed(dp);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ":" + (rest < 10 ? "0" : "") + rest.toFixed(dp);
}

export function fmtNum(n, digits = 0) {
  if (n == null || !isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(p, digits) {
  if (p == null || !isFinite(p)) return "-";
  const v = p * 100;
  if (digits == null)
    digits =
      v === 0 ? 0 : v < 0.01 ? 4 : v < 0.1 ? 3 : v < 1 ? 2 : v < 10 ? 1 : 0;
  return v.toFixed(digits) + "%";
}

export function fmtOdds(p) {
  if (!p) return "-";
  const n = 1 / p;
  if (n < 1.05) return "almost every time";
  return "1 in " + fmtBig(n);
}

export function fmtBig(n) {
  if (n < 1e6) return Math.round(n).toLocaleString();
  if (n < 1e15) {
    const units = [
      [1e12, "trillion"],
      [1e9, "billion"],
      [1e6, "million"],
    ];
    for (const [v, w] of units)
      if (n >= v)
        return (
          (n / v).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          }) +
          " " +
          w
        );
  }
  const e = Math.floor(Math.log10(n));
  return (n / Math.pow(10, e)).toFixed(2) + " × 10" + sup(e);
}

function sup(n) {
  return String(n)
    .split("")
    .map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[+c])
    .join("");
}

/* ---------- habits ---------- */

const dayKey = (t) => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

/** Records, streaks, consistency, trend and splits by scramble length and time of day. */
export function habits(solves, N) {
  const times = solves.map((s) => s.duration);
  const days = new Map();
  for (const s of solves) days.set(dayKey(s.date), (days.get(dayKey(s.date)) || 0) + 1);
  // streak of consecutive days ending today or yesterday
  let streak = 0;
  const d = new Date();
  d.setHours(12);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const last50 = times.slice(-50);
  const m50 = mean(last50);
  const sd = last50.length > 2
    ? Math.sqrt(last50.reduce((a, x) => a + (x - m50) ** 2, 0) / (last50.length - 1))
    : null;
  const recent = mean(times.slice(-20));
  const before = times.length >= 40 ? mean(times.slice(-40, -20)) : null;

  // scramble length buckets, sized to the board
  const opt = solves.filter((s) => s.optimal);
  let byLength = [];
  if (opt.length >= 3) {
    const step = N <= 3 ? 3 : 4;
    const groups = new Map();
    for (const s of opt) {
      const lo = Math.floor(s.optimal / step) * step;
      if (!groups.has(lo)) groups.set(lo, []);
      groups.get(lo).push(s);
    }
    byLength = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([lo, list]) => ({
        label: `${lo} to ${lo + step - 1}`,
        n: list.length,
        mean: mean(list.map((s) => s.duration)),
        moves: mean(list.map((s) => s.moveCount)),
      }));
  }

  const slots = [
    ["Morning", 5, 12],
    ["Afternoon", 12, 17],
    ["Evening", 17, 22],
    ["Night", 22, 29],
  ];
  const byHour = slots
    .map(([label, a, b]) => {
      const list = solves.filter((s) => {
        let hr = new Date(s.date).getHours();
        if (hr < 5) hr += 24;
        return hr >= a && hr < b;
      });
      return { label, n: list.length, mean: mean(list.map((s) => s.duration)) };
    })
    .filter((x) => x.n);

  const best = (f) => solves.reduce((a, s) => (a == null || f(s) > f(a) ? s : a), null);
  return {
    bestSingle: solves.reduce((a, s) => (!a || s.duration < a.duration ? s : a), null),
    bestTps: best(tps),
    bestEff: opt.length ? best((s) => efficiency(s) || 0) : null,
    busiest: [...days.values()].reduce((a, b) => Math.max(a, b), 0),
    days: days.size,
    streak,
    cv: sd != null && m50 ? sd / m50 : null,
    trend: before && recent ? (before - recent) / before : null,
    underMean: m50 ? last50.filter((x) => x < m50).length / last50.length : null,
    byLength,
    byHour,
  };
}
