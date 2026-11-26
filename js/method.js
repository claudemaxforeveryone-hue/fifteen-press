// Reads how a player solves: the order tiles get placed, which method that matches,
// what each stage costs against a tile-by-tile engine line, and what to fix first.
import { positionsFrom } from "./game.js";
import { phasesFor } from "./analysis.js";
import { decodeMoves, decodeTimes } from "./store.js";
import { fmtTime } from "./stats.js";
import { h } from "./ui.js";

const E = window.FifteenEngine;
const range = (n) => Array.from({ length: n }, (_, i) => i);
const at = (N, r, c) => r * N + c + 1;

// Each method is the order its groups of tiles get finished.
export function methodsFor(N) {
  const lastThree = {
    name: "Last three",
    kind: "last",
    tiles: [at(N, N - 2, N - 2), at(N, N - 2, N - 1), at(N, N - 1, N - 2)],
  };
  const rows = [];
  for (let r = 0; r < N - 2; r++)
    rows.push({
      name: `Row ${r + 1}`,
      kind: "line",
      tiles: range(N).map((c) => at(N, r, c)),
    });
  for (let c = 0; c < N - 2; c++)
    rows.push({
      name: `${at(N, N - 2, c)} and ${at(N, N - 1, c)}`,
      kind: "pair-col",
      tiles: [at(N, N - 2, c), at(N, N - 1, c)],
    });
  rows.push(lastThree);

  const cols = [];
  for (let c = 0; c < N - 2; c++)
    cols.push({
      name: `Column ${c + 1}`,
      kind: "line",
      tiles: range(N).map((r) => at(N, r, c)),
    });
  for (let r = 0; r < N - 2; r++)
    cols.push({
      name: `${at(N, r, N - 2)} and ${at(N, r, N - 1)}`,
      kind: "pair-row",
      tiles: [at(N, r, N - 2), at(N, r, N - 1)],
    });
  cols.push(lastThree);

  const fringe = phasesFor(N).map((p) => ({
    name: p.name,
    kind: p.name === "Last block" ? "last" : "line",
    tiles: p.tiles,
  }));

  return {
    rows: { id: "rows", name: "Row by row", groups: rows },
    cols: { id: "cols", name: "Column by column", groups: cols },
    fringe: {
      id: "fringe",
      name: "Fringe (a row, then a column)",
      groups: fringe,
    },
  };
}

// First position index from which a tile never leaves home again.
function lockIndices(positions, N) {
  const lock = new Array(N * N).fill(0);
  for (let t = 1; t < N * N; t++) {
    let i = positions.length - 1;
    while (i > 0 && positions[i - 1][t - 1] === t) i--;
    lock[t] = i;
  }
  return lock;
}

// Share of tile pairs finished in the order the method would finish them.
function agreement(groups, lock) {
  const rank = new Map();
  groups.forEach((g, k) => g.tiles.forEach((t) => rank.set(t, k)));
  const tiles = [...rank.keys()];
  let agree = 0,
    total = 0;
  for (const a of tiles)
    for (const b of tiles) {
      if (rank.get(a) >= rank.get(b)) continue;
      if (lock[a] === 0 || lock[b] === 0) continue; // home from the start says nothing
      if (lock[a] === lock[b]) continue; // placed by the same move
      total++;
      if (lock[a] < lock[b]) agree++;
    }
  return total ? agree / total : 1;
}

// How a solid human line would place a group: tile by tile, the last two of a line together.
export function chunks(group) {
  const t = group.tiles;
  if (group.kind !== "line" || t.length <= 2) return [t];
  return [...t.slice(0, -2).map((x) => [x]), t.slice(-2)];
}

