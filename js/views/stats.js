import { rollingSeries, tps, efficiency, fmtTime, habits } from "../stats.js";
import {
  aggregate,
  deepOf,
  describe,
  sessions,
  byDay,
  dayStreaks,
  byWeekday,
  byHour,
  byMode,
  histogram,
  rolling,
  fmtMs,
  fmtDuration,
  AVERAGE_SIZES,
} from "../deep.js";
import { mean } from "../stats.js";
const meanOf = mean;
import { lineChart, barChart, legend } from "../charts.js";
import { h, clear, seg, relDate, downloadFile, toast } from "../ui.js";
import { readMethod, coach, coachPanel } from "../method.js";
import { visual as visualTab, allStats as allStatsTab } from "./stats-extra.js";
import { gradeAll, stopGrading, onGrader, status as graderStatus, needsGrading } from "../grader.js";

// The everyday tabs sit in the row. The deep ones are one click further, under "More".
const TABS_MAIN = [
  { value: "overview", label: "Overview" },
  { value: "records", label: "Records" },
  { value: "log", label: "Log" },
];
const TABS_MORE = [
  { value: "times", label: "Times" },
  { value: "moves", label: "Moves" },
  { value: "visual", label: "Visual" },
  { value: "all", label: "All stats" },
  { value: "engine", label: "Engine line" },
  { value: "pace", label: "Time per move" },
  { value: "habits", label: "Habits" },
  { value: "sessions", label: "Sessions" },
  { value: "coach", label: "Coach" },
];
const TABS = TABS_MAIN.concat(TABS_MORE);
const isMore = (tab) => TABS_MORE.some((t) => t.value === tab);

