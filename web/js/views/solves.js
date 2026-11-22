// Solves: every solve on one page. Sort it any way, filter it down, see it as a heat grid.
import { h, clear, seg, relDate } from "../ui.js";
import { fmtTime, mean } from "../stats.js";
import { median, sessions, dayKey } from "../deep.js";
import { METRICS, metric, rankOf, heatColor, inkColor, difficulty } from "../metrics.js";
import { colourWords } from "../themes.js";

const SORTS = [
  { value: "newest", label: "Newest first", key: "date", dir: -1 },
  { value: "oldest", label: "Oldest first", key: "date", dir: 1 },
  { value: "fastest", label: "Fastest", key: "time", dir: 1 },
  { value: "slowest", label: "Slowest", key: "time", dir: -1 },
  { value: "easiest", label: "Easiest scramble", key: "diff", dir: 1 },
  { value: "hardest", label: "Hardest scramble", key: "diff", dir: -1 },
  { value: "fair", label: "Best for its scramble", key: "perOptimal", dir: 1 },
  { value: "fewest", label: "Fewest moves", key: "moves", dir: 1 },
  { value: "most", label: "Most moves", key: "moves", dir: -1 },
  { value: "tps", label: "Highest TPS", key: "tps", dir: -1 },
  { value: "slowhands", label: "Lowest TPS", key: "tps", dir: 1 },
  { value: "tight", label: "Closest to the engine", key: "excess", dir: 1 },
  { value: "loose", label: "Furthest from the engine", key: "excess", dir: -1 },
  { value: "wasted", label: "Most wasted moves", key: "wasted", dir: -1 },
  { value: "accurate", label: "Most accurate", key: "accuracy", dir: -1 },
  { value: "stops", label: "Most stops", key: "stops", dir: -1 },
  { value: "smooth", label: "Fewest stops", key: "stops", dir: 1 },
  { value: "longstop", label: "Longest stop", key: "gapMax", dir: -1 },
];

