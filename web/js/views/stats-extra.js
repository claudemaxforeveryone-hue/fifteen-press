// Two more pages for Stats: Visual (heatmaps and plots) and All stats (every number, sortable).
import { h, seg } from "../ui.js";
import { colourWords, cap } from "../themes.js";
import { fmtTime, mean } from "../stats.js";
import { deepOf, median, correlation } from "../deep.js";
import { decodeMoves, decodeTimes } from "../store.js";
import { lineChart } from "../charts.js";
import { planFor, averageSplits, splitsOf, legs } from "../steps.js";
import { METRICS, stageMetrics, rankOf, heatColor, inkColor, difficulty } from "../metrics.js";

const E = window.FifteenEngine;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function block(title, note, ...body) {
  return h(
    "section",
    { class: "stack stat-block stat-block--spaced" },
    h("h2", { class: "sub-title" }, title),
    note ? h("p", { class: "hint-text" }, note) : null,
    ...body,
  );
}

const sorted = (xs) => xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);

/* ================= Visual ================= */

export function visual(view, body, a, list) {
  const N = view.N;
  const target = ((view.store.settings.trainTarget || {})[N] || 0) * 1000 || null;

  /* ----- every solve on one line ----- */
  const times = list.map((s) => s.duration);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const span = Math.max(1, hi - lo);
  const x = (t) => ((t - lo) / span) * 100;
  const m = mean(times);
  const mark = (t, label, cls) =>
    t == null || t < lo || t > hi
      ? null
      : h("div", { class: "strip-mark " + (cls || ""), style: { left: x(t) + "%" } }, h("span", null, label));
  body.append(
    block(
      "Every solve on one line",
      "One tick per solve, placed by its time. Where the ticks pile up is your real pace.",
      h(
        "div",
        { class: "strip" },
        h(
          "div",
          { class: "strip-ticks" },
          ...list.slice(-1500).map((s) => h("i", { style: { left: x(s.duration) + "%" }, title: fmtTime(s.duration) })),
        ),
        mark(lo, "best " + fmtTime(lo), "is-best"),
        mark(m, "mean " + fmtTime(m)),
        target ? mark(target, "target " + fmtTime(target), "is-target") : null,
        h("div", { class: "strip-axis" }, h("span", null, fmtTime(lo)), h("span", null, fmtTime(hi))),
      ),
    ),
  );

  /* ----- clock heatmaps ----- */
  const count = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const total = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of list) {
    const d = new Date(s.date);
    const wd = (d.getDay() + 6) % 7;
    count[wd][d.getHours()]++;
    total[wd][d.getHours()] += s.duration;
  }
  const used = [];
  for (let hr = 0; hr < 24; hr++) if (count.some((row) => row[hr])) used.push(hr);
  const h0 = used.length ? Math.max(0, used[0] - 1) : 8;
  const h1 = used.length ? Math.min(23, used[used.length - 1] + 1) : 22;
  const hours = [];
  for (let hr = h0; hr <= h1; hr++) hours.push(hr);
  const maxCount = Math.max(1, ...count.flat());
  const means = [];
  for (let d = 0; d < 7; d++) for (const hr of hours) if (count[d][hr] >= 2) means.push(total[d][hr] / count[d][hr]);
  const meanSorted = sorted(means);
  const clock = (title, cellOf) =>
    h(
      "div",
      { class: "clock" },
      h("div", { class: "label" }, title),
      h(
        "div",
        { class: "clock-grid", style: { "--cols": hours.length } },
        h("span"),
        ...hours.map((hr) => h("span", { class: "clock-h" }, hr % 3 === 0 ? String(hr) : "")),
        ...DAYS.flatMap((name, d) => [h("span", { class: "clock-d" }, name), ...hours.map((hr) => cellOf(d, hr))]),
      ),
    );
  body.append(
    block(
      "When you play, and when you are fast",
      "Rows are weekdays, columns are hours of the day.",
      h(
        "div",
        { class: "clock-pair" },
        clock("Solves", (d, hr) =>
          h("i", {
            style: { background: count[d][hr] ? inkColor(0.12 + 0.88 * (count[d][hr] / maxCount)) : null },
            title: `${DAYS[d]} ${hr}:00 · ${count[d][hr]} solve${count[d][hr] === 1 ? "" : "s"}`,
          }),
        ),
        clock(`Average time (${colourWords().warm} is faster)`, (d, hr) => {
          const n = count[d][hr];
          const v = n >= 2 ? total[d][hr] / n : null;
          return h("i", {
            class: v == null && n ? "is-thin" : null,
            style: { background: v != null ? heatColor(rankOf(meanSorted, v), 0.9) : null },
            title: `${DAYS[d]} ${hr}:00 · ${n ? fmtTime(total[d][hr] / n) + " over " + n : "no solves"}`,
          });
        }),
      ),
    ),
  );

  /* ----- board heatmaps ----- */
  const cells = N * N;
  const stopsAt = new Array(cells).fill(0);
  const waitAt = new Array(cells).fill(0);
  const visits = new Array(cells).fill(0);
  const wrongAt = new Array(cells).fill(0);
  let graded = 0;
  const SLICES = 20;
  const paceRows = [];
  for (const s of list.slice(-400)) {
    if (!s.start) continue;
    const moves = decodeMoves(s.moves);
    const tms = decodeTimes(s.times);
    if (!moves.length || tms.length !== moves.length) continue;
    const dp = deepOf(s);
    const limit = Math.max(250, (dp.gapMedian || 0) * 3);
    let dist = null;
    if (s.dist && !s.distEstimate) {
      dist = s.dist.split(",").map((v) => (v === "" ? null : Number(v)));
      if (dp.graded) graded++;
      else dist = null;
    }
    let blank = s.start.indexOf(0);
    const slice = new Array(SLICES).fill(0);
    const sliceN = new Array(SLICES).fill(0);
    for (let i = 0; i < moves.length; i++) {
      const gap = i ? tms[i] - tms[i - 1] : null;
      if (gap != null) {
        visits[blank]++;
        waitAt[blank] += gap;
        if (gap >= limit) stopsAt[blank]++;
        const k = Math.min(SLICES - 1, Math.floor((i / moves.length) * SLICES));
        slice[k] += gap;
        sliceN[k]++;
      }
      if (dist && dist[i] != null && dist[i + 1] != null && dist[i + 1] >= dist[i]) wrongAt[blank]++;
      const n = E.neighbor(blank, moves[i], s.N);
      if (n < 0) break;
      blank = n;
    }
    paceRows.push({ s, v: slice.map((t, k) => (sliceN[k] ? t / sliceN[k] : null)) });
  }
  const boardMap = (title, note, vals, fmt, kind = "bad") => {
    const live = vals.filter((v) => v != null);
    const max = Math.max(1e-9, ...live);
    const sv = sorted(live);
    return h(
      "div",
      { class: "board-heat" },
      h("div", { class: "label" }, title),
      h(
        "div",
        { class: "board-heat-grid", style: { "--n": N } },
        ...vals.map((v, c) =>
          h(
            "div",
            {
              style: { background: v == null ? null : kind === "ink" ? inkColor(0.08 + 0.8 * (v / max)) : heatColor(rankOf(sv, v), 0.85) },
              title: `${c === cells - 1 ? "Corner spot" : "The " + (c + 1) + " spot"}: ${v == null ? "no data" : fmt(v)}`,
            },
            h("small", null, c === cells - 1 ? "" : c + 1),
            h("b", null, v == null ? "" : fmt(v)),
          ),
        ),
      ),
      h("p", { class: "hint-text" }, note),
    );
  };
  body.append(
    block(
      "Where on the board",
      "Each square is where the gap was sitting at that moment.",
      h(
        "div",
        { class: "board-heat-row" },
        boardMap("Stops", "How many of your stops happened with the gap here.", stopsAt, (v) => String(v), "ink"),
        boardMap(
          "Wait per visit",
          `Average pause before moving out of this square. ${cap(colourWords().cold)} squares are where you think longest.`,
          waitAt.map((t, c) => (visits[c] >= 5 ? t / visits[c] : null)),
          (v) => Math.round(v) + " ms",
        ),
        graded
          ? boardMap("Wrong-way moves", `Moves that did not get closer to solved, from ${graded} graded solves.`, wrongAt, (v) => String(v), "ink")
          : h("div", { class: "board-heat" }, h("div", { class: "label" }, "Wrong-way moves"), h("p", { class: "muted" }, "Needs solves graded by the engine (3×3 and 4×4).")),
      ),
    ),
  );

  /* ----- pace along the solve ----- */
  const rows = paceRows.slice(-36).reverse();
  if (rows.length) {
    const avgRow = [];
    for (let k = 0; k < SLICES; k++) {
      const col = paceRows.map((r) => r.v[k]).filter((v) => v != null);
      avgRow.push(col.length ? mean(col) : null);
    }
    const all = sorted(rows.flatMap((r) => r.v));
    const own = sorted(avgRow);
    const strip = (label, v, title, scale = all) =>
      h(
        "div",
        { class: "pace-row" },
        h("span", { class: "pace-label" }, label),
        ...v.map((x, k) =>
          h("i", {
            style: { background: x == null ? null : heatColor(rankOf(scale, x), 0.9) },
            title: `${title} · ${k * 5} to ${k * 5 + 5}% · ${x == null ? "-" : Math.round(x) + " ms a move"}`,
          }),
        ),
      );
    body.append(
      block(
        "Pace along the solve",
        `Left is the start of the solve, right is the end. ${cap(colourWords().cold)} is where you slow down. The top row is the average of all of them, shaded against itself so the slow part of your solve stands out.`,
        h(
          "div",
          { class: "pace-map" },
          strip("All", avgRow, "Average", own),
          h("div", { class: "pace-gap" }),
          ...rows.map((r) => strip(fmtTime(r.s.duration), r.v, fmtTime(r.s.duration))),
          h("div", { class: "pace-axis" }, h("span", null, "start"), h("span", null, "halfway"), h("span", null, "solved")),
        ),
      ),
    );
  }

  /* ----- stages ----- */
  if (N <= 5) {
    const plan = planFor(N, view.store.settings.coachMethod);
    const avg = averageSplits(list.slice(-100), plan);
    if (avg) {
      const fastList = list
        .slice(-100)
        .sort((p, q) => p.duration - q.duration)
        .slice(0, Math.max(1, Math.ceil(Math.min(100, list.length) / 4)));
      const fast = averageSplits(fastList, plan);
      const bestSolve = list.reduce((p, q) => (q.duration < p.duration ? q : p));
      const best = splitsOf(bestSolve, plan);
      const bars = [
        ["Average", avg.at],
        fast ? ["Quickest quarter", fast.at] : null,
        best ? ["Best solve", best] : null,
        target ? ["Target pace", avg.at.map((t) => t * (target / avg.at[avg.at.length - 1]))] : null,
      ].filter(Boolean);
      const full = Math.max(...bars.map((b) => b[1][b[1].length - 1]));
      body.append(
        block(
          "Where the time goes, stage by stage",
          `Stages of ${plan.name.toLowerCase()}. Bars share one scale, so a shorter bar is a faster solve.`,
          h(
            "div",
            { class: "stage-bars" },
            ...bars.map(([name, at]) =>
              h(
                "div",
                { class: "stage-bar-row" },
                h("span", { class: "stage-bar-name" }, name, h("small", null, fmtTime(at[at.length - 1]))),
                h(
                  "div",
                  { class: "stage-bar", style: { width: (at[at.length - 1] / full) * 100 + "%" } },
                  ...legs(at).map((leg, k) =>
                    h(
                      "i",
                      { style: { flexGrow: Math.max(0.0001, leg) }, class: "seg-" + (k % 2), title: `${plan.stages[k].name}: ${fmtTime(leg)}` },
                      h("span", null, plan.stages[k].name.replace(" and ", "+").replace("Last three", "Last 3")),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  /* ----- scatters ----- */
  const dots = (get) => list.map((s) => ({ x: get(s), y: s.duration / 1000 })).filter((p) => p.x != null);
  const diffDots = dots(difficulty);
  body.append(
    block(
      "Time against moves",
      "Each dot is a solve. A tight diagonal means time is mostly move count. Dots high above the rest had stops.",
      view.chart((el) =>
        lineChart(el, [{ name: "Solves", color: "var(--ink)", points: dots((s) => s.moveCount), dotsOnly: true }], {
          xLabel: "Moves",
          yLabel: "Seconds",
          height: 260,
          xMin: Math.min(...list.map((s) => s.moveCount)) - 2,
        }),
      ),
    ),
    block(
      "Time against scramble length",
      "A flat cloud means hard scrambles do not cost you much. A steep one means they do.",
      view.chart((el) =>
        lineChart(el, [{ name: "Solves", color: "var(--ink)", points: diffDots, dotsOnly: true }], {
          xLabel: "Scramble length",
          yLabel: "Seconds",
          height: 260,
          xMin: diffDots.length ? Math.min(...diffDots.map((p) => p.x)) - 1 : 0,
        }),
      ),
    ),
  );
}

/* ================= All stats ================= */

const COLS = [
  { key: "label", label: "Stat" },
  { key: "mean", label: "Mean" },
  { key: "median", label: "Median" },
  { key: "best", label: "Best" },
  { key: "worst", label: "Worst" },
  { key: "last", label: "Last 12" },
  { key: "change", label: "Change" },
  { key: "corr", label: "Link with time" },
];

export function allStats(view, body, a, list) {
  const st = view.allState || (view.allState = { key: null, dir: 1, query: "", group: "all" });
  const metrics = METRICS.concat(stageMetrics(view.N, view.store.settings.coachMethod));
  const rows = metrics
    .map((m) => {
      const pairs = list.map((s) => [m.get(s), s.duration]).filter((p) => p[0] != null && isFinite(p[0]));
      if (!pairs.length) return null;
      const vals = pairs.map((p) => p[0]);
      const sv = vals.slice().sort((x, y) => x - y);
      const lastN = vals.slice(-12);
      const before = vals.slice(0, -12);
      const r = { m, n: vals.length, mean: mean(vals), median: median(vals) };
      r.best = m.better === "high" ? sv[sv.length - 1] : sv[0];
      r.worst = m.better === "high" ? sv[0] : sv[sv.length - 1];
      r.last = mean(lastN);
      r.change = before.length >= 4 && mean(before) ? (r.last - mean(before)) / Math.abs(mean(before)) : null;
      // positive means it moved the good way
      r.gain = r.change == null || !m.better ? null : m.better === "low" ? -r.change : r.change;
      r.corr = m.key === "time" || pairs.length < 8 ? null : correlation(vals, pairs.map((p) => p[1]));
      return r;
    })
    .filter(Boolean);

  const groups = ["all", ...new Set(metrics.map((m) => m.group))];
  if (!groups.includes(st.group)) st.group = "all";
  const search = h("input", { class: "input", type: "search", placeholder: "Find a stat", value: st.query, "aria-label": "Find a stat" });
  const tableWrap = h("div", { class: "table-scroll" });
  const draw = () => {
    const q = st.query.trim().toLowerCase();
    let shown = rows.filter((r) => (st.group === "all" || r.m.group === st.group) && (!q || r.m.label.toLowerCase().includes(q) || r.m.group.toLowerCase().includes(q)));
    if (st.key) {
      const val = (r) => (st.key === "label" ? null : st.key === "change" ? r.gain ?? (r.change != null ? -Math.abs(r.change) : null) : st.key === "corr" ? (r.corr == null ? null : Math.abs(r.corr)) : r[st.key]);
      shown = shown.slice().sort((p, q2) => {
        if (st.key === "label") return p.m.label.localeCompare(q2.m.label) * st.dir;
        const x = val(p),
          y = val(q2);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x - y) * st.dir;
      });
    }
    const head = COLS.map((c, i) => {
      const on = st.key === c.key;
      return h(
        "th",
        { class: (i ? "tnum" : "") + (on ? " is-sorted" : "") },
        h(
          "button",
          {
            type: "button",
            class: "th-sort",
            onclick: () => {
              if (on && st.dir === (c.key === "label" ? -1 : 1)) st.key = null; // third click goes back to the grouped order
              else if (on) st.dir = -st.dir;
              else {
                st.key = c.key;
                st.dir = c.key === "label" ? 1 : -1;
              }
              draw();
            },
          },
          c.label,
          on ? (st.dir > 0 ? " ▲" : " ▼") : "",
        ),
      );
    });
    let lastGroup = null;
    const trs = [];
    for (const r of shown) {
      if (!st.key && r.m.group !== lastGroup) {
        lastGroup = r.m.group;
        trs.push(h("tr", { class: "group-row" }, h("td", { colspan: String(COLS.length) }, lastGroup)));
      }
      const f = r.m.fmt;
      const ch =
        r.change == null
          ? "-"
          : (r.change > 0 ? "+" : r.change < 0 ? "-" : "") + Math.abs(r.change * 100).toFixed(Math.abs(r.change) < 0.1 ? 1 : 0) + "%";
      const strong = r.corr != null && Math.abs(r.corr) >= 0.5;
      trs.push(
        h(
          "tr",
          null,
          h("td", null, r.m.label, r.m.note ? h("div", { class: "fact-note" }, r.m.note) : null),
          h("td", { class: "tnum" }, f(r.mean)),
          h("td", { class: "tnum" }, f(r.median)),
          h("td", { class: "tnum" }, r.m.better ? f(r.best) : f(Math.min(r.best, r.worst))),
          h("td", { class: "tnum" }, r.m.better ? f(r.worst) : f(Math.max(r.best, r.worst))),
          h("td", { class: "tnum" }, f(r.last)),
          h(
            "td",
            { class: "tnum" + (r.gain == null || Math.abs(r.change) < 0.02 ? "" : r.gain > 0 ? " is-ahead" : " is-behind"), title: r.gain == null ? null : r.gain > 0 ? "Better than before" : "Worse than before" },
            ch,
          ),
          h(
            "td",
            { class: "tnum corr-cell", title: r.corr == null ? null : "Correlation with solve time, from -1 to +1" },
            r.corr == null
              ? "-"
              : [h("i", { class: "corr-bar" + (r.corr < 0 ? " is-neg" : ""), style: { width: Math.round(Math.abs(r.corr) * 48) + "px" } }), h("span", { class: strong ? "is-strong" : null }, (r.corr > 0 ? "+" : "") + r.corr.toFixed(2))],
          ),
        ),
      );
    }
    tableWrap.replaceChildren(
      h("table", { class: "ledger ledger--facts ledger--all" }, h("thead", null, h("tr", null, ...head)), h("tbody", null, ...trs)),
      shown.length ? "" : h("p", { class: "muted" }, "No stat matches."),
    );
  };
  search.addEventListener("input", () => {
    st.query = search.value;
    draw();
  });
  body.append(
    block(
      `Every stat, ${list.length} solve${list.length === 1 ? "" : "s"}`,
      "Click a heading to sort. Best and Worst follow what is good for that stat. Change compares your last 12 solves with everything before them. Link with time runs from -1 to +1: a stat near +1 rises and falls with your time, so that is the one to work on.",
      h(
        "div",
        { class: "filters filters--tools" },
        h("label", { class: "field" }, h("span", null, "Find"), search),
        h(
          "div",
          { class: "field" },
          h("span", null, "Group"),
          seg(
            groups.map((g) => ({ value: g, label: g === "all" ? "All" : g })),
            st.group,
            (v) => {
              st.group = v;
              draw();
            },
            "Group",
          ),
        ),
      ),
      tableWrap,
    ),
  );
  draw();
}