const PERIODS = [
  { value: "all", label: "All time" },
  { value: "session", label: "This session" },
  { value: "today", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

const pct = (x, digits = 0) => (x == null || !isFinite(x) ? "-" : (x * 100).toFixed(digits) + "%");
const num = (x, digits = 0) => (x == null || !isFinite(x) ? "-" : x.toFixed(digits));
const day = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dayYear = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function cell(label, value, sub) {
  return h(
    "div",
    null,
    h("div", { class: "label" }, label),
    h("div", { class: "figure" }, value),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

/** Label and value rows, the workhorse of every tab. */
function facts(rows, head) {
  return h(
    "table",
    { class: "ledger ledger--facts" },
    head
      ? h("thead", null, h("tr", null, ...head.map((x, i) => h("th", { class: i ? "tnum" : null }, x))))
      : null,
    h(
      "tbody",
      null,
      ...rows
        .filter(Boolean)
        .map((r) =>
          h(
            "tr",
            null,
            h("td", null, r[0], r.note ? h("div", { class: "fact-note" }, r.note) : null),
            ...r.slice(1).map((v) => h("td", { class: "tnum" }, v)),
          ),
        ),
    ),
  );
}

function block(title, note, ...body) {
  return h(
    "section",
    { class: "stack stat-block" },
    h("h2", { class: "sub-title" }, title),
    note ? h("p", { class: "hint-text" }, note) : null,
    ...body,
  );
}

export class StatsView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.N = null;
    this.tab = "overview";
    this.period = "all";
    this.mode = "all";
    this.includeAll = false;
    this.logSort = { key: "n", dir: -1 };
    this.logLimit = 50;
    this.renderTimer = 0;
    onGrader((st) => this.onGrader(st));
  }

  show(param) {
    if (param && TABS.some((t) => t.value === param)) this.tab = param;
    this.render();
    this.maybeGrade();
  }

  onStore(e) {
    if (this.root.hidden || e.type === "settings") return;
    if (e.type === "solve-updated") {
      clearTimeout(this.renderTimer);
      this.renderTimer = setTimeout(() => !this.root.hidden && this.render(), 400);
      return;
    }
    this.render();
  }

  onGrader(st) {
    if (this.root.hidden) return;
    if (this.gradeLine) this.gradeLine.textContent = this.gradeText(st);
    // refresh the numbers now and then while a long queue runs
    if (st.running && st.done && st.done % 10 === 0 && this.tab === "engine") this.render();
  }

  maybeGrade() {
    if (this.store.settings.autoGrade) gradeAll(this.store.state.activeProfile);
  }

  gradeText(st = graderStatus()) {
    const mine = this.store
      .solves({ profileId: this.store.state.activeProfile })
      .filter((s) => s.N <= 4);
    const left = mine.filter(needsGrading).length;
    if (st.running && st.total)
      return `Grading solves against the engine: ${st.done} of ${st.total} done.`;
    if (!mine.length) return "The engine grades 3×3 and 4×4 solves move by move.";
    return left
      ? `${mine.length - left} of ${mine.length} solves graded move by move. ${left} left.`
      : `All ${mine.length} of your 3×3 and 4×4 solves are graded move by move.`;
  }

  /* ---------- data ---------- */

  pick() {
    const base = this.store.solves({
      profileId: this.store.state.activeProfile,
      N: this.N,
      clean: this.includeAll ? null : true,
    });
    let list = this.mode === "all" ? base : base.filter((s) => s.mode === this.mode);
    const now = Date.now();
    if (this.period === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      list = list.filter((s) => s.date >= d.getTime());
    } else if (this.period === "7" || this.period === "30") {
      list = list.filter((s) => s.date >= now - Number(this.period) * 86400000);
    } else if (this.period === "session") {
      const ss = sessions(list);
      list = ss.length ? ss[ss.length - 1].solves : [];
    }
    return { base, list };
  }

  /* ---------- frame ---------- */

  render() {
    clear(this.root);
    const mine = this.store.solves({ profileId: this.store.state.activeProfile });
    const sizes = [...new Set(mine.map((s) => s.N))].sort((a, b) => a - b);
    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title", title: "Averages drop the best and worst 5%, the way speedsolvers count them." }, "Stats"),
        ),
      ),
    );
    if (!mine.length) {
      this.root.append(
        h(
          "div",
          { class: "empty panel" },
          h("strong", null, "Nothing logged yet"),
          "Times, averages, engine comparisons and time per move show up after the first solve.",
          h("div", { style: { marginTop: "16px" } }, h("a", { class: "btn btn--primary", href: "#play" }, "Go play")),
        ),
      );
      return;
    }
    if (!this.N || !sizes.includes(this.N))
      this.N = sizes.includes(this.store.settings.size) ? this.store.settings.size : sizes[0];

    const allToggle = h("input", { type: "checkbox", checked: this.includeAll, id: "stats-include-all" });
    allToggle.addEventListener("change", () => {
      this.includeAll = allToggle.checked;
      this.render();
    });
    const modes = [...new Set(mine.filter((s) => s.N === this.N).map((s) => s.mode))];
    if (this.mode !== "all" && !modes.includes(this.mode)) this.mode = "all";
    const again = (key) => (v) => {
      this[key] = v;
      this.logLimit = 50;
      this.render();
    };
    this.root.append(
      h(
        "div",
        { class: "filters" },
        seg(sizes.map((n) => ({ value: n, label: n + "×" + n })), this.N, again("N"), "Board size"),
        seg(PERIODS, this.period, again("period"), "Period"),
        (() => {
          const d = h(
            "details",
            { class: "more filters-more" },
            h("summary", null, "Filters"),
            h(
              "div",
              { class: "more-body" },
              modes.length > 1
                ? seg(
                    [{ value: "all", label: "Every scramble" }].concat(
                      modes.map((m) => ({
                        value: m,
                        label: { random: "Random", daily: "Daily", seed: "Seed", custom: "Custom" }[m] || m,
                      })),
                    ),
                    this.mode,
                    again("mode"),
                    "Scramble type",
                  )
                : null,
              h("label", { class: "switch-row" }, allToggle, h("span", { class: "switch-text" }, "Count practice, hinted and modded solves too")),
            ),
          );
          // a filter in use keeps the row open. otherwise it is as the reader left it
          const inUse = this.mode !== "all" || this.includeAll;
          d.open = !!this.filtersOpen || inUse;
          d.addEventListener("toggle", () => {
            if (!inUse) this.filtersOpen = d.open;
          });
          return d;
        })(),
      ),
      h(
        "div",
        { class: "tabs" },
        seg(
          TABS_MAIN.concat([{ value: "more", label: "More" }]),
          isMore(this.tab) ? "more" : this.tab,
          (v) => again("tab")(v !== "more" ? v : isMore(this.tab) ? this.tab : TABS_MORE[0].value),
          "Stats section",
        ),
        isMore(this.tab) ? seg(TABS_MORE, this.tab, again("tab"), "More stats") : null,
      ),
    );

    const { base, list } = this.pick();
    if (!list.length) {
      this.root.append(
        h(
          "p",
          { class: "muted" },
          base.length
            ? "No solves in this period. Pick a wider one above."
            : "No clean solves at this size yet. Open Filters above to count assisted ones.",
        ),
      );
      return;
    }
    const a = aggregate(list);
    const body = h("div", { class: "stat-body" });
    this.root.append(body);
    this.charts = [];
    this[this.tab](body, a, list);
    requestAnimationFrame(() => {
      for (const draw of this.charts) {
        try {
          draw();
        } catch (e) {
          console.warn(e);
        }
      }
    });
  }

  chart(draw) {
    const el = h("div");
    this.charts.push(() => draw(el));
    return el;
  }

  visual(body, a, list) {
    visualTab(this, body, a, list);
  }

  all(body, a, list) {
    allStatsTab(this, body, a, list);
  }

  /* ---------- overview ---------- */

  overview(body, a, list) {
    const ao = (k) => a.averages.find((x) => x.n === k);
    const biggest = [...a.averages].reverse().find((x) => x.current != null);
    body.append(
      // the six that answer "how fast am I": everything else is one tab away
      h(
        "div",
        { class: "specimen specimen--6" },
        cell("Best single", fmtTime(a.time.min), a.lastRank ? `last ${fmtTime(list[list.length - 1].duration)}, ${ordinal(a.lastRank)} of ${a.n}` : null),
        cell("Ao5", fmtTime(ao(5).current), ao(5).best != null ? "best " + fmtTime(ao(5).best) : "needs 5 solves"),
        cell("Ao12", fmtTime(ao(12).current), ao(12).best != null ? "best " + fmtTime(ao(12).best) : "needs 12 solves"),
        biggest && biggest.n > 12
          ? cell("Ao" + biggest.n, fmtTime(biggest.current), "best " + fmtTime(biggest.best))
          : cell("Ao50", "-", "needs 50 solves"),
        cell("Mean", fmtTime(a.time.mean), "median " + fmtTime(a.time.median)),
        cell("Solves", a.n, fmtDuration(a.time.sum) + " at the board"),
      ),
      h("div", { class: "gap-32" }),
      block("Times", null, this.timeChart(list)),
      h("div", { class: "gap-32" }),
      this.fastestBlock(list),
      h(
        "p",
        { class: "hint-text", style: { marginTop: "12px" } },
        h("a", { href: "#solves/fastest" }, "Every solve"),
        " is on the Solves page. Every other number is in ",
        h("a", { href: "#stats/all" }, "all stats"),
        ".",
      ),
      this.sizeCount() > 1 ? h("div", { class: "gap-32" }) : null,
      this.sizeCount() > 1
        ? block("Every size", null, this.sizeTable())
        : null,
    );
  }

  // Your quickest solves in this view, best first. Each row opens its proof.
  fastestBlock(list) {
    const top = list
      .slice()
      .sort((x, y) => x.duration - y.duration)
      .slice(0, 5);
    return block(
      "Fastest solves",
      null,
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "ledger ledger--fastest" },
          h(
            "thead",
            null,
            h("tr", null, ...["#", "Time", "Moves", "TPS", "When"].map((x, i) => h("th", { class: i && i < 4 ? "tnum" : null }, x))),
          ),
          h(
            "tbody",
            null,
            ...top.map((s, i) =>
              h(
                "tr",
                { class: "is-link", title: "Open the proof", onclick: () => this.ctx.app.go("proofs", s.id) },
                h("td", { class: "rank" }, i + 1),
                h("td", { class: "tnum fastest-time" + (i === 0 ? " is-key" : "") }, fmtTime(s.duration)),
                h("td", { class: "tnum" }, s.moveCount),
                h("td", { class: "tnum" }, num(tps(s), 2)),
                h("td", null, dayYear(s.date)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  sizeCount() {
    return new Set(this.store.solves({ profileId: this.store.state.activeProfile, clean: true }).map((s) => s.N)).size;
  }

  sizeTable() {
    const mine = this.store.solves({ profileId: this.store.state.activeProfile, clean: true });
    const sizes = [...new Set(mine.map((s) => s.N))].sort((x, y) => x - y);
    const rows = sizes.map((N) => {
      const l = mine.filter((s) => s.N === N);
      const t = l.map((s) => s.duration);
      const d = describe(t);
      return [
        `${N}×${N}`,
        l.length,
        fmtTime(d.min),
        fmtTime(d.mean),
        fmtTime(rolling(t, 5).best),
        fmtTime(rolling(t, 12).best),
      ];
    });
    return h(
      "div",
      { class: "scroll-x" },
      facts(rows, ["Size", "Solves", "Best", "Mean", "Best ao5", "Best ao12"]),
    );
  }

  timeChart(list) {
    return this.chart((el) => {
      const times = list.map((x) => x.duration / 1000);
      const a5 = rollingSeries(times, 5),
        a12 = rollingSeries(times, 12),
        a50 = rollingSeries(times, 50);
      const series = [
        { name: "Single", color: "var(--ink-3)", points: times.map((y, i) => ({ x: i + 1, y })), dotsOnly: true, r: 2.5 },
      ];
      const items = [{ name: "Single", color: "var(--ink-3)", dot: true }];
      if (list.length >= 5) {
        series.push({ name: "Ao5", color: "var(--chart-a)", points: a5.map((y, i) => ({ x: i + 1, y })) });
        items.push({ name: "Ao5", color: "var(--chart-a)" });
      }
      if (list.length >= 12) {
        series.push({ name: "Ao12", color: "var(--chart-b)", points: a12.map((y, i) => ({ x: i + 1, y })) });
        items.push({ name: "Ao12", color: "var(--chart-b)" });
      }
      if (list.length >= 50) {
        series.push({ name: "Ao50", color: "var(--ink)", points: a50.map((y, i) => ({ x: i + 1, y })), dash: true });
        items.push({ name: "Ao50", color: "var(--ink)", dash: true });
      }
      lineChart(el, series, {
        height: 260,
        xLabel: "solve",
        yLabel: "seconds",
        xMin: 1,
        xMax: Math.max(2, list.length),
        yMin: 0,
        tipFor: (x) => {
          const sv = list[x - 1];
          if (!sv) return null;
          return (
            `<b>Solve ${x}</b>, ${relDate(sv.date)}<br>${fmtTime(sv.duration)}s, ${sv.moveCount} moves` +
            (a5[x - 1] != null ? `<br>ao5 ${fmtTime(a5[x - 1] * 1000)}` : "") +
            (a12[x - 1] != null ? `<br>ao12 ${fmtTime(a12[x - 1] * 1000)}` : "")
          );
        },
        onPick: (x) => list[x - 1] && this.ctx.app.go("proofs", list[x - 1].id),
      });
      if (items.length > 1) legend(el, items);
    });
  }

  /* ---------- times ---------- */

  times(body, a, list) {
    const t = a.time;
    const when = (i) => (i != null && list[i] ? day(list[i].date) : "");
    const avgRows = [["Mo3", fmtTime(a.mo3.current), fmtTime(a.mo3.best), fmtTime(a.mo3.worst), when(a.mo3.bestAt)]].concat(
      a.averages.map((x) => [
        "Ao" + x.n,
        fmtTime(x.current),
        fmtTime(x.best),
        fmtTime(x.worst),
        x.best != null ? when(x.bestAt) : `needs ${x.n}`,
      ]),
    );
    const last = list[list.length - 1].duration;
    const faster = list.filter((s) => s.duration > last).length;
    body.append(
      h(
        "div",
        { class: "cols" },
        block(
          "The spread",
          "Every clean time in this view, summed up.",
          facts([
            ["Best", fmtTime(t.min)],
            ["Worst", fmtTime(t.max)],
            ["Mean", fmtTime(t.mean)],
            ["Median", fmtTime(t.median)],
            ["Usual swing", "±" + fmtTime(t.sd)],
            ["Fastest 10%", "under " + fmtTime(t.p10)],
            ["Slowest 10%", "over " + fmtTime(t.p90)],
            ["Total time solving", fmtDuration(t.sum)],
            Object.assign(
              ["Last solve", `${fmtTime(last)}, ${ordinal(a.lastRank)} of ${a.n}`],
              { note: a.n > 1 ? `faster than ${pct(faster / (a.n - 1))} of your other solves` : null },
            ),
          ]),
        ),
        block(
          "Averages",
          "Current, best and worst for every window. Mo3 is a plain mean of three.",
          h("div", { class: "scroll-x" }, facts(avgRows, ["Window", "Current", "Best", "Worst", "Best set on"])),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Distribution",
          "How many solves landed in each time band.",
          this.chart((el) => {
            const hist = histogram(list.map((s) => s.duration / 1000), 18);
            barChart(el, hist.bins, {
              height: 220,
              color: "var(--chart-a)",
              xLabel: "seconds",
              yLabel: "solves",
              xFmt: (v) => trim(hist.bins[0].from + v * hist.width),
              tipFor: (b) =>
                `<b>${trim(b.from ?? hist.bins[0].from + b.x * hist.width)} to ${trim((b.from ?? hist.bins[0].from + b.x * hist.width) + hist.width)} s</b><br>${b.value} solve${b.value === 1 ? "" : "s"}`,
            });
          }),
        ),
        block(
          "Barriers",
          "How often you get under each mark, and when you first did.",
          a.subs.length
            ? facts(
                a.subs.map((s) => [
                  "Sub-" + s.sec,
                  s.count,
                  pct(s.share),
                  s.first ? day(s.first.date) : "not yet",
                ]),
                ["Mark", "Solves", "Share", "First time"],
              )
            : h("p", { class: "muted" }, "Needs a few more solves."),
        ),
      ),
      h("div", { class: "gap-32" }),
      block("Over time", "Each dot is a solve. Click one to open its proof.", this.timeChart(list)),
    );
  }

  /* ---------- moves ---------- */

  moves(body, a, list) {
    const m = a.moves;
    const dirTotal = a.shape.dirs.reduce((x, y) => x + y, 0) || 1;
    // blank directions U D L R are tile directions down, up, right, left
    const dirNames = ["Down", "Up", "Right", "Left"];
    body.append(
      h(
        "div",
        { class: "cols" },
        block(
          "Move counts",
          "Single-tile moves per solve.",
          facts([
            ["Fewest", m.min],
            ["Most", m.max],
            ["Mean", num(m.mean, 1)],
            ["Median", num(m.median, 1)],
            ["Standard deviation", num(m.sd, 1)],
            ["Fewest 10%", "under " + num(m.p10)],
            ["Most 10%", "over " + num(m.p90)],
            ["Total tiles slid", m.sum.toLocaleString()],
            ...a.moveAverages.map((x) => [
              `Mean of ${x.n}`,
              x.current != null ? `${num(x.current, 1)} now, best ${num(x.best, 1)}` : `needs ${x.n}`,
            ]),
          ]),
        ),
        block(
          "Hand speed",
          "Tiles per second, solve by solve.",
          facts([
            ["Best", num(a.tps.max, 2)],
            ["Slowest", num(a.tps.min, 2)],
            ["Mean", num(a.tps.mean, 2)],
            ["Median", num(a.tps.median, 2)],
            Object.assign(["Overall", num(a.tps.overall, 2)], { note: "every tile divided by all the time" }),
            Object.assign(["Fastest 10-move burst", num(a.pace.burst.max, 1)], {
              note: a.pace.burst.mean != null ? `typical burst ${num(a.pace.burst.mean, 1)}` : null,
            }),
            ["Standard deviation", num(a.tps.sd, 2)],
          ]),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Move count distribution",
          null,
          this.chart((el) => {
            const hist = histogram(list.map((s) => s.moveCount), 16);
            barChart(el, hist.bins, {
              height: 210,
              color: "var(--chart-b)",
              xLabel: "moves",
              yLabel: "solves",
              xFmt: (v) => trim(hist.bins[0].from + v * hist.width),
              tipFor: (b) =>
                `<b>${trim(hist.bins[0].from + b.x * hist.width)} to ${trim(hist.bins[0].from + (b.x + 1) * hist.width - 1)} moves</b><br>${b.value} solve${b.value === 1 ? "" : "s"}`,
            });
          }),
        ),
        block(
          "Moves and speed over time",
          null,
          this.chart((el) => {
            const mv = rollingMean(list.map((s) => s.moveCount), 5);
            lineChart(
              el,
              [
                { name: "Moves", color: "var(--ink-3)", points: list.map((s, i) => ({ x: i + 1, y: s.moveCount })), dotsOnly: true, r: 2.5 },
                { name: "Mean of 5", color: "var(--chart-b)", points: mv.map((y, i) => ({ x: i + 1, y })) },
              ],
              {
                height: 210,
                xMin: 1,
                xMax: Math.max(2, list.length),
                xLabel: "solve",
                yLabel: "moves",
                tipFor: (x) =>
                  list[x - 1] ? `<b>Solve ${x}</b><br>${list[x - 1].moveCount} moves, ${tps(list[x - 1]).toFixed(2)} TPS` : null,
              },
            );
            legend(el, [
              { name: "Moves", color: "var(--ink-3)", dot: true },
              { name: "Mean of 5", color: "var(--chart-b)" },
            ]);
          }),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Tiles per second over time",
          null,
          this.chart((el) => {
            const tp = list.map(tps);
            const r = rollingMean(tp, 5);
            lineChart(
              el,
              [
                { name: "TPS", color: "var(--ink-3)", points: tp.map((y, i) => ({ x: i + 1, y })), dotsOnly: true, r: 2.5 },
                { name: "Mean of 5", color: "var(--chart-a)", points: r.map((y, i) => ({ x: i + 1, y })) },
              ],
              {
                height: 210,
                xMin: 1,
                xMax: Math.max(2, list.length),
                xLabel: "solve",
                yLabel: "tiles per second",
                tipFor: (x) => (list[x - 1] ? `<b>Solve ${x}</b><br>${tp[x - 1].toFixed(2)} TPS` : null),
              },
            );
          }),
        ),
        block(
          "Shape of your moves",
          "Read from the move order of every solve.",
          facts([
            Object.assign(["Take-backs per solve", num(a.shape.backtracks.mean, 1)], {
              note: "a move undone by the very next one; each pair is two wasted moves",
            }),
            ["Most take-backs in one solve", a.shape.backtracks.max],
            Object.assign(["Turn rate", pct(a.shape.turnRate.mean)], {
              note: "share of moves that change between sideways and up or down",
            }),
            ["Longest straight run", a.shape.longestRun.max + " tiles"],
            ...a.shape.dirs.map((c, i) => [`Tiles moved ${dirNames[i].toLowerCase()}`, pct(c / dirTotal)]),
          ]),
        ),
      ),
    );
  }

  /* ---------- engine line ---------- */

  engine(body, a, list) {
    const e = a.engine;
    const st = graderStatus();
    this.gradeLine = h("span", null, this.gradeText(st));
    const left = this.store
      .solves({ profileId: this.store.state.activeProfile })
      .filter(needsGrading).length;
    body.append(
      h(
        "div",
        { class: "grade-bar" },
        this.gradeLine,
        left && !st.running
          ? h(
              "button",
              {
                class: "btn btn--small",
                type: "button",
                onclick: () => {
                  gradeAll(this.store.state.activeProfile);
                  this.render();
                },
              },
              "Grade the rest",
            )
          : null,
        st.running
          ? h(
              "button",
              {
                class: "btn btn--small btn--ghost",
                type: "button",
                onclick: () => {
                  stopGrading();
                  this.render();
                },
              },
              "Stop",
            )
          : null,
      ),
    );
    if (this.N > 4) {
      body.append(
        h(
          "p",
          { class: "muted" },
          `The engine only proves optimal lines up to 4×4, so ${this.N}×${this.N} solves have no engine comparison.`,
        ),
      );
      return;
    }
    if (!e.known) {
      body.append(h("p", { class: "muted" }, "No solve here has its optimal length yet. It fills in a moment after each solve."));
      return;
    }
    const stronger =
      e.rMovesTime != null && e.rTpsTime != null
        ? Math.abs(e.rMovesTime) >= Math.abs(e.rTpsTime)
          ? `Your times follow your move count (r ${num(e.rMovesTime, 2)}) more than your hand speed (r ${num(e.rTpsTime, 2)}). Shorter solutions are where the time is.`
          : `Your times follow your hand speed (r ${num(e.rTpsTime, 2)}) more than your move count (r ${num(e.rMovesTime, 2)}). Faster fingers are where the time is.`
        : null;
    body.append(
      h(
        "div",
        { class: "specimen specimen--5" },
        cell("Efficiency", pct(e.overallEfficiency, 1), "engine moves divided by yours, all solves"),
        cell("Extra moves", num(e.excess.mean, 1), `per solve, median ${num(e.excess.median)}`),
        cell("Engine line", num(e.optimal.mean, 1), `moves needed on average, you used ${num(e.totalMoves / e.known, 1)}`),
        cell(
          "Accuracy",
          pct(e.overallAccuracy, 1),
          e.gradedCount ? "moves that got closer to solved" : "grading in progress",
        ),
        cell(
          "Time lost",
          fmtMs(e.lostMs.mean),
          "per solve to moves the engine would not make",
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "You against the engine",
          `From ${e.known} solve${e.known === 1 ? "" : "s"} with a proven optimal length.`,
          facts([
            ["Best efficiency", pct(e.efficiency.max, 1)],
            ["Worst efficiency", pct(e.efficiency.min, 1)],
            ["Mean efficiency", pct(e.efficiency.mean, 1)],
            ["Median efficiency", pct(e.efficiency.median, 1)],
            ["Fewest extra moves", e.excess.min],
            ["Most extra moves", e.excess.max],
            ["Extra moves in total", e.totalExcess.toLocaleString()],
            Object.assign(["Perfect solves", `${e.perfect} of ${e.known}`], { note: "exactly as short as the engine" }),
            ["Within 10% of the engine", `${e.within10} of ${e.known}`],
            Object.assign(["Engine-line time", fmtTime(e.engineLineMs.mean)], {
              note: "your mean time if you made only the engine's moves at your own pace",
            }),
            Object.assign(["Time per needed move", fmtMs(e.msPerOptimal.mean)], {
              note: "your time divided by the engine's move count; fair across easy and hard scrambles",
            }),
            ["Hardest scramble solved", e.optimal.max + " moves"],
            ["Easiest scramble solved", e.optimal.min + " moves"],
          ]),
        ),
        block(
          "Move by move",
          e.gradedCount
            ? `From ${e.gradedCount} graded solve${e.gradedCount === 1 ? "" : "s"}. A wrong-way move leaves you one further from solved.`
            : "Fills in as the engine grades each position of each solve.",
          e.gradedCount
            ? facts([
                ["Moves graded", e.gradedMoves.toLocaleString()],
                ["Moved closer", `${e.good.toLocaleString()} (${pct(e.good / e.gradedMoves, 1)})`],
                ["Went the wrong way", `${e.bad.toLocaleString()} (${pct(e.bad / e.gradedMoves, 1)})`],
                ["Wrong-way moves per solve", `${num(e.wrongWay.mean, 1)}, median ${num(e.wrongWay.median)}`],
                Object.assign(["Inaccuracies", e.inaccuracies], { note: "one wrong-way move on its own" }),
                Object.assign(["Mistakes", e.mistakes], { note: "two or three in a row" }),
                Object.assign(["Blunders", e.blunders], { note: "four or more in a row" }),
                ["Best accuracy in a solve", pct(e.accuracy.max, 1)],
                ["Worst accuracy in a solve", pct(e.accuracy.min, 1)],
                Object.assign(["Longest clean run", e.cleanStreak.max + " moves"], {
                  note: `typical best run ${num(e.cleanStreak.median)} moves on the engine's line`,
                }),
                Object.assign(["First slip", "move " + num(e.firstError.median)], {
                  note: "the median move number of your first wrong-way move",
                }),
                Object.assign(["Think before a good move", fmtMs(e.thinkGood.mean)], { note: "gap before moves that got closer" }),
                Object.assign(["Think before a wrong move", fmtMs(e.thinkBad.mean)], {
                  note:
                    e.thinkBad.mean != null && e.thinkGood.mean != null
                      ? e.thinkBad.mean > e.thinkGood.mean * 1.15
                        ? "you slow down before the wrong ones: hesitation is a warning sign"
                        : e.thinkBad.mean < e.thinkGood.mean * 0.87
                          ? "you rush the wrong ones: they come from moving before looking"
                          : "about the same as before a good one"
                      : null,
                }),
              ])
            : h("p", { class: "muted" }, "Nothing graded in this view yet."),
        ),
      ),
      stronger || e.rLengthTime != null
        ? h(
            "div",
            { class: "takeaways" },
            stronger ? h("p", null, stronger) : null,
            e.rLengthTime != null
              ? h(
                  "p",
                  null,
                  Math.abs(e.rLengthTime) < 0.2
                    ? `Scramble length barely moves your time (r ${num(e.rLengthTime, 2)}). Your solutions cost about the same whatever the engine needs.`
                    : `Longer scrambles cost you more time (r ${num(e.rLengthTime, 2)}).`,
                )
              : null,
          )
        : null,
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Efficiency over time",
          "Optimal length divided by your moves.",
          this.chart((el) => {
            const pts = list.map((sv, i) => ({ x: i + 1, y: efficiency(sv) != null ? efficiency(sv) * 100 : null }));
            const r = rollingMean(pts.map((p) => p.y), 5);
            lineChart(
              el,
              [
                { name: "Solve", color: "var(--ink-3)", points: pts.filter((p) => p.y != null), dotsOnly: true, r: 2.5 },
                { name: "Mean of 5", color: "var(--chart-b)", points: r.map((y, i) => ({ x: i + 1, y })) },
              ],
              {
                height: 210,
                yMin: 0,
                yMax: 100,
                xMin: 1,
                xMax: Math.max(2, list.length),
                yFmt: (v) => v + "%",
                xLabel: "solve",
                tipFor: (x) => {
                  const p = pts[x - 1];
                  const sv = list[x - 1];
                  return p && p.y != null
                    ? `<b>Solve ${x}</b><br>${p.y.toFixed(0)}% efficient<br>${sv.moveCount} moves, engine ${sv.optimal}`
                    : null;
                },
                onPick: (x) => list[x - 1] && this.ctx.app.go("proofs", list[x - 1].id),
              },
            );
          }),
        ),
        block(
          "Extra moves",
          "How far over the engine each solve ran.",
          this.chart((el) => {
            const hist = histogram(a.deep.filter((d) => d.excess != null).map((d) => d.excess), 14);
            barChart(el, hist.bins, {
              height: 210,
              color: "var(--chart-a)",
              xLabel: "moves over the engine",
              yLabel: "solves",
              xFmt: (v) => trim(hist.bins[0].from + v * hist.width),
              tipFor: (b) =>
                `<b>${trim(hist.bins[0].from + b.x * hist.width)} to ${trim(hist.bins[0].from + (b.x + 1) * hist.width - 1)} extra</b><br>${b.value} solve${b.value === 1 ? "" : "s"}`,
            });
          }),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Yours against the engine's",
          "Each dot is a solve: across, what the engine needed; up, what you used. The line is perfect play.",
          this.chart((el) => {
            const pts = list.filter((s) => s.optimal != null).map((s) => ({ x: s.optimal, y: s.moveCount }));
            const lo = Math.min(...pts.map((p) => p.x)),
              hi = Math.max(...pts.map((p) => p.x));
            lineChart(
              el,
              [
                { name: "Perfect play", color: "var(--chart-b)", points: [{ x: lo, y: lo }, { x: hi, y: hi }], dash: true },
                { name: "Solve", color: "var(--chart-a)", points: pts, dotsOnly: true, r: 3 },
              ],
              { height: 230, xMin: lo, xMax: Math.max(hi, lo + 1), xLabel: "engine moves", yLabel: "your moves", integerX: false },
            );
            legend(el, [
              { name: "Solve", color: "var(--chart-a)", dot: true },
              { name: "Perfect play", color: "var(--chart-b)", dash: true },
            ]);
          }),
        ),
        (() => {
          const hb = habits(list, this.N);
          return block(
            "By scramble length",
            "Your mean time and move count against how many moves the scramble really needed.",
            hb.byLength.length
              ? facts(
                  hb.byLength.map((x) => [x.label, x.n, fmtTime(x.mean), num(x.moves)]),
                  ["Optimal moves", "Solves", "Mean time", "Mean moves"],
                )
              : h("p", { class: "muted" }, "Needs 3 solves with a known optimal length."),
          );
        })(),
      ),
    );
  }

  /* ---------- time per move ---------- */

  pace(body, a, list) {
    const p = a.pace;
    const ps = p.poolStats;
    if (!p.n) {
      body.append(h("p", { class: "muted" }, "These solves carry no per-move timing."));
      return;
    }
    // where in the solve the time goes: mean gap in each tenth of the solve
    const tenths = Array.from({ length: 10 }, () => []);
    for (const d of a.deep) {
      const g = d.gaps;
      if (!g || g.length < 10) continue;
      for (let i = 0; i < g.length; i++) tenths[Math.min(9, Math.floor((i / g.length) * 10))].push(g[i]);
    }
    const tenthMeans = tenths.map((x) => (x.length ? meanOf(x) : 0));
    const slowTenth = tenthMeans.indexOf(Math.max(...tenthMeans));
    body.append(
      h(
        "div",
        { class: "specimen specimen--5" },
        cell("Time per move", fmtMs(a.msPerMove.overall), "all your time divided by all your moves"),
        cell("Median gap", fmtMs(ps.median), "the usual wait between two moves"),
        cell("Mean gap", fmtMs(ps.mean), `slowest 10% of gaps are over ${fmtMs(ps.p90)}`),
        cell("Longest stop", fmtMs(p.gapMax.max), `typical longest stop ${fmtMs(p.gapMax.median)}`),
        cell("In flow", pct(p.flowShare.mean), "share of the clock spent moving at your own rhythm"),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Every gap",
          `${ps.n.toLocaleString()} gaps between moves, pooled from ${p.n} solve${p.n === 1 ? "" : "s"}.`,
          facts([
            ["Fastest gap", fmtMs(ps.min)],
            ["Fastest 10%", "under " + fmtMs(ps.p10)],
            ["Fastest quarter", "under " + fmtMs(ps.p25)],
            ["Median", fmtMs(ps.median)],
            ["Mean", fmtMs(ps.mean)],
            ["Slowest quarter", "over " + fmtMs(ps.p75)],
            ["Slowest 10%", "over " + fmtMs(ps.p90)],
            ["Standard deviation", fmtMs(ps.sd)],
            Object.assign(["Rhythm", p.rhythm.mean != null ? num(p.rhythm.mean, 2) : "-"], {
              note: "spread of your gaps against their mean; lower is steadier, 0 is a metronome",
            }),
          ]),
        ),
        block(
          "Stops and bursts",
          "A stop is a gap at least three times your normal one for that solve.",
          facts([
            ["Stops per solve", `${num(p.hesitations.mean, 1)}, median ${num(p.hesitations.median)}`],
            ["Most stops in one solve", p.hesitations.max],
            Object.assign(["Time lost to stops", fmtMs(p.hesitationMs.mean) + " per solve"], {
              note:
                a.time.mean && p.hesitationMs.mean != null
                  ? `${pct(p.hesitationMs.mean / a.time.mean)} of a typical solve`
                  : null,
            }),
            ["Longest stop ever", fmtMs(p.gapMax.max)],
            ["Typical longest stop", fmtMs(p.gapMax.median)],
            ["Fastest 10-move burst", num(p.burst.max, 1) + " TPS"],
            ["Typical best burst", num(p.burst.median, 1) + " TPS"],
            Object.assign(["First half of a solve", num(p.tpsFirst.mean, 2) + " TPS"], { note: "mean speed over the first half of your moves" }),
            Object.assign(["Second half of a solve", num(p.tpsSecond.mean, 2) + " TPS"], {
              note:
                p.tpsFirst.mean != null && p.tpsSecond.mean != null
                  ? p.tpsSecond.mean > p.tpsFirst.mean * 1.08
                    ? "you speed up as the board clears"
                    : p.tpsSecond.mean < p.tpsFirst.mean * 0.92
                      ? "you slow down toward the end"
                      : "steady from start to finish"
                  : null,
            }),
            p.inspect.n
              ? Object.assign(["Look before the first move", fmtMs(p.inspect.median)], {
                  note: `median over ${p.inspect.n} solve${p.inspect.n === 1 ? "" : "s"}; the clock does not run yet`,
                })
              : null,
          ]),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Gap distribution",
          "How long you wait between moves. The longest 2% are folded into the last bar.",
          this.chart((el) => {
            const s = a.pace.pool.slice().sort((x, y) => x - y);
            const cap = s[Math.floor(s.length * 0.98)] || s[s.length - 1];
            const hist = histogram(a.pace.pool.map((x) => Math.min(x, cap)), 20);
            barChart(el, hist.bins, {
              height: 220,
              color: "var(--chart-b)",
              xLabel: "milliseconds between moves",
              yLabel: "gaps",
              xFmt: (v) => trim(hist.bins[0].from + v * hist.width),
              tipFor: (b) =>
                `<b>${trim(hist.bins[0].from + b.x * hist.width)} to ${trim(hist.bins[0].from + (b.x + 1) * hist.width)} ms</b><br>${b.value.toLocaleString()} gap${b.value === 1 ? "" : "s"}`,
            });
          }),
        ),
        block(
          "Through the solve",
          tenthMeans.some(Boolean)
            ? `Mean gap in each tenth of a solve. You are slowest in the ${ordinal(slowTenth + 1)} tenth.`
            : "Needs solves of at least ten moves.",
          this.chart((el) => {
            barChart(
              el,
              tenthMeans.map((v, i) => ({ x: i + 1, value: Math.round(v) })),
              {
                height: 220,
                color: "var(--chart-a)",
                xLabel: "tenth of the solve",
                yLabel: "ms per move",
                highlightX: tenthMeans.some(Boolean) ? slowTenth + 1 : null,
                tipFor: (b) => `<b>${(b.x - 1) * 10}% to ${b.x * 10}% of the solve</b><br>${b.value} ms per move`,
              },
            );
          }),
        ),
      ),
      h("div", { class: "gap-32" }),
      block(
        "Time per move over time",
        "Each solve's time divided by its moves, with its median gap.",
        this.chart((el) => {
          const per = a.deep.map((d) => d.msPerMove);
          const med = a.deep.map((d) => d.gapMedian ?? null);
          lineChart(
            el,
            [
              { name: "Time per move", color: "var(--chart-a)", points: per.map((y, i) => ({ x: i + 1, y })), dotsOnly: list.length > 60, r: 2.5 },
              { name: "Median gap", color: "var(--chart-b)", points: med.map((y, i) => ({ x: i + 1, y })), dotsOnly: list.length > 60, r: 2.5 },
            ],
            {
              height: 220,
              xMin: 1,
              xMax: Math.max(2, list.length),
              xLabel: "solve",
              yLabel: "milliseconds",
              tipFor: (x) =>
                per[x - 1] != null
                  ? `<b>Solve ${x}</b><br>${Math.round(per[x - 1])} ms per move` +
                    (med[x - 1] != null ? `<br>median gap ${Math.round(med[x - 1])} ms` : "")
                  : null,
              onPick: (x) => list[x - 1] && this.ctx.app.go("proofs", list[x - 1].id),
            },
          );
          legend(el, [
            { name: "Time per move", color: "var(--chart-a)" },
            { name: "Median gap", color: "var(--chart-b)" },
          ]);
        }),
      ),
    );
  }

  /* ---------- habits ---------- */

  habits(body, a, list) {
    const hb = habits(list, this.N);
    const days = byDay(list);
    const streak = dayStreaks(days);
    const c = this.store.counters(this.N);
    const tries = c.solved + c.abandoned + c.failed;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayList = list.filter((s) => s.date >= today.getTime());
    const bestDay = [...days.values()].filter((d) => d.n >= 3).sort((x, y) => x.mean - y.mean)[0];
    const hours = byHour(list);
    body.append(
      h(
        "div",
        { class: "specimen specimen--5" },
        cell("Today", todayList.length, todayList.length ? "mean " + fmtTime(meanOf(todayList.map((s) => s.duration))) : "solves so far"),
        cell("Day streak", streak.current, `longest ${streak.longest}`),
        cell("Days played", days.size, `${num(a.n / days.size, 1)} solves a day`),
        cell("Busiest day", hb.busiest, "solves"),
        cell(
          "Finish rate",
          tries ? pct(c.solved / tries) : "-",
          tries ? `${c.solved} solved, ${c.abandoned} given up, ${c.failed} failed` : "counted from this version on",
        ),
      ),
      h("div", { class: "gap-32" }),
      block("Last 26 weeks", "Darker means more solves that day.", calendar(days)),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "By hour",
          "When you play, and how fast.",
          this.chart((el) => {
            barChart(
              el,
              hours.map((x) => ({ x: x.hour, value: x.n, mean: x.mean })),
              {
                height: 210,
                color: "var(--chart-b)",
                xMin: 0,
                xMax: 23,
                xLabel: "hour of the day",
                yLabel: "solves",
                tipFor: (b) =>
                  `<b>${String(b.x).padStart(2, "0")}:00</b><br>${b.value} solve${b.value === 1 ? "" : "s"}` +
                  (b.mean != null ? `<br>mean ${fmtTime(b.mean)}` : ""),
              },
            );
          }),
        ),
        block(
          "By weekday",
          null,
          facts(
            byWeekday(list)
              .filter((x) => x.n)
              .map((x) => [x.label, x.n, fmtTime(x.mean), fmtTime(x.best)]),
            ["Day", "Solves", "Mean", "Best"],
          ),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "By time of day",
          "When you play your best.",
          facts(hb.byHour.map((x) => [x.label, x.n, fmtTime(x.mean)]), ["When", "Solves", "Mean"]),
        ),
        block(
          "By scramble type",
          null,
          facts(
            byMode(list).map((x) => [x.label, x.n, fmtTime(x.mean), fmtTime(x.best), num(x.moves)]),
            ["Type", "Solves", "Mean", "Best", "Moves"],
          ),
        ),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
        "Form",
        null,
        facts([
          Object.assign(["Consistency", hb.cv != null ? pct(1 - hb.cv) : "-"], {
            note: hb.cv != null ? `spread is ${pct(hb.cv)} of your mean over the last 50` : "needs 3 solves",
          }),
          Object.assign(
            ["Trend", hb.trend != null ? (hb.trend >= 0 ? "▲ " : "▼ ") + pct(Math.abs(hb.trend)) : "-"],
            {
              note:
                hb.trend != null
                  ? hb.trend >= 0
                    ? "faster: last 20 against the 20 before"
                    : "slower: last 20 against the 20 before"
                  : "needs 40 solves",
            },
          ),
          Object.assign(["Under your mean", pct(hb.underMean)], { note: "share of the last 50" }),
          bestDay
            ? Object.assign(["Best day", `${fmtTime(bestDay.mean)} mean`], { note: `${dayYear(bestDay.date)}, ${bestDay.n} solves` })
            : null,
          Object.assign(["Solves since your last best", a.pb.sinceLast ?? "-"], {
            note: a.pb.single.length ? `${a.pb.single.length} personal best${a.pb.single.length === 1 ? "" : "s"} set in this view` : null,
          }),
        ]),
      ),
        h("div"),
      ),
    );
  }

  /* ---------- sessions ---------- */

  sessions(body, a, list) {
    const ss = sessions(list);
    const cur = ss[ss.length - 1];
    const live = Date.now() - cur.end < 30 * 60 * 1000;
    const warm = ss.map((x) => x.warm).filter((x) => x != null);
    const bestMean = ss.filter((x) => x.count >= 5).sort((x, y) => x.mean - y.mean)[0];
    body.append(
      h(
        "div",
        { class: "specimen specimen--5" },
        cell(live ? "This session" : "Last session", cur.count, "solves, " + fmtDuration(cur.spanMs) + " long"),
        cell("Session mean", fmtTime(cur.mean), "median " + fmtTime(cur.median)),
        cell("Session best", fmtTime(cur.best), "worst " + fmtTime(cur.worst)),
        cell("Session ao5", fmtTime(cur.ao5), cur.ao12 != null ? "best ao12 " + fmtTime(cur.ao12) : "best of the sitting"),
        cell("Sessions", ss.length, `${num(a.n / ss.length, 1)} solves each`),
      ),
      h("div", { class: "gap-32" }),
      h(
        "div",
        { class: "cols" },
        block(
          "Across sessions",
          "A break of 30 minutes starts a new session.",
          facts([
            ["Longest session", fmtDuration(Math.max(...ss.map((x) => x.spanMs)))],
            ["Most solves in one sitting", Math.max(...ss.map((x) => x.count))],
            ["Typical session", `${num(describe(ss.map((x) => x.count)).median)} solves, ${fmtDuration(describe(ss.map((x) => x.spanMs)).median)}`],
            bestMean
              ? Object.assign(["Best session mean", fmtTime(bestMean.mean)], { note: `${dayYear(bestMean.start)}, ${bestMean.count} solves` })
              : null,
            Object.assign(
              ["Warm-up cost", warm.length ? (meanOf(warm) >= 0 ? "+" : "") + fmtTime(Math.abs(meanOf(warm))) + " s" : "-"],
              {
                note: warm.length
                  ? meanOf(warm) > 0
                    ? "your first three solves of a sitting run this much slower than the rest"
                    : "your first three solves of a sitting are your fastest"
                  : "needs a session of 6 solves",
              },
            ),
          ]),
        ),
        block(
          "Session means",
          "One bar per sitting, oldest first.",
          this.chart((el) => {
            barChart(
              el,
              ss.map((x, i) => ({ x: i + 1, value: +(x.mean / 1000).toFixed(2), s: x })),
              {
                height: 210,
                color: "var(--chart-a)",
                xLabel: "session",
                yLabel: "mean seconds",
                tipFor: (b) =>
                  b.s
                    ? `<b>${dayYear(b.s.start)}</b><br>${b.s.count} solves, mean ${fmtTime(b.s.mean)}<br>best ${fmtTime(b.s.best)}`
                    : "",
              },
            );
          }),
        ),
      ),
      h("div", { class: "gap-32" }),
      block(
        "Every session",
        null,
        h(
          "div",
          { class: "scroll-x" },
          facts(
            ss
              .slice()
              .reverse()
              .slice(0, 60)
              .map((x) => [
                new Date(x.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
                x.count,
                fmtTime(x.mean),
                fmtTime(x.best),
                fmtTime(x.ao5),
                num(x.tps, 2),
                fmtDuration(x.boardMs),
                fmtDuration(x.spanMs),
              ]),
            ["Started", "Solves", "Mean", "Best", "Best ao5", "TPS", "Solving", "Length"],
          ),
        ),
      ),
    );
  }

  /* ---------- records ---------- */

  records(body, a, list) {
    const hb = habits(list, this.N);
    const bySolve = (sv, text) =>
      sv
        ? h(
            "button",
            { class: "linklike", type: "button", onclick: () => this.ctx.app.go("proofs", sv.id) },
            text,
          )
        : "-";
    const top = (f, higher) =>
      list.reduce((best, s) => {
        const v = f(s);
        if (v == null) return best;
        return best == null || (higher ? v > f(best) : v < f(best)) ? s : best;
      }, null);
    const deep = (k, higher = true) => top((s) => deepOf(s)[k], higher);
    const fewest = top((s) => s.moveCount, false);
    const burst = deep("burstTps");
    const clean = deep("cleanStreak");
    const accurate = deep("accuracy");
    const hardest = top((s) => s.optimal, true);
    const steady = deep("rhythm", false);
    const avgRec = [3, ...AVERAGE_SIZES].map((k) => {
      const r = k === 3 ? a.mo3 : a.averages.find((x) => x.n === k);
      return r && r.best != null
        ? [k === 3 ? "Best mo3" : "Best ao" + k, fmtTime(r.best), list[r.bestAt] ? dayYear(list[r.bestAt].date) : ""]
        : null;
    });
    const pb = a.pb.single;
    body.append(
      h(
        "div",
        { class: "cols" },
        block(
          "Single-solve records",
          "Click a record to open that solve.",
          facts(
            [
              ["Fastest", bySolve(hb.bestSingle, fmtTime(hb.bestSingle.duration)), dayYear(hb.bestSingle.date)],
              ["Fewest moves", bySolve(fewest, fewest.moveCount), dayYear(fewest.date)],
              ["Fastest hands", bySolve(hb.bestTps, tps(hb.bestTps).toFixed(2) + " TPS"), dayYear(hb.bestTps.date)],
              hb.bestEff
                ? ["Most efficient", bySolve(hb.bestEff, pct(efficiency(hb.bestEff), 1)), dayYear(hb.bestEff.date)]
                : null,
              accurate && deepOf(accurate).accuracy != null
                ? ["Most accurate", bySolve(accurate, pct(deepOf(accurate).accuracy, 1)), dayYear(accurate.date)]
                : null,
              clean && deepOf(clean).cleanStreak
                ? ["Longest run on the engine's line", bySolve(clean, deepOf(clean).cleanStreak + " moves"), dayYear(clean.date)]
                : null,
              burst && deepOf(burst).burstTps
                ? ["Fastest 10-move burst", bySolve(burst, deepOf(burst).burstTps.toFixed(1) + " TPS"), dayYear(burst.date)]
                : null,
              steady && deepOf(steady).rhythm != null
                ? ["Steadiest rhythm", bySolve(steady, deepOf(steady).rhythm.toFixed(2)), dayYear(steady.date)]
                : null,
              hardest && hardest.optimal
                ? ["Hardest scramble solved", bySolve(hardest, hardest.optimal + " moves"), dayYear(hardest.date)]
                : null,
            ],
            ["Record", "Value", "Set on"],
          ),
        ),
        block(
          "Average records",
          null,
          facts(avgRec, ["Record", "Value", "Set on"]),
        ),
      ),
      h("div", { class: "gap-32" }),
      block(
        "How your best fell",
        `${pb.length} personal best${pb.length === 1 ? "" : "s"} in this view. ${a.pb.sinceLast ? a.pb.sinceLast + " solves since the last one." : "The latest solve is one of them."}`,
        this.chart((el) => {
          const steps = (rows, scaleBy) => {
            const pts = [];
            rows.forEach((r, i) => {
              pts.push({ x: r.index + 1, y: r.value / scaleBy });
              const next = rows[i + 1] ? rows[i + 1].index + 1 : list.length;
              if (next > r.index + 1) pts.push({ x: next, y: r.value / scaleBy });
            });
            return pts;
          };
          const series = [{ name: "Best single", color: "var(--chart-a)", points: steps(pb, 1000) }];
          const items = [{ name: "Best single", color: "var(--chart-a)" }];
          if (a.pb.ao5.length) {
            series.push({ name: "Best ao5", color: "var(--chart-b)", points: steps(a.pb.ao5, 1000) });
            items.push({ name: "Best ao5", color: "var(--chart-b)" });
          }
          if (a.pb.ao12.length) {
            series.push({ name: "Best ao12", color: "var(--ink)", points: steps(a.pb.ao12, 1000), dash: true });
            items.push({ name: "Best ao12", color: "var(--ink)", dash: true });
          }
          lineChart(el, series, {
            height: 240,
            xMin: 1,
            xMax: Math.max(2, list.length),
            yMin: 0,
            xLabel: "solve",
            yLabel: "seconds",
          });
          legend(el, items);
        }),
      ),
      h("div", { class: "gap-32" }),
      block(
        "Every personal best",
        null,
        h(
          "div",
          { class: "scroll-x" },
          facts(
            pb
              .slice()
              .reverse()
              .map((r) => [
                dayYear(r.date),
                "solve " + (r.index + 1),
                fmtTime(r.value),
                r.prev != null ? "-" + fmtTime(r.prev - r.value) : "first",
                r.prev != null ? pct((r.prev - r.value) / r.prev, 1) : "",
              ]),
            ["Date", "When", "Time", "Cut", "Share"],
          ),
        ),
      ),
    );
  }

  /* ---------- coach ---------- */

  coach(body, a, list) {
    const recent = list.slice(-20);
    const reads = recent.map((s) => {
      try {
        return readMethod(s);
      } catch (e) {
        return null;
      }
    });
    body.append(
      block(
        "Method coach",
        `Read from your last ${recent.length} ${this.N}×${this.N} solve${recent.length === 1 ? "" : "s"}: the order your tiles go home, what each stage costs, and what to fix first.`,
        (() => {
          try {
            return coachPanel(coach(reads));
          } catch (e) {
            console.warn(e);
            return h("p", { class: "muted" }, "The coach could not read these solves.");
          }
        })(),
      ),
    );
  }

  /* ---------- log ---------- */

  log(body, a, list) {
    const cols = [
      { key: "n", label: "#", get: (r) => r.n, show: (r) => r.n },
      { key: "date", label: "When", get: (r) => r.s.date, show: (r) => relDate(r.s.date), left: true },
      { key: "time", label: "Time", get: (r) => r.s.duration, show: (r) => h("strong", null, fmtTime(r.s.duration)) },
      { key: "moves", label: "Moves", get: (r) => r.s.moveCount, show: (r) => r.s.moveCount },
      { key: "opt", label: "Engine", get: (r) => r.s.optimal ?? Infinity, show: (r) => r.s.optimal ?? "-" },
      { key: "extra", label: "Extra", get: (r) => r.d.excess ?? Infinity, show: (r) => r.d.excess ?? "-" },
      { key: "eff", label: "Eff.", get: (r) => r.d.efficiency ?? -1, show: (r) => pct(r.d.efficiency) },
      { key: "acc", label: "Acc.", get: (r) => r.d.accuracy ?? -1, show: (r) => (r.d.accuracy != null ? pct(r.d.accuracy) : "-") },
      { key: "tps", label: "TPS", get: (r) => r.d.tps, show: (r) => r.d.tps.toFixed(2) },
      { key: "mspm", label: "ms/move", get: (r) => r.d.msPerMove ?? Infinity, show: (r) => num(r.d.msPerMove) },
      { key: "gap", label: "Median gap", get: (r) => r.d.gapMedian ?? Infinity, show: (r) => num(r.d.gapMedian) },
      { key: "stop", label: "Longest stop", get: (r) => r.d.gapMax ?? -1, show: (r) => fmtMs(r.d.gapMax) },
    ];
    const rows = list.map((s, i) => ({ s, n: i + 1, d: a.deep[i] }));
    const col = cols.find((c) => c.key === this.logSort.key) || cols[0];
    rows.sort((x, y) => (col.get(x) - col.get(y)) * this.logSort.dir);
    const shown = rows.slice(0, this.logLimit);
    const sortBy = (c) => {
      this.logSort = { key: c.key, dir: this.logSort.key === c.key ? -this.logSort.dir : c.key === "n" || c.key === "date" ? -1 : 1 };
      this.render();
    };
    body.append(
      block(
        "Log",
        `${rows.length} solve${rows.length === 1 ? "" : "s"} in this view. Click a heading to sort, a row to open its proof.`,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn btn--small", type: "button", onclick: () => this.exportCsv(list, a) },
            "Download as a spreadsheet (CSV)",
          ),
        ),
        h(
          "div",
          { class: "scroll-x" },
          h(
            "table",
            { class: "ledger ledger--log" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ...cols.map((c) =>
                  h(
                    "th",
                    { class: c.left ? null : "tnum" },
                    h(
                      "button",
                      { class: "th-sort", type: "button", "aria-pressed": String(this.logSort.key === c.key), onclick: () => sortBy(c) },
                      c.label,
                      this.logSort.key === c.key ? (this.logSort.dir > 0 ? " ▲" : " ▼") : "",
                    ),
                  ),
                ),
                h("th", null, ""),
              ),
            ),
            h(
              "tbody",
              null,
              ...shown.map((r) =>
                h(
                  "tr",
                  { class: "is-link", onclick: () => this.ctx.app.go("proofs", r.s.id) },
                  ...cols.map((c) => h("td", { class: c.left ? null : "tnum" }, c.show(r))),
                  h(
                    "td",
                    null,
                    r.s.mode === "daily" ? h("span", { class: "tag tag--spot" }, "daily") : null,
                    r.s.pbTime ? h("span", { class: "tag tag--spot" }, "PB") : null,
                    r.s.assisted ? h("span", { class: "tag" }, "hint") : null,
                    r.s.modded ? h("span", { class: "tag" }, "mod") : null,
                  ),
                ),
              ),
            ),
          ),
        ),
        rows.length > this.logLimit
          ? h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () => {
                    this.logLimit += 100;
                    this.render();
                  },
                },
                `Show 100 more`,
              ),
              h(
                "button",
                {
                  class: "btn btn--ghost",
                  type: "button",
                  onclick: () => {
                    this.logLimit = rows.length;
                    this.render();
                  },
                },
                `Show all ${rows.length}`,
              ),
            )
          : null,
      ),
    );
  }

  exportCsv(list, a) {
    const head = [
      "number", "date", "size", "type", "seed", "time_s", "moves", "engine_moves", "extra_moves", "efficiency",
      "accuracy", "wrong_way_moves", "tps", "ms_per_move", "median_gap_ms", "longest_stop_ms", "stops", "burst_tps",
      "take_backs", "hints", "modded",
    ];
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const lines = [head.join(",")];
    list.forEach((s, i) => {
      const d = a.deep[i];
      lines.push(
        [
          i + 1,
          new Date(s.date).toISOString(),
          s.N,
          s.mode,
          s.seed,
          (s.duration / 1000).toFixed(3),
          s.moveCount,
          s.optimal,
          d.excess,
          d.efficiency != null ? d.efficiency.toFixed(4) : null,
          d.accuracy != null ? d.accuracy.toFixed(4) : null,
          d.bad,
          d.tps.toFixed(3),
          d.msPerMove != null ? d.msPerMove.toFixed(1) : null,
          d.gapMedian,
          d.gapMax,
          d.hesitations,
          d.burstTps != null ? d.burstTps.toFixed(2) : null,
          d.backtracks,
          s.hints || 0,
          s.modded ? 1 : 0,
        ]
          .map(q)
          .join(","),
      );
    });
    downloadFile(`fifteen-press-${this.N}x${this.N}-solves.csv`, lines.join("\n"), "text/csv").then(
      () => {},
      () => toast("Could not save the file."),
    );
  }
}