const PERIODS = [
  { value: "all", label: "All time" },
  { value: "session", label: "This session" },
  { value: "today", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

const KINDS = [
  { value: "clean", label: "Clean" },
  { value: "all", label: "Everything" },
  { value: "pb", label: "Records" },
  { value: "practice", label: "Practice" },
  { value: "coached", label: "Coached" },
];

// The table opens on the five columns that say how a solve went. "Every column" adds the rest.
const COLUMNS_SHORT = ["time", "moves", "tps", "diff", "efficiency"];
const COLUMNS = ["time", "moves", "tps", "diff", "excess", "efficiency", "accuracy", "wasted", "stops", "gapMax"];
const HEAT_KEYS = ["time", "moves", "tps", "diff", "perOptimal", "excess", "accuracy", "stops", "gapMax", "overLine"];

const dateOf = { key: "date", label: "Date", short: "Date", get: (s) => s.date, better: null };
const col = (key) => (key === "date" ? dateOf : metric(key));

export class SolvesView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.N = "all";
    this.period = "all";
    this.kind = "clean";
    this.sort = { key: "date", dir: -1 };
    this.under = "";
    this.query = "";
    this.layout = "table";
    this.heatKey = "time";
    this.heatBy = "flow";
    this.limit = 100;
  }

  show(param) {
    if (!this.opened) {
      // open on the size you play, All sizes is one click away
      this.opened = true;
      const size = this.store.settings.size;
      if (this.store.solves({ profileId: this.store.state.activeProfile, N: size }).length) this.N = size;
    }
    const preset = SORTS.find((s) => s.value === param);
    if (preset) this.sort = { key: preset.key, dir: preset.dir };
    if (param === "heat") this.layout = "heat";
    this.render();
  }

  onStore(e) {
    if (this.root.hidden || e.type === "settings" || e.type === "training") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => !this.root.hidden && this.render(), e.type === "solve-updated" ? 600 : 0);
  }

  /* ---------- data ---------- */

  pick() {
    const mine = this.store.solves({ profileId: this.store.state.activeProfile });
    let list = this.N === "all" ? mine.slice() : mine.filter((s) => s.N === this.N);
    if (this.kind === "clean") list = list.filter((s) => !s.assisted && !s.modded);
    else if (this.kind === "practice") list = list.filter((s) => s.practice);
    else if (this.kind === "coached") list = list.filter((s) => s.coached);
    else if (this.kind === "pb") {
      // every solve that was the fastest clean one of its size when it happened
      const best = {};
      const keep = new Set();
      for (const s of mine) {
        if (s.assisted || s.modded) continue;
        if (best[s.N] == null || s.duration < best[s.N]) {
          best[s.N] = s.duration;
          keep.add(s.id);
        }
      }
      list = list.filter((s) => keep.has(s.id));
    }
    const now = Date.now();
    if (this.period === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      list = list.filter((s) => s.date >= d.getTime());
    } else if (this.period === "7" || this.period === "30") {
      list = list.filter((s) => s.date >= now - Number(this.period) * 86400000);
    } else if (this.period === "session") {
      const ss = sessions(list);
      list = ss.length ? ss[ss.length - 1].solves.slice() : [];
    }
    const under = parseFloat(this.under);
    if (isFinite(under) && under > 0) list = list.filter((s) => s.duration < under * 1000);
    const q = this.query.trim().toLowerCase();
    if (q)
      list = list.filter(
        (s) =>
          String(s.seed || "").toLowerCase().includes(q) ||
          String(s.label || "").toLowerCase().includes(q) ||
          String(s.mode || "").includes(q),
      );
    return { mine, list };
  }

  sorted(list) {
    const c = col(this.sort.key) || dateOf;
    const dir = this.sort.dir;
    const rows = list.map((s) => ({ s, v: c.get(s) }));
    // solves with no value for the sort key go last, whichever way it runs
    rows.sort((a, b) => {
      if (a.v == null && b.v == null) return b.s.date - a.s.date;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      return (a.v - b.v) * dir || b.s.date - a.s.date;
    });
    return rows.map((r) => r.s);
  }

  /* ---------- frame ---------- */

  render() {
    const keepFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.keep : null;
    clear(this.root);
    const { mine, list } = this.pick();
    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, "Solves"),
        ),
      ),
    );
    if (!mine.length) {
      this.root.append(
        h(
          "div",
          { class: "empty panel" },
          h("strong", null, "No solves yet"),
          "Finish a scramble and it lands here.",
          h("div", { style: { marginTop: "16px" } }, h("a", { class: "btn btn--primary", href: "#play" }, "Go play")),
        ),
      );
      return;
    }
    const sizes = [...new Set(mine.map((s) => s.N))].sort((a, b) => a - b);
    if (this.N !== "all" && !sizes.includes(this.N)) this.N = "all";
    const again = (key) => (v) => {
      this[key] = v;
      this.limit = 100;
      this.render();
    };

    const preset = SORTS.find((s) => s.key === this.sort.key && s.dir === this.sort.dir);
    const sortSel = h(
      "select",
      { class: "select", "aria-label": "Sort by", "data-keep": "sort" },
      ...SORTS.map((s) => h("option", { value: s.value, selected: preset === s }, s.label)),
      preset ? null : h("option", { value: "", selected: true }, `${col(this.sort.key).label}, ${this.sort.dir > 0 ? "low to high" : "high to low"}`),
    );
    sortSel.addEventListener("change", () => {
      const p = SORTS.find((s) => s.value === sortSel.value);
      if (p) this.sort = { key: p.key, dir: p.dir };
      this.limit = 100;
      this.render();
    });
    const under = h("input", {
      class: "input input--num",
      type: "number",
      min: "0",
      step: "0.5",
      placeholder: "any",
      value: this.under,
      "aria-label": "Only solves under this many seconds",
      "data-keep": "under",
    });
    under.addEventListener("change", () => {
      this.under = under.value;
      this.render();
    });
    const search = h("input", {
      class: "input",
      type: "search",
      placeholder: "Seed",
      value: this.query,
      "aria-label": "Find a seed",
      "data-keep": "query",
    });
    search.addEventListener("change", () => {
      this.query = search.value;
      this.render();
    });

    this.root.append(
      h(
        "div",
        { class: "filters" },
        seg([{ value: "all", label: "All sizes" }].concat(sizes.map((n) => ({ value: n, label: n + "×" + n }))), this.N, again("N"), "Board size"),
        seg(PERIODS, this.period, again("period"), "Period"),
        seg(KINDS, this.kind, again("kind"), "Which solves"),
      ),
      // sorting is on the column heads already. the rest of the tools open when asked for, or when one is in use
      (() => {
        const d = h(
          "details",
          { class: "more tools-more" },
          h("summary", null, "Sort, find, view"),
          h(
            "div",
            { class: "filters filters--tools" },
            h("label", { class: "field" }, h("span", null, "Sort"), sortSel),
            h("label", { class: "field" }, h("span", null, "Under (s)"), under),
            h("label", { class: "field" }, h("span", null, "Find"), search),
            h(
              "div",
              { class: "field" },
              h("span", null, "View"),
              seg(
                [
                  { value: "table", label: "Table" },
                  { value: "wide", label: "Every column" },
                  { value: "heat", label: "Heat grid" },
                ],
                this.layout,
                again("layout"),
                "Layout",
              ),
            ),
          ),
        );
        const inUse = !!this.under || !!this.query || this.layout !== "table";
        d.open = !!this.toolsOpen || inUse;
        d.addEventListener("toggle", () => {
          if (!inUse) this.toolsOpen = d.open;
        });
        return d;
      })(),
    );
    if (keepFocus) {
      const el = this.root.querySelector(`[data-keep="${keepFocus}"]`);
      if (el) el.focus();
    }

    if (!list.length) {
      this.root.append(h("p", { class: "muted" }, "Nothing matches. Loosen a filter above."));
      return;
    }

    const times = list.map((s) => s.duration);
    const fastest = list.reduce((a, b) => (b.duration < a.duration ? b : a));
    this.root.append(
      h(
        "div",
        { class: "specimen specimen--4 solves-strip" },
        cell("Showing", list.length, list.length === mine.length ? "all of them" : `of ${mine.length}`),
        cell("Fastest", fmtTime(fastest.duration), relDate(fastest.date)),
        cell("Mean", fmtTime(mean(times)), "median " + fmtTime(median(times))),
        cell("Slowest", fmtTime(Math.max(...times))),
      ),
    );

    const rows = this.sorted(list);
    if (this.layout === "heat") this.heat(rows, list);
    else this.table(rows, list);
  }

  /* ---------- table ---------- */

  table(rows, list) {
    const wide = this.layout === "wide";
    const cols = (wide ? COLUMNS : COLUMNS_SHORT).map(metric);
    // percentile inside what is shown, per column
    const ranks = {};
    for (const c of cols) {
      if (!c.better) continue;
      ranks[c.key] = list.map((s) => c.get(s)).filter((v) => v != null).sort((a, b) => a - b);
    }
    // the short table is plain figures. the shading belongs to "every column"
    const shade = (c, v) => {
      if (!wide || !c.better || v == null) return null;
      const r = rankOf(ranks[c.key], v);
      return heatColor(c.better === "low" ? r : 1 - r, 0.34);
    };
    const head = (c, cls) => {
      const on = this.sort.key === c.key;
      return h(
        "th",
        { class: (cls || "") + (on ? " is-sorted" : ""), "aria-sort": on ? (this.sort.dir > 0 ? "ascending" : "descending") : null },
        h(
          "button",
          {
            type: "button",
            class: "th-sort",
            title: c.note || c.label,
            onclick: () => {
              // first click goes best first, the second flips it
              const first = c.key === "date" ? -1 : c.better === "high" ? -1 : 1;
              this.sort = { key: c.key, dir: on ? -this.sort.dir : first };
              this.render();
            },
          },
          c.short,
          on ? (this.sort.dir > 0 ? " ▲" : " ▼") : "",
        ),
      );
    };
    const shown = rows.slice(0, this.limit);
    const best = {};
    for (const s of list) if (!s.assisted && !s.modded && (best[s.N] == null || s.duration < best[s.N].duration)) best[s.N] = s;
    const body = shown.map((s, i) =>
      h(
        "tr",
        { class: "is-link", onclick: () => this.ctx.app.go("proofs", s.id), title: "Open the proof" },
        h("td", { class: "rank-n tnum" }, i + 1),
        h("td", null, relDate(s.date), h("div", { class: "fact-note" }, s.N + "×" + s.N + " " + (s.label || s.mode || ""))),
        ...cols.map((c) => {
          const v = c.get(s);
          const bg = shade(c, v);
          return h("td", { class: "tnum heat-cell", style: bg ? { background: bg } : null }, c.fmt(v));
        }),
        h(
          "td",
          { class: "tags-cell" },
          best[s.N] === s ? h("span", { class: "tag tag--spot" }, "Best") : null,
          s.coached ? h("span", { class: "tag" }, "Coached") : s.practice ? h("span", { class: "tag" }, "Practice") : s.assisted ? h("span", { class: "tag" }, "Hint") : s.modded ? h("span", { class: "tag" }, "Mod") : null,
        ),
      ),
    );
    this.root.append(
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "ledger ledger--solves" + (wide ? " is-wide" : "") },
          h("thead", null, h("tr", null, h("th", { class: "tnum" }, "#"), head(dateOf), ...cols.map((c) => head(c, "tnum")), h("th", null, ""))),
          h("tbody", null, ...body),
        ),
      ),
      h(
        "p",
        { class: "hint-text" },
        wide
          ? `Shading compares each number with the other solves on this list: ${colourWords().warm} is the good end, ${colourWords().cold} the bad end. Click a heading to sort by it.`
          : "Click a heading to sort by it. Every column has the rest: accuracy, wasted moves, stops.",
      ),
    );
    if (rows.length > shown.length)
      this.root.append(
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              this.limit += 200;
              this.render();
            },
          },
          `Show more (${rows.length - shown.length} left)`,
        ),
      );
  }

  /* ---------- heat grid ---------- */

  heat(rows, list) {
    const c = metric(this.heatKey) || metric("time");
    const vals = list.map((s) => c.get(s)).filter((v) => v != null).sort((a, b) => a - b);
    const colour = (s) => {
      const v = c.get(s);
      if (v == null) return null;
      const r = rankOf(vals, v);
      if (!c.better) return inkColor(0.12 + r * 0.88);
      return heatColor(c.better === "low" ? r : 1 - r, 0.9);
    };
    const sq = (s) =>
      h("button", {
        type: "button",
        class: "heat-sq" + (c.get(s) == null ? " is-empty" : ""),
        style: { background: colour(s) || "transparent" },
        title: `${fmtTime(s.duration)} · ${s.moveCount} moves · ${c.label}: ${c.fmt(c.get(s))} · ${relDate(s.date)}`,
        "aria-label": `${fmtTime(s.duration)}, ${relDate(s.date)}`,
        onclick: () => this.ctx.app.go("proofs", s.id),
      });
    const sel = h(
      "select",
      { class: "select", "aria-label": "Colour by", "data-keep": "heat" },
      ...HEAT_KEYS.map(metric).map((m) => h("option", { value: m.key, selected: m.key === c.key }, m.label)),
    );
    sel.addEventListener("change", () => {
      this.heatKey = sel.value;
      this.render();
    });
    this.root.append(
      h(
        "div",
        { class: "filters filters--tools" },
        h("label", { class: "field" }, h("span", null, "Colour by"), sel),
        h(
          "div",
          { class: "field" },
          h("span", null, "Arrange"),
          seg(
            [
              { value: "flow", label: "In sort order" },
              { value: "day", label: "By day" },
            ],
            this.heatBy,
            (v) => {
              this.heatBy = v;
              this.render();
            },
            "Arrange",
          ),
        ),
        h(
          "div",
          { class: "heat-key" },
          c.better
            ? [h("span", null, c.better === "low" ? "low" : "high"), h("i", { class: "heat-ramp" }), h("span", null, c.better === "low" ? "high" : "low")]
            : [h("span", null, "low"), h("i", { class: "heat-ramp heat-ramp--ink" }), h("span", null, "high")],
        ),
      ),
    );
    if (this.heatBy === "day") {
      const days = new Map();
      for (const s of list.slice().sort((a, b) => a.date - b.date)) {
        const k = dayKey(s.date);
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(s);
      }
      const keys = [...days.keys()].reverse().slice(0, 120);
      this.root.append(
        h(
          "div",
          { class: "heat-days" },
          ...keys.map((k) => {
            const ss = days.get(k);
            return h(
              "div",
              { class: "heat-day" },
              h(
                "div",
                { class: "heat-day-label" },
                new Date(ss[0].date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
                h("small", null, `${ss.length} · best ${fmtTime(Math.min(...ss.map((x) => x.duration)))}`),
              ),
              h("div", { class: "heat-flow" }, ...ss.map(sq)),
            );
          }),
        ),
      );
    } else {
      this.root.append(h("div", { class: "heat-flow heat-flow--big" }, ...rows.slice(0, 3000).map(sq)));
    }
    this.root.append(
      h(
        "p",
        { class: "hint-text" },
        c.better
          ? `One square per solve, coloured by ${c.label.toLowerCase()}: ${colourWords().warm} is the good end, ${colourWords().cold} the bad end. Hover for the numbers, click to open the proof.`
          : `One square per solve, darker means a higher ${c.label.toLowerCase()}. Hover for the numbers, click to open the proof.`,
      ),
    );
  }
}

function cell(label, value, sub) {
  return h("div", null, h("div", { class: "label" }, label), h("div", { class: "figure" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

function avg(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "-";
}
