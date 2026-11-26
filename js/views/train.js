// Train: a plan read from your own solves, and drills that each work on one thing.
import { BoardView } from "../board-view.js";
import { Game } from "../game.js";
import * as audio from "../audio.js";
import { h, clear, seg } from "../ui.js";
import { fmtTime, mean } from "../stats.js";
import { deepOf, median } from "../deep.js";
import { planFor, stageIndex, stageLine, stageScramble, averageSplits, splitsOf, legs, blankPath, METHODS } from "../steps.js";
import { methodLine } from "../metrics.js";
import { setCoach } from "../speed.js";
import { readMethod } from "../method.js";

const E = window.FifteenEngine;

const KEYMAP = {
  tile: { ArrowLeft: 3, ArrowRight: 2, ArrowUp: 1, ArrowDown: 0, a: 3, d: 2, w: 1, s: 0 },
  blank: { ArrowLeft: 2, ArrowRight: 3, ArrowUp: 0, ArrowDown: 1, a: 2, d: 3, w: 0, s: 1 },
};

const PATTERNS = [
  { value: "loop", label: "Small loop", title: "Four tiles round and round" },
  { value: "ring", label: "Outer ring", title: "All the way round the edge" },
  { value: "snake", label: "Snake", title: "Up the board row by row and back" },
  { value: "mixed", label: "Mixed", title: "A random string of moves to read and play" },
];

const sec = (ms, digits = 2) => (ms == null || !isFinite(ms) ? "-" : (ms / 1000).toFixed(digits));
const signed = (ms) => (ms == null || !isFinite(ms) ? "" : (ms <= 0 ? "-" : "+") + fmtTime(Math.abs(ms)));
const short = (name) => name.replace(" and ", "+").replace("Last three", "Last 3").replace("Last block", "Last 3").replace("Column", "Col");

/** The moves of a finger pattern, as gap directions, from the solved board. */
function patternMoves(N, id) {
  const rep = (d, n) => new Array(n).fill(d);
  if (id === "loop") {
    const out = [];
    for (let i = 0; i < 12; i++) out.push(0, 2, 1, 3);
    return out;
  }
  if (id === "ring") {
    const lap = [...rep(0, N - 1), ...rep(2, N - 1), ...rep(1, N - 1), ...rep(3, N - 1)];
    const out = [];
    while (out.length < 44) out.push(...lap);
    return out;
  }
  if (id === "snake") {
    const up = [];
    for (let r = 0; r < N; r++) {
      up.push(...rep(r % 2 ? 3 : 2, N - 1));
      if (r < N - 1) up.push(0);
    }
    const down = up
      .slice()
      .reverse()
      .map((m) => E.INV[m]);
    const out = [];
    while (out.length < 44) out.push(...up, ...down);
    return out;
  }
  // mixed: random legal moves, never straight back
  const out = [];
  const b = [];
  for (let i = 1; i < N * N; i++) b.push(i);
  b.push(0);
  let last = -1;
  while (out.length < 48) {
    const d = Math.floor(Math.random() * 4);
    if (d === E.INV[last] || E.neighbor(b.indexOf(0), d, N) < 0) continue;
    E.applyMove(b, N, d);
    out.push(d);
    last = d;
  }
  return out;
}