/* ---------- small pieces ---------- */

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function trim(v) {
  return String(+v.toFixed(2));
}

function rollingMean(values, n) {
  return values.map((_, i) => {
    if (i + 1 < n) return null;
    const w = values.slice(i + 1 - n, i + 1).filter((x) => x != null);
    return w.length ? w.reduce((x, y) => x + y, 0) / w.length : null;
  });
}

/** 26 weeks of days, one column per week, shaded by how many solves that day had. */
function calendar(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (26 * 7 - 1) - start.getDay());
  const max = Math.max(1, ...[...days.values()].map((d) => d.n));
  const grid = h("div", { class: "cal", role: "img", "aria-label": "Solves per day over the last 26 weeks" });
  const d = new Date(start);
  let lastMonth = -1;
  const months = h("div", { class: "cal-months" });
  for (let week = 0; d <= today; week++) {
    const col = h("div", { class: "cal-col" });
    for (let wd = 0; wd < 7; wd++) {
      if (d > today || (week === 0 && wd < start.getDay())) {
        col.append(h("i", { class: "cal-day is-void" }));
      } else {
        const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        const e = days.get(key);
        const level = e ? Math.max(1, Math.ceil((e.n / max) * 4)) : 0;
        col.append(
          h("i", {
            class: "cal-day lv" + level,
            title: `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${e ? e.n + " solve" + (e.n === 1 ? "" : "s") + ", mean " + fmtTime(e.mean) : "no solves"}`,
          }),
        );
      }
      if (wd === 0 && d.getMonth() !== lastMonth && d <= today) {
        lastMonth = d.getMonth();
        months.append(
          h("span", { style: { gridColumn: String(week + 1) } }, d.toLocaleDateString(undefined, { month: "short" })),
        );
      }
      d.setDate(d.getDate() + 1);
    }
    grid.append(col);
  }
  return h("div", { class: "scroll-x" }, h("div", { class: "cal-wrap" }, months, grid));
}