// Moves the engine needs for each stage, starting from the position the player reached.
function engineLine(positions, N, stages) {
  if (N > 5) return null; // the pair search grows fast past 5x5
  const locked = new Uint8Array(N * N);
  return stages.map((s) => {
    let moves = [];
    try {
      const b = positions[s.from].slice();
      const lk = locked.slice();
      for (const c of chunks(s)) {
        moves.push(...E.placeGroup(b, N, c, lk)); // placeGroup moves b itself
        for (const t of c) lk[t - 1] = 1;
      }
    } catch (e) {
      moves = null;
    }
    for (const t of s.tiles) locked[t - 1] = 1;
    return moves;
  });
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Method read for one solve. Accepts a stored solve or one with movesArr/timesArr. */
export function readMethod(solve) {
  const { N } = solve;
  const moves = solve.movesArr || decodeMoves(solve.moves);
  const times = solve.timesArr || decodeTimes(solve.times);
  const M = moves.length;
  if (M < 4 || times.length !== M || moves.some((m) => !(m >= 0 && m <= 3)))
    return null;
  const positions = positionsFrom(solve.start, N, moves);
  const lock = lockIndices(positions, N);

  const all = methodsFor(N);
  const scored = Object.values(all)
    .map((m) => ({ ...m, match: agreement(m.groups, lock) }))
    .sort((a, b) => b.match - a.match);
  const best = scored[0];
  const freestyle = best.match < 0.72;

  // the player's rhythm: the gap they take on an ordinary move
  const gaps = times.map((t, i) => (i === 0 ? 0 : t - times[i - 1]));
  const pace = Math.max(60, median(gaps.slice(1)));
  const stallOver = pace * 2.5;

  // stages follow the matched method's groups, in the order the player finished them
  let prev = 0;
  const stages = best.groups.map((g) => {
    const end = Math.max(prev, ...g.tiles.map((t) => lock[t]));
    const s = { ...g, from: prev, to: end };
    prev = end;
    return s;
  });
  stages[stages.length - 1].to = M;

  // tiles the player put home and later pulled back out (scramble luck and the last three don't count)
  const lastTiles = new Set(stages[stages.length - 1].tiles);
  const placed = new Uint8Array(N * N);
  let undone = 0;
  const undoneBy = new Map();
  for (let i = 1; i < positions.length; i++) {
    const before = positions[i - 1],
      after = positions[i];
    for (let c = 0; c < N * N; c++) {
      const t = after[c];
      if (t && t === c + 1 && before[c] !== t) placed[t] = 1;
      const u = before[c];
      if (
        u &&
        u === c + 1 &&
        after[c] !== u &&
        placed[u] &&
        !lastTiles.has(u)
      ) {
        undone++;
        undoneBy.set(u, (undoneBy.get(u) || 0) + 1);
      }
    }
  }

  for (const s of stages) {
    s.moves = s.to - s.from;
    const t0 = s.from === 0 ? 0 : times[s.from - 1];
    const t1 = s.to === 0 ? 0 : times[s.to - 1];
    s.ms = Math.max(0, t1 - t0);
    let stall = 0,
      firstLook = 0;
    for (let i = s.from; i < s.to; i++) {
      const g = gaps[i];
      if (g > stallOver) stall += g - pace;
      if (i === s.from && i > 0 && g > stallOver) firstLook = g - pace;
    }
    s.stall = stall;
    s.firstLook = firstLook;
  }
  const line = engineLine(positions, N, stages);
  if (line)
    stages.forEach((s, i) => {
      s.engineMoves = line[i];
      s.engine = line[i] ? line[i].length : null;
    });

  const totalStall = stages.reduce((a, s) => a + s.stall, 0);
  return {
    N,
    M,
    duration: solve.duration,
    method: freestyle ? { id: "free", name: "Freestyle" } : best,
    closest: best,
    match: best.match,
    scored,
    stages,
    pace,
    stall: totalStall,
    undone,
    undoneTop: [...undoneBy.entries()].sort((a, b) => b[1] - a[1])[0] || null,
    lock,
  };
}

/* ---------- coaching ---------- */

const STAGE_TIP = {
  line: (s) => {
    const unit = s.name.startsWith("Column") ? "column" : "row";
    const next = unit === "row" ? "under" : "beside";
    return `Finish the last two tiles of ${s.name.toLowerCase()} as a pair: park the last tile in the ${unit}'s second last cell, bring the second last tile ${next} it, then turn both into place in one go.`;
  },
  "pair-col": (s) =>
    `Build ${s.name} as a vertical pair first, then slide the pair into its column. Placing them one at a time forces you to break the first one.`,
  "pair-row": (s) =>
    `Build ${s.name} as a side-by-side pair first, then slide the pair into place together.`,
  last: () =>
    "The last three tiles only cycle around the 2 by 2. Decide which way round they need to turn before you start, then do it in one smooth loop.",
};

// Turns one or more method reads into tips ranked by the seconds they cost.
export function coach(reads) {
  reads = reads.filter(Boolean);
  if (reads.length) reads = reads.filter((r) => r.N === reads[0].N);
  if (!reads.length) return null;
  const n = reads.length;
  const N = reads[0].N;
  const avg = (f) => reads.reduce((a, r) => a + f(r), 0) / n;

  const counts = new Map();
  for (const r of reads)
    counts.set(r.method.name, (counts.get(r.method.name) || 0) + 1);
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const consistent = usual[1] / n;

  // average each stage of the most common closest method
  const ids = new Map();
  for (const r of reads) ids.set(r.closest.id, (ids.get(r.closest.id) || 0) + 1);
  const refId = [...ids.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const ref = reads.find((r) => r.closest.id === refId).closest;
  const same = reads.filter((r) => r.closest.id === ref.id);
  const stages = ref.groups.map((g, k) => {
    const pick = (f) =>
      same.reduce((a, r) => a + f(r.stages[k]), 0) / same.length;
    const engine = same.every((r) => r.stages[k].engine != null)
      ? pick((s) => s.engine)
      : null;
    return {
      name: g.name,
      kind: g.kind,
      moves: pick((s) => s.moves),
      ms: pick((s) => s.ms),
      stall: pick((s) => s.stall),
      firstLook: pick((s) => s.firstLook),
      engine,
    };
  });
  const pace = avg((r) => r.pace);
  const duration = avg((r) => r.duration || 0);

  const tips = [];
  for (const s of stages) {
    if (s.engine == null) continue;
    const extra = s.moves - s.engine;
    if (extra >= 4)
      tips.push({
        cost: extra * pace,
        tone: "warn",
        title: `${s.name}: ${Math.round(extra)} moves over`,
        text: `${n > 1 ? "On average you" : "You"} take ${Math.round(s.moves)} moves here; a clean tile-by-tile line takes ${Math.round(s.engine)}. ${STAGE_TIP[s.kind](s)}`,
      });
  }
  const worstStall = stages.slice().sort((a, b) => b.stall - a.stall)[0];
  if (worstStall && worstStall.stall > 600) {
    const look = worstStall.firstLook > worstStall.stall * 0.45;
    tips.push({
      cost: worstStall.stall,
      tone: "warn",
      title: `Stops in ${worstStall.name.toLowerCase()}`,
      text: look
        ? `Most of the ${fmtTime(worstStall.stall)} s you stand still here comes right at the start, while you look for the next tiles. Find them while the previous stage is still finishing.`
        : `You stop for about ${fmtTime(worstStall.stall)} s in the middle of this stage. Plan the route for each tile before you move it rather than steering it one move at a time.`,
    });
  }
  const undone = avg((r) => r.undone);
  if (undone >= 3) {
    const top = reads
      .map((r) => r.undoneTop)
      .filter(Boolean)
      .sort((a, b) => b[1] - a[1])[0];
    tips.push({
      cost: undone * 2 * pace,
      tone: "warn",
      title: "Taking placed tiles back out",
      text: `You pull tiles out of their home cell about ${Math.round(undone)} times a solve${top ? `, tile ${top[0]} most of all` : ""}. Every time costs a round trip. Leave a tile parked next to its home until its partner is ready instead of placing it early.`,
    });
  }
  if (consistent < 0.6 && n >= 3)
    tips.push({
      cost: duration * 0.08,
      tone: "plain",
      title: "Pick one order",
      text: `Your placement order changes from solve to solve. Fixing one order (row 1, row 2, then the left columns as pairs, then the last three) makes the next tile automatic, so you stop searching.`,
    });
  else if (usual[0] === "Freestyle")
    tips.push({
      cost: duration * 0.08,
      tone: "plain",
      title: "No fixed order yet",
      text: "Tiles go home in a mixed order. Most fast solvers finish row 1, then row 2, then the left columns two tiles at a time, then the last three. It cuts the time you spend deciding what is next.",
    });
  tips.sort((a, b) => b.cost - a.cost);

  // the strong side, so the feedback is not only criticism
  const praise = [];
  const tight = stages.filter(
    (s) => s.engine != null && s.moves > 0 && s.moves - s.engine <= 1,
  );
  if (tight.length)
    praise.push(
      `${tight.map((s) => s.name).join(", ")} ${tight.length > 1 ? "are" : "is"} as tight as the engine's tile-by-tile line.`,
    );
  if (pace < 170)
    praise.push(
      `Your normal move takes ${Math.round(pace)} ms, which is quick fingers. Time is lost in stops, not in turning speed.`,
    );

  return {
    N,
    n,
    usual: usual[0] === "Freestyle" ? "Freestyle" : ref.name,
    consistent,
    closest: ref,
    match: avg((r) => r.match),
    stages,
    pace,
    stall: avg((r) => r.stall),
    duration,
    undone,
    tips: tips.slice(0, 4),
    read: n === 1 ? reads[0] : null,
    praise,
  };
}

/* ---------- rendering ---------- */

export function coachPanel(c, { single = false, onStage = null } = {}) {
  if (!c)
    return h(
      "p",
      { class: "muted" },
      "The coach needs a solve of at least a few moves.",
    );
  const head = h(
    "div",
    { class: "coach-head" },
    h("strong", { class: "coach-method" }, c.usual),
    h(
      "span",
      { class: "muted" },
      c.usual === "Freestyle"
        ? `Closest to ${c.closest.name.toLowerCase()} (${Math.round(c.match * 100)}% of tile pairs in that order)`
        : `${Math.round(c.match * 100)}% of tile pairs placed in that order` +
            (single ? "" : `, ${Math.round(c.consistent * 100)}% of ${c.n} solves`),
      ` · normal move ${Math.round(c.pace)} ms`,
    ),
  );
  const tips = h(
    "ul",
    { class: "insights" },
    ...c.tips.map((t) =>
      h(
        "li",
        { class: t.tone },
        h("span", null, h("b", null, t.title + ". "), t.text),
      ),
    ),
    ...c.praise.map((p) => h("li", { class: "good" }, p)),
  );
  const rows = c.stages.map((s) =>
    h(
      "tr",
      null,
      h("td", null, s.name),
      h("td", { class: "tnum" }, Math.round(s.moves)),
      h("td", { class: "tnum" }, s.engine != null ? Math.round(s.engine) : "-"),
      h("td", { class: "tnum" }, fmtTime(s.ms)),
      h("td", { class: "tnum" }, s.stall > 50 ? fmtTime(s.stall) : "-"),
    ),
  );
  const table = h(
    "div",
    { style: { overflowX: "auto" } },
    h(
      "table",
      { class: "ledger" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Stage"),
          h("th", { class: "tnum" }, single ? "Moves" : "Avg moves"),
          h("th", { class: "tnum" }, "Tile-by-tile line"),
          h("th", { class: "tnum" }, "Time"),
          h("th", { class: "tnum" }, "Stopped"),
        ),
      ),
      h("tbody", null, ...rows),
    ),
  );
  return h(
    "div",
    { class: "coach" },
    head,
    c.tips.length || c.praise.length
      ? tips
      : h("p", { class: "muted" }, "Nothing stands out. Clean solve."),
    table,
    single && onStage && c.read ? walkthrough(c.read, onStage) : null,
    h(
      "p",
      { class: "hint-text" },
      "The tile-by-tile line is the engine placing your stages the way a person would: one tile at a time, the last two of a line together, from the position you actually reached. Stopped counts time spent well above your normal move.",
    ),
  );
}

// Stage by stage: what you did, what the engine would do from the same spot.
function walkthrough(read, onStage) {
  const steps = read.stages
    .map((s, k) => ({ s, k }))
    .filter(({ s }) => s.moves > 0);
  return h(
    "div",
    { class: "stack" },
    h("h3", { class: "sub-title sub-title--small" }, "Step through it"),
    h(
      "ol",
      { class: "walk" },
      ...steps.map(({ s, k }) => {
        const extra = s.engine != null ? s.moves - s.engine : null;
        return h(
          "li",
          null,
          h(
            "div",
            { class: "walk-head" },
            h("strong", null, s.name),
            h(
              "span",
              { class: "muted tnum" },
              `You ${s.moves} moves in ${fmtTime(s.ms)} s` +
                (s.engine != null ? ` · engine ${s.engine}` : "") +
                (extra != null && extra > 0 ? ` · ${extra} over` : ""),
            ),
          ),
          s.engineMoves && s.engineMoves.length
            ? h(
                "p",
                { class: "moves-line" },
                "Engine: " + E.formatMoves(s.engineMoves, true),
              )
            : null,
          h(
            "div",
            { class: "actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn--small",
                onclick: () => onStage(k, "yours"),
              },
              "Watch yours",
            ),
            s.engineMoves && s.engineMoves.length
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn--small",
                    onclick: () => onStage(k, "engine"),
                  },
                  "Watch the engine's",
                )
              : null,
          ),
        );
      }),
    ),
  );
}