export class TrainView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.N = null;
    this.drill = null;
    this.stage = "auto";
    this.pattern = "loop";
    this.raf = 0;
  }

  get s() {
    return this.store.settings;
  }

  show() {
    if (!this.N) this.N = Math.min(5, Math.max(3, this.s.size || 4));
    this.render();
  }

  hide() {
    this.stopClock();
  }

  onStore(e) {
    if (this.root.hidden) return;
    if (e.type === "training") {
      if (this.drill) this.renderRunSide();
      return;
    }
    if (this.drill) return;
    if (e.type === "profile" || e.type === "all" || e.type === "solves") this.render();
  }

  /* ---------- what your solves say ---------- */

  read() {
    const N = this.N;
    const plan = planFor(N, this.s.coachMethod);
    const all = this.store
      .solves({ profileId: this.store.state.activeProfile, N, clean: true })
      .filter((s) => s.mode !== "custom");
    const recent = all.slice(-50);
    const out = { N, plan, n: recent.length, total: all.length };
    if (!recent.length) return out;
    const deep = recent.map(deepOf);
    out.avg = mean(recent.map((s) => s.duration));
    out.best = Math.min(...all.map((s) => s.duration));
    out.moves = mean(deep.map((d) => d.M));
    out.tps = out.moves / (out.avg / 1000);
    out.stops = mean(deep.map((d) => d.hesitations || 0));
    out.stopMs = mean(deep.map((d) => d.hesitationMs || 0));
    const gaps = deep.map((d) => d.gapMedian).filter((x) => x != null);
    out.gap = gaps.length ? median(gaps) : null;
    const lines = recent.map((s) => methodLine(s, plan.id)).filter((x) => x != null);
    out.line = lines.length ? mean(lines) : null;
    out.splits = averageSplits(recent, plan);
    // the same stages on your quickest quarter: the gap between the two is time you already know how to save
    const fast = recent
      .slice()
      .sort((a, b) => a.duration - b.duration)
      .slice(0, Math.max(3, Math.ceil(recent.length / 4)));
    out.fastSplits = recent.length >= 8 ? averageSplits(fast, plan) : null;
    // which order your solves actually follow
    const votes = {};
    let read = 0;
    for (const s of recent.slice(-20)) {
      let m = null;
      try {
        m = readMethod(s);
      } catch (e) {}
      if (!m || !m.closest) continue;
      read++;
      votes[m.closest.id] = (votes[m.closest.id] || 0) + 1;
    }
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    out.seen = top && read >= 5 ? { id: top[0], share: top[1] / read } : null;
    return out;
  }

  target(r) {
    const saved = (this.s.trainTarget || {})[this.N];
    if (saved) return saved * 1000;
    if (r.avg) return Math.max(500, Math.round((r.avg * 0.78) / 500) * 500);
    return { 3: 2500, 4: 6500, 5: 20000 }[this.N] || 6500;
  }

  setTarget(seconds) {
    const t = Object.assign({}, this.s.trainTarget || {});
    if (seconds) t[this.N] = seconds;
    else delete t[this.N];
    this.store.set("trainTarget", t);
    this.render();
  }

  levers(r, target) {
    if (!r.avg || r.gap == null) return null;
    const toFind = r.avg - target;
    const extra = r.line != null ? Math.max(0, r.moves - r.line) : null;
    const moves = { key: "moves", worth: extra != null ? extra * r.gap : 0 };
    const stops = { key: "stops", worth: r.stopMs || 0 };
    const base = r.line != null ? r.line : r.moves;
    const needTps = base / (target / 1000);
    const handTps = 1000 / r.gap;
    const hands = { key: "hands", worth: Math.max(0, base * r.gap - target), needTps, handTps };
    const list = [moves, stops, hands];
    const top = list.reduce((a, b) => (b.worth > a.worth ? b : a));
    return { toFind, extra, moves, stops, hands, top: toFind > 0 ? top.key : null };
  }

  weakStage(r) {
    if (!r.splits) return 0;
    const all = legs(r.splits.at);
    if (!r.fastSplits) return all.indexOf(Math.max(...all));
    const fast = legs(r.fastSplits.at);
    const lost = all.map((x, i) => x - fast[i]);
    return lost.indexOf(Math.max(...lost));
  }

  /* ---------- home ---------- */

  render() {
    this.stopClock();
    if (this.drill) return this.renderRun();
    clear(this.root);
    const r = (this.data = this.read());
    const target = this.target(r);
    const lv = this.levers(r, target);
    const weak = this.weakStage(r);

    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, "Train"),
          h("p", null, "A plan read from your last 50 clean solves, and drills that each fix one thing."),
        ),
      ),
      h(
        "div",
        { class: "filters" },
        seg(
          [3, 4, 5].map((n) => ({ value: n, label: n + "×" + n })),
          this.N,
          (v) => {
            this.N = v;
            this.stage = "auto";
            this.render();
          },
          "Board size",
        ),
      ),
    );

    /* ----- plan ----- */
    const custom = h("input", {
      class: "input input--num",
      type: "number",
      min: "0.5",
      step: "0.1",
      value: (target / 1000).toFixed(1),
      "aria-label": "Target average in seconds",
    });
    custom.addEventListener("change", () => {
      const v = parseFloat(custom.value);
      if (isFinite(v) && v > 0) this.setTarget(Math.round(v * 10) / 10);
    });
    const quick = r.avg
      ? [0.9, 0.8, 0.7].map((f) => Math.max(0.5, Math.round((r.avg * f) / 500) / 2))
      : [];
    const plan = h("section", { class: "stack stat-block train-plan" }, h("h2", { class: "sub-title" }, "The plan"));
    plan.append(
      h(
        "div",
        { class: "filters filters--tools" },
        h("label", { class: "field" }, h("span", null, "Target average (s)"), custom),
        ...[...new Set(quick)].map((q) =>
          h("button", { class: "btn btn--small", type: "button", onclick: () => this.setTarget(q) }, q.toFixed(1) + " s"),
        ),
      ),
    );
    if (r.n < 5) {
      plan.append(
        h(
          "p",
          { class: "muted" },
          `The plan needs 5 clean ${this.N}×${this.N} solves to read. You have ${r.n}. The drills below work now.`,
        ),
      );
    } else {
      plan.append(
        h(
          "div",
          { class: "specimen specimen--5" },
          cell("Average now", fmtTime(r.avg), `last ${r.n} clean solves`),
          cell("Target", fmtTime(target), lv.toFind > 0 ? "" : "already there, set a lower one"),
          cell("To find", lv.toFind > 0 ? sec(lv.toFind) + " s" : "0", "a solve", lv.toFind > 0 ? "is-key" : null),
          cell("Best single", fmtTime(r.best), "shows the pace is in you"),
          cell("Now", `${Math.round(r.moves)} moves`, `at ${r.tps.toFixed(1)} tiles a second`),
        ),
      );
      const go = (label, fn) => h("button", { class: "btn btn--small", type: "button", onclick: fn }, label);
      const tag = (key) => (lv.top === key ? h("span", { class: "tag tag--key" }, "Start here") : null);
      plan.append(
        h(
          "div",
          { class: "table-scroll" },
          h(
          "table",
          { class: "ledger ledger--facts train-levers" },
          h("thead", null, h("tr", null, ...["Where the time is", "Now", "Aim", "Worth", ""].map((x, i) => h("th", { class: i && i < 4 ? "tnum" : null }, x)))),
          h(
            "tbody",
            null,
            h(
              "tr",
              null,
              h("td", null, "Extra moves ", tag("moves"), h("div", { class: "fact-note" }, "Moves beyond a tile-by-tile solve of the same scrambles.")),
              h("td", { class: "tnum" }, lv.extra != null ? `${Math.round(r.moves)} moves` : "-"),
              h("td", { class: "tnum" }, r.line != null ? `${Math.round(r.line)} moves` : "-"),
              h("td", { class: "tnum worth" }, sec(lv.moves.worth, 1) + " s"),
              h("td", { class: "act" }, go("Coached solve", () => this.coached()), " ", go("Stage drill", () => this.start("stage", { stage: weak }))),
            ),
            h(
              "tr",
              null,
              h("td", null, "Stops ", tag("stops"), h("div", { class: "fact-note" }, "Pauses of three times your normal gap or more.")),
              h("td", { class: "tnum" }, `${r.stops.toFixed(1)} a solve`),
              h("td", { class: "tnum" }, "0 to 1"),
              h("td", { class: "tnum worth" }, sec(lv.stops.worth, 1) + " s"),
              h("td", { class: "act" }, go("Smooth solve", () => this.start("smooth"))),
            ),
            h(
              "tr",
              null,
              h("td", null, "Hand speed ", tag("hands"), h("div", { class: "fact-note" }, "What is left once the moves are tight and the stops are gone.")),
              h("td", { class: "tnum" }, `${lv.hands.handTps.toFixed(1)} TPS`),
              h("td", { class: "tnum" }, `${lv.hands.needTps.toFixed(1)} TPS`),
              h("td", { class: "tnum worth" }, lv.hands.worth > 0 ? sec(lv.hands.worth, 1) + " s" : "fast enough"),
              h("td", { class: "act" }, go("Finger sprint", () => this.start("sprint", { pattern: this.pattern }))),
            ),
          ),
        ),
        ),
      );
      if (r.seen && r.seen.id !== r.plan.id && r.seen.share >= 0.6) {
        const m = METHODS.find((x) => x.value === r.seen.id);
        if (m)
          plan.append(
            h(
              "p",
              { class: "hint-text train-seen" },
              `Your solves look like ${m.label.toLowerCase()} (${Math.round(r.seen.share * 100)}% of the last ones), but the coach and this plan are set to ${r.plan.name.toLowerCase()}. `,
              h(
                "button",
                {
                  class: "btn btn--small",
                  type: "button",
                  onclick: () => {
                    this.store.set("coachMethod", r.seen.id);
                    this.render();
                  },
                },
                "Switch to " + m.label.toLowerCase(),
              ),
            ),
          );
      }
      if (r.splits) {
        const all = legs(r.splits.at);
        const fast = r.fastSplits ? legs(r.fastSplits.at) : null;
        const scale = target / r.avg;
        const max = Math.max(...all);
        plan.append(
          h("h3", { class: "sub-title sub-title--small" }, "Stage by stage"),
          h(
            "div",
            { class: "table-scroll" },
            h(
            "table",
            { class: "ledger ledger--facts train-stages" },
            h(
              "thead",
              null,
              h("tr", null, ...["Stage", "", "Average", "Your quick solves", "Lost", "Target", ""].map((x, i) => h("th", { class: i > 1 && i < 6 ? "tnum" : null }, x))),
            ),
            h(
              "tbody",
              null,
              ...r.plan.stages.map((st, k) =>
                h(
                  "tr",
                  { class: k === weak ? "is-weak" : null },
                  h("td", null, st.name, k === weak ? h("span", { class: "tag tag--key" }, "Weakest") : null),
                  h("td", { class: "bar-cell" }, h("i", { class: "bar", style: { width: Math.max(2, (all[k] / max) * 100) + "%" } })),
                  h("td", { class: "tnum" }, fmtTime(all[k])),
                  h("td", { class: "tnum" }, fast ? fmtTime(fast[k]) : "-"),
                  h("td", { class: "tnum" }, fast ? signed(all[k] - fast[k]) : "-"),
                  h("td", { class: "tnum" }, fmtTime(all[k] * scale)),
                  h("td", { class: "act" }, h("button", { class: "btn btn--small", type: "button", onclick: () => this.start("stage", { stage: k }) }, "Drill it")),
                ),
              ),
            ),
          ),
          ),
          h(
            "p",
            { class: "hint-text" },
            "Lost is the gap between your normal solves and your quickest quarter. The biggest one is the stage to drill.",
          ),
        );
      }
    }
    this.root.append(plan);

    /* ----- drills ----- */
    const stages = r.plan.stages;
    const stageSeg = seg(
      [{ value: "auto", label: "Weakest" }].concat(stages.map((st, k) => ({ value: k, label: short(st.name) }))),
      this.stage,
      (v) => (this.stage = v),
      "Stage",
    );
    const patSeg = seg(PATTERNS, this.pattern, (v) => (this.pattern = v), "Pattern");
    const card = (title, text, record, extra, label, fn) =>
      h(
        "section",
        { class: "drill-card" },
        h("h3", { class: "sub-title sub-title--small" }, title),
        h("p", null, text),
        extra,
        h("div", { class: "drill-record" }, record),
        h("button", { class: "btn btn--primary", type: "button", onclick: fn }, label),
      );
    const recOf = (key, fmt) => {
      const reps = this.store.reps(key);
      if (!reps.length) return "No reps yet";
      return `${reps.length} rep${reps.length === 1 ? "" : "s"} · ${fmt(reps)}`;
    };
    const timeRec = (reps) => `best ${fmtTime(Math.min(...reps.map((x) => x.ms)))} · last 5 ${fmtTime(mean(reps.slice(-5).map((x) => x.ms)))}`;
    const stageKeyNow = this.stage === "auto" ? weak : this.stage;
    this.root.append(
      h(
        "section",
        { class: "stack stat-block" },
        h("h2", { class: "sub-title" }, "Drills"),
        h(
          "div",
          { class: "drill-grid" },
          card(
            "Stage drill",
            "One stage over and over, with everything before it already placed. Each rep is scored against the shortest tile-by-tile line.",
            recOf(this.keyFor("stage", { stage: stageKeyNow }), timeRec),
            stageSeg,
            "Start",
            () => this.start("stage", { stage: this.stage === "auto" ? weak : this.stage }),
          ),
          card(
            "Smooth solve",
            "A full solve where only the stops count. Go slower if that is what it takes to never stop.",
            recOf(this.keyFor("smooth"), (reps) => `fewest stops ${Math.min(...reps.map((x) => x.x))} · last 5 ${mean(reps.slice(-5).map((x) => x.x)).toFixed(1)}`),
            null,
            "Start",
            () => this.start("smooth"),
          ),
          card(
            "Finger sprint",
            "No thinking. Follow the line as fast as your hands go. Wrong keys are counted, not played.",
            recOf(this.keyFor("sprint", { pattern: this.pattern }), (reps) => `best ${Math.max(...reps.map((x) => x.tps)).toFixed(1)} TPS · last 5 ${mean(reps.slice(-5).map((x) => x.tps)).toFixed(1)}`),
            patSeg,
            "Start",
            () => this.start("sprint", { pattern: this.pattern }),
          ),
          card(
            "Pace run",
            `A full solve against the clock at your target (${fmtTime(target)}). Splits show where you are ahead or behind.`,
            recOf(this.keyFor("pace"), (reps) => `${reps.filter((x) => x.ms <= x.x).length} on target · ${timeRec(reps)}`),
            null,
            "Start",
            () => this.start("pace"),
          ),
          card(
            "Coached solve",
            "A normal scramble in practice mode with the coach on. Every move that does not help is flagged with the better one.",
            "Opens on the Play page",
            null,
            "Open",
            () => this.coached(),
          ),
        ),
        h("p", { class: "hint-text" }, "Drill reps are kept here and stay out of your solve stats."),
      ),
    );
  }

  coached() {
    if (this.s.size !== this.N) this.store.set("size", this.N);
    setCoach(this.store, true);
    this.ctx.app.go("play");
  }

  /* ---------- running a drill ---------- */

  keyFor(kind, d = {}) {
    const N = this.N;
    if (kind === "stage") return `stage:${N}:${planFor(N, this.s.coachMethod).id}:${d.stage}`;
    if (kind === "sprint") return `sprint:${N}:${d.pattern}`;
    return `${kind}:${N}`;
  }

  start(kind, opts = {}) {
    const r = this.data || this.read();
    const plan = r.plan;
    const target = this.target(r);
    const d = { kind, plan, target, r, reps: 0, ...opts };
    d.key = this.keyFor(kind, d);
    if (kind === "stage") {
      const st = plan.stages[d.stage];
      d.title = "Stage drill: " + st.name;
      d.what = `Place ${st.tiles.join(", ")}. Everything before it is already home.`;
      const all = r.splits ? legs(r.splits.at) : null;
      d.yours = all ? all[d.stage] : null;
      d.aim = d.yours != null && r.avg ? d.yours * (target / r.avg) : null;
    } else if (kind === "smooth") {
      d.title = "Smooth solve";
      d.limit = Math.max(250, (r.gap || 150) * 3);
      d.what = `Solve it without stopping. A stop is a gap over ${Math.round(d.limit)} ms.`;
    } else if (kind === "sprint") {
      d.title = "Finger sprint: " + PATTERNS.find((p) => p.value === d.pattern).label;
      d.what = "Follow the dashed line. Only the next move on it is played.";
    } else {
      d.title = "Pace run";
      d.what = `Full solve. Target ${fmtTime(target)}.`;
      d.targetAt = r.splits && r.avg ? r.splits.at.map((x) => x * (target / r.avg)) : null;
    }
    this.drill = d;
    this.renderRun();
  }

  leave() {
    this.stopClock();
    this.drill = null;
    this.game = null;
    this.render();
  }

  renderRun() {
    const d = this.drill;
    clear(this.root);
    this.timeEl = h("div", { class: "figure tnum" }, "0.00");
    this.movesEl = h("div", { class: "figure tnum" }, "0");
    this.extraEl = h("div", { class: "figure tnum" }, "0");
    this.extraLabel = h("div", { class: "label" }, d.kind === "smooth" ? "Stops" : d.kind === "sprint" ? "Wrong keys" : d.kind === "stage" ? "Line" : "Target");
    this.boardWrap = h("div", { class: "board-wrap" });
    this.view = new BoardView(this.boardWrap, {
      interactive: true,
      onCell: (cell) => {
        if (this.s.mouseMode !== "hover") this.tryCell(cell);
      },
      onHover: (cell) => {
        if (this.s.mouseMode === "hover") this.tryCell(cell);
      },
      label: "Drill board. Use the arrow keys to slide tiles.",
    });
    this.view.setColoring(this.s.coloring);
    this.splitEl = h("div", { class: "splits", hidden: true });
    this.side = h("aside", { class: "train-side" });
    this.root.append(
      h(
        "div",
        { class: "train-run" },
        h(
          "div",
          { class: "train-main" },
          h(
            "div",
            { class: "train-head" },
            h("div", null, h("div", { class: "label" }, "Training"), h("h1", { class: "sub-title" }, d.title), h("p", { class: "hint-text" }, d.what)),
          ),
          h(
            "div",
            { class: "ticket train-ticket" },
            h("div", { class: "stat" }, h("div", { class: "label" }, "Time"), this.timeEl),
            h("div", { class: "stat" }, h("div", { class: "label" }, "Moves"), this.movesEl),
            h("div", { class: "stat" }, this.extraLabel, this.extraEl),
          ),
          this.boardWrap,
          this.splitEl,
          h(
            "div",
            { class: "controls" },
            h("button", { class: "btn btn--primary", type: "button", onclick: () => this.nextRep() }, "Next rep ", h("kbd", null, "Space")),
            h("button", { class: "btn", type: "button", onclick: () => this.nextRep(true) }, "Same again ", h("kbd", null, "R")),
            h("span", { class: "spacer" }),
            h("button", { class: "btn", type: "button", onclick: () => this.leave() }, "Back to Train ", h("kbd", null, "Esc")),
          ),
        ),
        this.side,
      ),
    );
    this.nextRep();
  }

  nextRep(same = false) {
    const d = this.drill;
    if (!d) return;
    this.stopClock();
    const N = this.N;
    let board;
    let goal = null;
    d.seq = null;
    d.result = null;
    if (same && d.startBoard) board = d.startBoard.slice();
    else if (d.kind === "stage") board = stageScramble(d.plan, d.stage);
    else if (d.kind === "sprint") {
      board = [];
      for (let i = 1; i < N * N; i++) board.push(i);
      board.push(0);
    } else board = E.scrambleFromSeed(E.randomSeed(8), N);
    d.startBoard = board.slice();
    if (d.kind === "stage") {
      const k = d.stage;
      goal = (b) => stageIndex(b, d.plan) > k;
      const line = stageLine(board, d.plan, k);
      d.line = line ? line.length : null;
    } else if (d.kind === "sprint") {
      if (!same || !d.keptSeq) d.keptSeq = patternMoves(N, d.pattern);
      d.seq = d.keptSeq;
      goal = () => this.game.moves.length >= d.seq.length;
    }
    d.stops = 0;
    d.longest = 0;
    d.errors = 0;
    d.at = [];
    d.k = d.kind === "pace" ? stageIndex(board, d.plan) : 0;
    const g = (this.game = new Game({ N, board, mode: "custom", label: "drill", goal }));
    g.on((type, data) => {
      if (type === "start") this.startClock();
      if (type === "move") this.onMove(data);
      if (type === "solved") this.finish();
    });
    this.view.fast = !!this.s.speedMode;
    this.view.clearProofed && this.view.clearProofed();
    this.view.set(g.board, N, { instant: true });
    this.view.enter();
    this.view.setRunning(false);
    this.timeEl.textContent = "0.00";
    this.movesEl.textContent = "0";
    this.extraEl.textContent =
      d.kind === "stage" ? (d.line != null ? String(d.line) : "-") : d.kind === "pace" ? sec(d.target) : "0";
    this.extraEl.classList.remove("is-bad");
    this.paintGuide();
    this.renderSplits();
    this.renderRunSide();
  }

  paintGuide() {
    const d = this.drill;
    const g = this.game;
    if (!d || d.kind !== "sprint" || !g || g.status === "solved") {
      this.view.setGuide(null);
      this.view.markHint(null);
      return;
    }
    const rest = d.seq.slice(g.moves.length);
    const next = E.neighbor(g.blank(), rest[0], g.N);
    this.view.setGuide({ routes: [{ cells: blankPath(g.board, g.N, rest, 5), kind: "blank" }], homes: [], targets: next >= 0 ? [g.board[next]] : [] });
  }

  /* ---------- input ---------- */

  onKey(e) {
    if (!this.drill) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = KEYMAP[this.s.arrowMode] || KEYMAP.tile;
    if (key in map && (key.startsWith("Arrow") || this.s.wasd)) {
      e.preventDefault();
      this.tryMove(map[key], "key");
      return;
    }
    if (key === " ") {
      e.preventDefault();
      this.nextRep();
    } else if (key === "r") {
      e.preventDefault();
      this.nextRep(true);
    } else if (key === "Escape") {
      e.preventDefault();
      this.leave();
    }
  }

  tryMove(dir, source) {
    const g = this.game;
    const d = this.drill;
    if (!g || g.status === "solved") return false;
    if (d.seq && d.seq[g.moves.length] !== dir) {
      if (E.neighbor(g.blank(), dir, g.N) >= 0 || source === "key") {
        d.errors++;
        this.extraEl.textContent = String(d.errors);
        this.extraEl.classList.add("is-bad");
      }
      audio.bump();
      return false;
    }
    if (!g.move(dir, { source })) {
      audio.bump();
      return false;
    }
    return true;
  }

  tryCell(cell) {
    const g = this.game;
    if (!g || g.status === "solved") return;
    const N = g.N;
    const b = g.blank();
    const br = Math.floor(b / N),
      bc = b % N,
      r = Math.floor(cell / N),
      c = cell % N;
    let dir = -1,
      count = 0;
    if (br === r && bc !== c) {
      dir = c > bc ? 3 : 2;
      count = Math.abs(c - bc);
    } else if (bc === c && br !== r) {
      dir = r > br ? 1 : 0;
      count = Math.abs(r - br);
    }
    for (let i = 0; i < count; i++) if (!this.tryMove(dir, "pointer")) break;
  }

  /* ---------- the rep ---------- */

  startClock() {
    this.view.setRunning(true);
    const tick = () => {
      const g = this.game;
      if (!g || g.status !== "running") return;
      this.timeEl.textContent = sec(g.elapsed());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopClock() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  onMove(data) {
    const g = this.game;
    const d = this.drill;
    this.view.set(g.board, g.N);
    this.movesEl.textContent = String(g.moves.length);
    audio.tock({ tile: data.tile, col: data.to % g.N, N: g.N, home: data.to === data.tile - 1 });
    const n = g.times.length;
    if (n > 1) {
      const gap = g.times[n - 1] - g.times[n - 2];
      if (gap > d.longest) d.longest = gap;
      if (d.kind === "smooth" && gap >= d.limit) {
        d.stops++;
        this.extraEl.textContent = String(d.stops);
        this.extraEl.classList.add("is-bad");
      }
    }
    if (d.kind === "pace") {
      const k = stageIndex(g.board, d.plan);
      if (k > d.k) {
        const t = g.elapsed();
        while (d.k < k && d.k < d.plan.stages.length) d.at[d.k++] = t;
        this.renderSplits();
      }
    }
    if (d.kind === "sprint") this.paintGuide();
  }

  finish() {
    const g = this.game;
    const d = this.drill;
    this.stopClock();
    this.view.setRunning(false);
    this.view.setGuide(null);
    this.view.markHint(null);
    const ms = Math.round(g.elapsed());
    const m = g.moves.length;
    this.timeEl.textContent = sec(ms);
    audio.thunk();
    const rep = { d: Date.now(), ms, m };
    if (d.kind === "stage") rep.x = d.line;
    else if (d.kind === "smooth") {
      rep.x = d.stops;
      rep.g = Math.round(d.longest);
    } else if (d.kind === "sprint") {
      rep.x = d.errors;
      rep.tps = ms > 0 ? Math.round((m / (ms / 1000)) * 100) / 100 : 0;
    } else {
      rep.x = Math.round(d.target);
      // exact splits from the finished move log
      const sp = splitsOf(
        { id: "drill" + rep.d, N: g.N, start: g.start, movesArr: g.moves, timesArr: g.times, duration: ms },
        d.plan,
      );
      if (sp) d.at = sp;
      rep.at = d.at.map(Math.round);
      this.renderSplits(true);
    }
    d.result = rep;
    d.reps++;
    this.store.addRep(d.key, rep);
  }

  renderSplits(final = false) {
    const d = this.drill;
    if (!d || d.kind !== "pace" || !d.targetAt) {
      this.splitEl.hidden = true;
      return;
    }
    this.splitEl.hidden = false;
    clear(this.splitEl).append(
      ...d.plan.stages.map((st, i) => {
        const t = d.at[i];
        const dl = t != null ? t - d.targetAt[i] : null;
        return h(
          "div",
          { class: "split" + (t != null ? " is-done" : i === d.k && !final ? " is-now" : "") },
          h("span", { class: "split-name" }, short(st.name)),
          h("span", { class: "split-time tnum" }, fmtTime(t != null ? t : d.targetAt[i])),
          h("span", { class: "split-delta tnum" + (dl == null ? "" : dl <= 0 ? " is-ahead" : " is-behind") }, signed(dl)),
        );
      }),
    );
  }

  renderRunSide() {
    const d = this.drill;
    if (!d || !this.side) return;
    const reps = this.store.reps(d.key);
    const res = d.result;
    clear(this.side);
    const fig = (label, value, sub, cls) =>
      h("div", { class: cls || null }, h("div", { class: "label" }, label), h("div", { class: "figure tnum" }, value), sub ? h("div", { class: "sub" }, sub) : null);

    /* last rep */
    const last = h("section", { class: "train-card" }, h("h2", { class: "sub-title sub-title--small" }, res ? "That rep" : "Ready"));
    if (!res) {
      last.append(h("p", { class: "muted" }, "The clock starts on your first move."));
    } else if (d.kind === "stage") {
      const over = res.x != null ? res.m - res.x : null;
      last.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Time", fmtTime(res.ms), d.aim != null ? `aim ${fmtTime(d.aim)}` : null, d.aim != null && res.ms <= d.aim ? "is-key" : null),
          fig("Moves", res.m, res.x != null ? `line ${res.x}` : null),
          fig("Over the line", over == null ? "-" : over <= 0 ? "0" : "+" + over, over == null ? null : over <= 0 ? "as tight as it gets" : `${sec(over * (res.ms / res.m), 1)} s of moves`, over != null && over <= 0 ? "is-key" : null),
        ),
        d.yours != null
          ? h("p", { class: "hint-text" }, `In real solves this stage takes you ${fmtTime(d.yours)}. At your target it has to take ${fmtTime(d.aim)}.`)
          : null,
      );
    } else if (d.kind === "smooth") {
      last.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Stops", res.x, res.x === 0 ? "none, that is the rep" : `longest ${res.g} ms`, res.x === 0 ? "is-key" : null),
          fig("Time", fmtTime(res.ms)),
          fig("Moves", res.m),
        ),
      );
    } else if (d.kind === "sprint") {
      last.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Speed", res.tps.toFixed(1), "tiles a second", "is-key"),
          fig("Wrong keys", res.x),
          fig("Time", fmtTime(res.ms), `${res.m} moves`),
        ),
        d.r.gap != null ? h("p", { class: "hint-text" }, `Your hands in real solves: ${(1000 / d.r.gap).toFixed(1)} tiles a second between stops.`) : null,
      );
    } else {
      const dl = res.ms - res.x;
      last.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Time", fmtTime(res.ms), `target ${fmtTime(res.x)}`, dl <= 0 ? "is-key" : null),
          fig("Against target", signed(dl), dl <= 0 ? "on pace" : "behind"),
          fig("Moves", res.m),
        ),
      );
    }
    this.side.append(last);

    /* history */
    const hist = h("section", { class: "train-card" }, h("h2", { class: "sub-title sub-title--small" }, "This drill"));
    if (!reps.length) hist.append(h("p", { class: "muted" }, "No reps logged yet."));
    else {
      const val = d.kind === "sprint" ? (x) => x.tps : d.kind === "smooth" ? (x) => x.x : (x) => x.ms;
      const fmt = d.kind === "sprint" ? (v) => v.toFixed(1) : d.kind === "smooth" ? (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) : (v) => fmtTime(v);
      const higher = d.kind === "sprint";
      const vals = reps.map(val);
      const best = higher ? Math.max(...vals) : Math.min(...vals);
      hist.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Reps", reps.length, `${d.reps} this visit`),
          fig("Best", fmt(best)),
          fig("Last 5", fmt(mean(vals.slice(-5)))),
        ),
      );
      // bars for the last 30 reps
      const tail = vals.slice(-30);
      const max = Math.max(...tail, 1e-9);
      hist.append(
        h(
          "div",
          { class: "rep-bars", role: "img", "aria-label": "Last " + tail.length + " reps" },
          ...tail.map((v, i) =>
            h("i", {
              class: v === best ? "is-best" : null,
              style: { height: Math.max(3, (v / max) * 100) + "%" },
              title: fmt(v),
            }),
          ),
        ),
        h("p", { class: "hint-text" }, higher ? "Taller is faster." : d.kind === "smooth" ? "Shorter is fewer stops." : "Shorter is faster."),
      );
    }
    this.side.append(hist);
  }
}

function cell(label, value, sub, cls) {
  return h("div", { class: cls || null }, h("div", { class: "label" }, label), h("div", { class: "figure" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}
