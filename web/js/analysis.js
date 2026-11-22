// Turns a recorded solve plus per-position optimal distances into a readable proof.
import { positionsFrom } from "./game.js";
import { fmtTime } from "./stats.js";
const E = window.FifteenEngine;

export function phasesFor(N) {
  const phases = [];
  for (let k = 0; k <= N - 3; k++) {
    const row = [],
      col = [];
    for (let c = k; c < N; c++) row.push(k * N + c + 1);
    for (let r = k + 1; r < N; r++) col.push(r * N + k + 1);
    phases.push({ name: `Row ${k + 1}`, tiles: row });
    phases.push({ name: `Column ${k + 1}`, tiles: col });
  }
  const last = [];
  for (let r = N - 2; r < N; r++)
    for (let c = N - 2; c < N; c++)
      if (r * N + c + 1 < N * N) last.push(r * N + c + 1);
  phases.push({ name: "Last block", tiles: last });
  return phases;
}

export function analyze(solve, dist) {
  const { N } = solve;
  const moves = solve.movesArr;
  const times = solve.timesArr;
  const M = moves.length;
  const positions = positionsFrom(solve.start, N, moves);
  const d = dist ? dist.d : null;
  const exact = dist ? dist.exact : null;
  const estimate = !dist || dist.estimate;

  // per-move verdicts
  const verdict = new Array(M).fill("unknown");
  let good = 0,
    bad = 0;
  if (d) {
    for (let i = 0; i < M; i++) {
      if (d[i] == null || d[i + 1] == null) continue;
      if (!estimate && !(exact[i] && exact[i + 1])) continue;
      if (d[i + 1] < d[i]) {
        verdict[i] = "good";
        good++;
      } else {
        verdict[i] = "bad";
        bad++;
      }
    }
  }

  // think time before each move (the first move starts the clock)
  const gaps = times.map((t, i) => (i === 0 ? 0 : t - times[i - 1]));
  const pauses = gaps
    .map((g, i) => ({ i, g }))
    .sort((a, b) => b.g - a.g)
    .slice(0, 3)
    .filter((p) => p.g > 0);

  // immediate take-backs and revisited positions
  let backtracks = 0;
  for (let i = 1; i < M; i++)
    if (moves[i] === E.INV[moves[i - 1]]) backtracks++;
  const seen = new Map();
  let revisits = 0;
  positions.forEach((p, i) => {
    const k = p.join(",");
    if (seen.has(k)) revisits++;
    else seen.set(k, i);
  });

  // fastest 10-move burst
  let burst = null;
  const W = Math.min(10, M);
  for (let i = W; i <= M && W > 1; i++) {
    const t0 = i - W === 0 ? 0 : times[i - W - 1];
    const dt = times[i - 1] - t0;
    const tps = dt > 0 ? W / (dt / 1000) : 0;
    if (dt > 0 && (!burst || tps > burst.tps))
      burst = { from: i - W + 1, to: i, tps };
  }

  // phases: index after which a group's tiles stay home for good
  const defs = phasesFor(N);
  const done = defs
    .map((p) => {
      let at = 0;
      for (let i = positions.length - 1; i >= 0; i--) {
        const ok = p.tiles.every((t) => positions[i][t - 1] === t);
        if (!ok) {
          at = i + 1;
          break;
        }
      }
      return { ...p, at };
    })
    .sort((a, b) => a.at - b.at);
  let prev = 0;
  const phases = done
    .map((p) => {
      const from = prev,
        to = p.at;
      prev = Math.max(prev, to);
      const mv = to - from;
      const tStart = from === 0 ? 0 : times[from - 1];
      const tEnd = to === 0 ? 0 : times[to - 1];
      const ms = Math.max(0, tEnd - tStart);
      let mistakes = 0;
      for (let i = from; i < to; i++) if (verdict[i] === "bad") mistakes++;
      const progress =
        d && d[from] != null && d[to] != null ? d[from] - d[to] : null;
      return {
        name: p.name,
        from,
        to,
        moves: mv,
        ms,
        tps: ms > 0 ? mv / (ms / 1000) : null,
        mistakes,
        progress,
      };
    })
    .filter((p) => p.moves > 0);

  const optimal = solve.optimal ?? (d && !estimate && exact && exact[0] ? d[0] : null);
  const report = {
    M,
    positions,
    d,
    exact,
    estimate,
    verdict,
    good,
    bad,
    gaps,
    pauses,
    backtracks,
    revisits,
    burst,
    phases,
    optimal,
    efficiency: optimal ? optimal / M : null,
    tps: solve.duration > 0 ? M / (solve.duration / 1000) : null,
  };
  report.insights = insights(solve, report);
  return report;
}

function insights(solve, r) {
  const out = [];
  if (r.optimal != null && !r.estimate) {
    const waste = r.M - r.optimal;
    if (waste === 0)
      out.push({
        tone: "good",
        text: "A perfect solve. Every move took the shortest route the engine knows. That is rare.",
      });
    else
      out.push({
        tone: "plain",
        text: `The engine needed ${r.optimal} moves, you used ${r.M}. That is ${waste} extra, or ${r.bad} moves that walked away from the goal.`,
      });
  }
  const worst = r.phases
    .filter((p) => p.mistakes > 0)
    .sort((a, b) => b.mistakes - a.mistakes)[0];
  if (worst && r.bad > 2) {
    out.push({
      tone: "warn",
      text: worst.mistakes === r.bad ? `All ${r.bad} wrong-way moves happened during ${worst.name.toLowerCase()}.` : `${worst.name} leaked the most: ${worst.mistakes} of your ${r.bad} wrong-way moves happened there.`,
    });
  }
  const slowest = r.phases
    .filter((p) => p.tps != null && p.moves >= 4)
    .sort((a, b) => a.tps - b.tps)[0];
  const fastest = r.phases
    .filter((p) => p.tps != null && p.moves >= 4)
    .sort((a, b) => b.tps - a.tps)[0];
  if (
    slowest &&
    fastest &&
    slowest !== fastest &&
    fastest.tps > slowest.tps * 1.4
  ) {
    out.push({
      tone: "plain",
      text: `${slowest.name} was your slowest stretch at ${slowest.tps.toFixed(1)} TPS, against ${fastest.tps.toFixed(1)} in ${fastest.name.toLowerCase()}.`,
    });
  }
  if (r.pauses.length && r.pauses[0].g > 1200) {
    out.push({
      tone: "warn",
      text: `Your longest think was ${fmtTime(r.pauses[0].g)}s before move ${r.pauses[0].i + 1}. Planning a few moves ahead during inspection removes stops like this.`,
    });
  }
  if (r.backtracks >= 3) {
    out.push({
      tone: "warn",
      text: `You took back a move straight away ${r.backtracks} times. Each one costs two moves for nothing.`,
    });
  }
  if (r.revisits > r.backtracks + 2) {
    out.push({
      tone: "plain",
      text: `You passed through the same position ${r.revisits} times, so some loops went nowhere.`,
    });
  }
  if (r.burst && r.burst.tps > 0) {
    out.push({
      tone: "good",
      text: `Fastest burst: moves ${r.burst.from} to ${r.burst.to} at ${r.burst.tps.toFixed(1)} tiles per second.`,
    });
  }
  if (r.efficiency != null && r.efficiency >= 0.75 && r.M > 0) {
    out.push({
      tone: "good",
      text: `${Math.round(r.efficiency * 100)}% efficiency puts this solve close to engine play.`,
    });
  }
  return out;
}
