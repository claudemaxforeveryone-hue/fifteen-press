// Blind: memorise the scramble, then solve it with the numbers hidden.
// Its own page, its own settings (settings.blind) and its own records (training reps under
// "blind:<N>"), so nothing here reaches your normal solves, averages or stats.
// The progression is a 4×4 ladder of levels: solve a bigger part of the board blind each time,
// then the same again with the home lights fading out, then with the whole board covered. Its attempts are reps under "blindlv:<level>".
import { BoardView } from "../board-view.js";
import { Game } from "../game.js";
import * as audio from "../audio.js";
import { h, clear, seg, relDate, toast } from "../ui.js";
import { fmtTime, mean } from "../stats.js";
import { ChainTrainer } from "./blind-chain.js";

const E = window.FifteenEngine;

const KEYMAP = {
  tile: { ArrowLeft: 3, ArrowRight: 2, ArrowUp: 1, ArrowDown: 0, a: 3, d: 2, w: 1, s: 0 },
  blank: { ArrowLeft: 2, ArrowRight: 3, ArrowUp: 0, ArrowDown: 1, a: 2, d: 3, w: 0, s: 1 },
};

export const BLIND_DEFAULTS = {
  size: 0, // 0: follow the Play size (3 to 5)
  memo: 0, // seconds to study before the numbers hide. 0: they hide on your first move
  scramble: 0, // moves from solved. 0: a full random scramble
  showHome: true, // tiles still light up when they are home
  peeks: 0, // peeks allowed per attempt. -1: no limit
  peekMs: 1000,
  finish: "auto", // 'auto': stops when solved. 'call': you say when, a wrong call is a DNF
  hideClock: false, // no clock or move count while solving
  mode: "free", // 'free': any size and scramble. 'ladder': the 4×4 progression. 'chain': the chain method trainer
  level: 0, // the level picked in the progression. 0: the first one not passed yet
};

/* ---------- the progression ---------- */

const LADDER_N = 4;
const STEPS = [
  { tiles: [1, 2, 3, 4], name: "Row 1", memo: "Memorise where 1 2 3 4 are.", stop: "row 1 is home" },
  {
    tiles: [1, 2, 3, 4, 5, 9, 13],
    name: "Row 1 and column 1",
    memo: "Memorise 1 2 3 4, then 5 9 13.",
    stop: "row 1 and column 1 are home",
  },
  {
    tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9, 13],
    name: "Row 1, column 1 and 6 7 8",
    memo: "Memorise 1 to 8, then 9 and 13.",
    stop: "rows 1 and 2 and column 1 are home",
  },
  {
    tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14],
    name: "Everything but 11 12 15",
    memo: "Memorise everything except 11 12 15.",
    stop: "only 11 12 15 are left",
  },
  {
    tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    name: "Whole board",
    memo: "Memorise the whole board.",
    stop: "the board is solved",
  },
];
const LIGHTS = { on: "Lights on", flash: "Lights blink", off: "Lights off", dark: "Board covered" };
const LIGHT_NOTE = {
  on: "A tile stays lit while it is home.",
  flash: "A tile blinks once when it lands home, then goes dark.",
  off: "No home lights at all.",
  dark: "The whole board is covered while you solve, like a blindfold. Keys only.",
};
/** Every level, in order: each step with the lights on, then blinking, then off, then with the board covered. */
export const LEVELS = [];
for (const lights of ["on", "flash", "off"])
  for (const st of STEPS) LEVELS.push({ id: LEVELS.length + 1, ...st, lights, finish: "auto" });
LEVELS.push({ id: LEVELS.length + 1, ...STEPS[4], name: "Whole board, you call it", lights: "off", finish: "call" });
for (const st of STEPS.slice(0, 3)) LEVELS.push({ id: LEVELS.length + 1, ...st, lights: "dark", finish: "auto" });
LEVELS.push({ id: LEVELS.length + 1, ...STEPS[4], name: "True blind: whole board, you call it", lights: "dark", finish: "call" });
/** A level is passed with this many clean solves (no peeks) inside this many attempts in a row. */
export const PASS = { need: 4, of: 5 };
const levelKey = (id) => "blindlv:" + id;

/** Where one level stands, from its saved attempts. Repeats of the same scramble do not count. */
export function levelState(reps) {
  const list = reps.filter((r) => !r.retry);
  const clean = (r) => r.ok && !r.pk;
  let passed = null;
  for (let i = 0; i < list.length && !passed; i++)
    if (list.slice(Math.max(0, i - PASS.of + 1), i + 1).filter(clean).length >= PASS.need) passed = list[i].d;
  const last = list.slice(-PASS.of);
  const good = list.filter(clean);
  return {
    tries: list.length,
    passed,
    cleanLast: last.filter(clean).length,
    best: good.length ? Math.min(...good.map((r) => r.ms)) : null,
  };
}

const MEMO = [
  { value: 0, label: "Until first move" },
  { value: 5, label: "5 s" },
  { value: 10, label: "10 s" },
  { value: 20, label: "20 s" },
  { value: 30, label: "30 s" },
  { value: 60, label: "60 s" },
];
const SCRAMBLE = [
  { value: 10, label: "10 moves" },
  { value: 20, label: "20 moves" },
  { value: 40, label: "40 moves" },
  { value: 0, label: "Full" },
];
const PEEKS = [
  { value: 0, label: "None" },
  { value: 1, label: "1" },
  { value: 3, label: "3" },
  { value: -1, label: "No limit" },
];
const PEEK_MS = [
  { value: 500, label: "0.5 s" },
  { value: 1000, label: "1 s" },
  { value: 2000, label: "2 s" },
];
const FINISH = [
  { value: "auto", label: "Stops when solved", title: "The clock stops the moment the board is solved" },
  { value: "call", label: "I call it", title: "Press Enter when you think it is solved. A wrong call is a DNF" },
];

const sec = (ms) => (ms == null || !isFinite(ms) ? "-" : (ms / 1000).toFixed(2));
const scrName = (len) => (len ? len + " move scrambles" : "full scrambles");

/** A scramble `len` moves from solved (never straight back), or a full random one. */
export function blindScramble(N, len) {
  if (!len) return E.scrambleFromSeed(E.randomSeed(8), N);
  for (;;) {
    const b = [];
    for (let i = 1; i < N * N; i++) b.push(i);
    b.push(0);
    let last = -1;
    let made = 0;
    while (made < len) {
      const d = Math.floor(Math.random() * 4);
      if (d === E.INV[last] || E.neighbor(b.indexOf(0), d, N) < 0) continue;
      E.applyMove(b, N, d);
      last = d;
      made++;
    }
    if (!E.isSolved(b)) return b;
  }
}

/** Records for one size, scramble length and home-lights setting, from the saved attempts. */
export function blindRecords(reps, len, home) {
  const list = reps.filter((r) => (r.len || 0) === (len || 0) && (home == null || !!r.home === !!home));
  const solved = list.filter((r) => r.ok);
  const clean = solved.filter((r) => !r.pk && !r.retry);
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && list[i].ok; i--) streak++;
  const last5 = solved.slice(-5);
  return {
    list,
    solved,
    best: clean.length ? Math.min(...clean.map((r) => r.ms)) : null,
    bestAny: solved.length ? Math.min(...solved.map((r) => r.ms)) : null,
    last5: last5.length ? mean(last5.map((r) => r.ms)) : null,
    memo5: last5.length ? mean(last5.map((r) => r.memo)) : null,
    exec5: last5.length ? mean(last5.map((r) => r.exec)) : null,
    rate: list.length ? solved.length / list.length : null,
    streak,
  };
}

function fig(label, value, sub, cls) {
  return h(
    "div",
    { class: cls || null },
    h("div", { class: "label" }, label),
    h("div", { class: "figure tnum" }, value),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

export class BlindView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.N = null;
    this.phase = "ready"; // ready | memo | hidden | solve | done
    this.raf = 0;
    this.memoTimer = 0;
    this.peekTimer = 0;
    this.visit = 0;
    this.lv = null; // the progression level of the attempt on the board, if any
    this.lights = "on"; // 'on' | 'flash' | 'off' | 'dark' for the attempt on the board
    this.flashing = new Map(); // tile -> when its blink ends
    this.chain = new ChainTrainer(this); // the chain method has its own page under the same tab
  }

  get s() {
    return this.store.settings;
  }

  /** Blind settings, with defaults filled in. */
  get o() {
    return { ...BLIND_DEFAULTS, ...(this.s.blind || {}) };
  }

  setOpt(key, value) {
    this.store.set("blind", { ...this.o, [key]: value });
    this.render();
  }

  show() {
    const o = this.o;
    if (!this.N) this.N = o.size || Math.min(5, Math.max(3, this.s.size || 4));
    this.render();
  }

  hide() {
    // an attempt left half way is dropped, not logged
    this.stop();
    this.chain.stop();
    this.phase = "ready";
  }

  onStore(e) {
    if (this.root.hidden) return;
    if (e.type === "profile" || e.type === "all") this.render();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.memoTimer);
    clearTimeout(this.peekTimer);
    this.memoTimer = this.peekTimer = 0;
    this.peeking = false;
  }

  key() {
    return this.lv ? levelKey(this.lv.id) : "blind:" + this.N;
  }

  /** Board size on the page right now: the progression is always 4×4. */
  get n() {
    return this.o.mode === "ladder" ? LADDER_N : this.N;
  }

  /* ---------- progression ---------- */

  levelInfo(id) {
    return levelState(this.store.reps(levelKey(id)));
  }

  /** The first level not passed yet (the last one when all are). */
  firstOpen() {
    for (const lv of LEVELS) if (!this.levelInfo(lv.id).passed) return lv.id;
    return LEVELS.length;
  }

  curLevel() {
    const id = this.o.level || this.firstOpen();
    return LEVELS[Math.min(LEVELS.length, Math.max(1, id)) - 1];
  }

  /** Tiles that count for this attempt: the level's, or all of them. */
  total() {
    return this.lv ? this.lv.tiles.length : this.n * this.n - 1;
  }

  met(board) {
    return this.lv ? this.lv.tiles.every((t) => board[t - 1] === t) : E.isSolved(board);
  }

  /* ---------- page ---------- */

  pageHead() {
    return h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", { class: "section-title" }, "Blind"),
        h("p", null, "Memorise the scramble, then solve it with the numbers hidden. Kept apart from your normal solves."),
      ),
    );
  }

  modeSeg(o) {
    return seg(
      [
        { value: "free", label: "Free", title: "Any size and scramble length, with the settings below" },
        { value: "ladder", label: "Progression", title: "4×4 levels: a bigger part of the board each time, then the lights fade out, then the board is covered" },
        { value: "chain", label: "Chain method", title: "How a full blindfold solve is really done: memorise a chain of numbers, then one run of moves per number" },
      ],
      o.mode,
      (v) => this.setOpt("mode", v),
      "Free play, the progression or the chain method",
    );
  }

  render() {
    this.stop();
    this.chain.stop();
    clear(this.root);
    const o = this.o;
    if (o.mode === "chain") {
      this.phase = "ready";
      this.root.append(this.pageHead(), h("div", { class: "filters" }, this.modeSeg(o), ...this.chain.filters()));
      this.chain.render(this.root);
      return;
    }
    // one big clock, like Play: memo time while you study, solve time while you solve, the total after
    this.clockEl = h("div", { class: "figure timer tnum" }, "0.00");
    this.movesEl = h("div", { class: "figure tnum" }, "0");
    this.peeksEl = h("div", { class: "figure tnum" }, "0");
    this.titleEl = h("h2", { class: "sub-title" }, "");
    this.hintEl = h("p", { class: "hint-text" }, "");
    this.controls = h("div", { class: "controls" });
    this.side = h("aside", { class: "train-side" });
    this.boardWrap = h("div", { class: "board-wrap" });
    this.ladderEl = h("section", { class: "blind-ladder" });
    const ladder = o.mode === "ladder";
    this.view = new BoardView(this.boardWrap, {
      interactive: true,
      onCell: (cell) => {
        if (this.phase === "ready") this.reveal();
        else if (this.s.mouseMode !== "hover") this.tryCell(cell);
      },
      onHover: (cell) => {
        // hover play only once the numbers are hidden, so brushing the board never ends the memo
        if (this.s.mouseMode === "hover" && (this.phase === "hidden" || this.phase === "solve")) this.tryCell(cell);
      },
      label: "Blind board. Use the arrow keys to slide tiles.",
    });

    this.root.append(
      this.pageHead(),
      h(
        "div",
        { class: "filters" },
        this.modeSeg(o),
        ladder
          ? null
          : seg(
              [3, 4, 5].map((n) => ({ value: n, label: n + "×" + n })),
              this.N,
              (v) => {
                this.N = v;
                this.setOpt("size", v);
              },
              "Board size",
            ),
        ladder ? null : seg(SCRAMBLE, o.scramble, (v) => this.setOpt("scramble", v), "Scramble length"),
      ),
      h(
        "div",
        { class: "train-run" },
        h(
          "div",
          { class: "train-main" },
          h("div", { class: "train-head" }, h("div", { class: "label" }, "Blindfold"), this.titleEl, this.hintEl),
          h(
            "div",
            { class: "ticket" },
            h("div", { class: "stat" }, h("div", { class: "label" }, "Time"), this.clockEl),
            h("div", { class: "stat" }, h("div", { class: "label" }, "Moves"), this.movesEl),
            h("div", { class: "stat" }, h("div", { class: "label" }, "Peeks"), this.peeksEl),
          ),
          this.boardWrap,
          this.controls,
        ),
        this.side,
      ),
      this.ladderEl,
      this.settingsBlock(),
    );
    this.deal();
  }

  settingsBlock() {
    const o = this.o;
    const row = (label, control, note) =>
      h("div", { class: "field" }, h("span", null, label), control, note ? h("div", { class: "hint-text" }, note) : null);
    const toggle = (label, key) => {
      const cb = h("input", { type: "checkbox", checked: !!o[key] });
      cb.addEventListener("change", () => this.setOpt(key, cb.checked));
      return h("label", { class: "switch-row", style: { justifyContent: "start", gap: "10px", cursor: "pointer" } }, cb, label);
    };
    return h(
      "section",
      { class: "settings-group" },
      h(
        "header",
        null,
        h("h2", { class: "sub-title" }, "Blind settings"),
        h(
          "p",
          null,
          o.mode === "ladder"
            ? "In the progression the level sets the home lights and how it ends. These still apply."
            : "These only change this page. Records are kept per board size, scramble length and home lights on or off.",
        ),
      ),
      h(
        "div",
        { class: "controls-col" },
        row("Time to memorise", seg(MEMO, o.memo, (v) => this.setOpt("memo", v), "Time to memorise"), "With a limit you get a countdown and the numbers hide at 0. Space hides them sooner."),
        row("Peeks per attempt", seg(PEEKS, o.peeks, (v) => this.setOpt("peeks", v), "Peeks per attempt"), "Press C to peek: the numbers show for a moment. Your best time only counts attempts with no peeks."),
        o.peeks !== 0 ? row("Peek length", seg(PEEK_MS, o.peekMs, (v) => this.setOpt("peekMs", v), "Peek length")) : null,
        o.mode === "ladder"
          ? null
          : row("How it ends", seg(FINISH, o.finish, (v) => this.setOpt("finish", v), "How it ends"), "With \"I call it\" you press Enter when you think it is solved. A wrong call is a DNF."),
        o.mode === "ladder" ? null : toggle("Light up tiles that are home (easier)", "showHome"),
        toggle("Hide the clock and move count while solving", "hideClock"),
      ),
    );
  }

  /* ---------- one attempt ---------- */

  deal({ same = false, reveal = false } = {}) {
    this.stop();
    const N = this.n;
    const lv = (this.lv = this.o.mode === "ladder" ? this.curLevel() : null);
    // the attempt keeps the settings it started with. A level brings its own lights and ending
    const o = (this.opts = lv ? { ...this.o, scramble: 0, finish: lv.finish, showHome: lv.lights !== "off" } : this.o);
    this.lights = lv ? lv.lights : o.showHome ? "on" : "off";
    this.flashing.clear();
    this.justPassed = null;
    let board = same && this.startBoard && this.startBoard.length === N * N ? this.startBoard.slice() : blindScramble(N, o.scramble);
    while (this.met(board)) board = blindScramble(N, o.scramble);
    this.startBoard = board.slice();
    this.retry = !!same;
    this.peeks = 0;
    this.memoMs = null;
    this.memoStart = 0;
    this.result = null;
    const g = (this.game = new Game({
      N,
      board,
      mode: "custom",
      label: "blind",
      goal: o.finish === "call" ? () => false : lv ? (b) => this.met(b) : null,
    }));
    g.on((type, data) => {
      if (type === "start") this.onFirstMove();
      if (type === "move") this.onMove(data);
      if (type === "solved") this.end(true);
    });
    this.view.fast = false;
    this.view.clearProofed();
    this.view.set(g.board, N, { instant: true });
    this.clockEl.textContent = "0.00";
    this.movesEl.textContent = "0";
    this.setPhase("ready");
    if (reveal) this.reveal();
  }

  setPhase(p) {
    this.phase = p;
    if (p === "hidden") this.clockEl.textContent = "0.00";
    this.cover();
    this.renderHead();
    this.renderControls();
    this.renderSide();
    this.renderLadder();
  }

  /** Numbers and home colours on or off for the current phase. */
  cover() {
    const o = this.opts;
    const blind = this.phase === "hidden" || this.phase === "solve";
    const hideNums = (this.phase === "ready" || blind) && !this.peeking;
    this.view.setMods({ "mod-blind": hideNums });
    this.view.setRunning(hideNums);
    this.view.setHidden(blind && this.lights === "dark" && !this.peeking);
    const plain = this.phase === "ready" || (blind && this.lights !== "on" && !this.peeking);
    // a level with the lights on always uses the home-lights colouring, whatever Play uses
    this.view.setColoring(plain ? "plain" : this.lv ? "correct" : this.s.coloring);
    // while you memorise a level, the tiles you do not need are dimmed
    const lv = this.lv;
    const dim = lv && lv.tiles.length < this.n * this.n - 1 && (this.phase === "memo" || (blind && this.peeking));
    for (const [t, el] of this.view.tiles) el.style.opacity = dim && !lv.tiles.includes(t) ? "0.3" : "";
    this.paintFlash();
    const lim = o.peeks;
    this.peeksEl.textContent = lim === 0 ? "off" : lim < 0 ? String(this.peeks) : `${this.peeks}/${lim}`;
  }

  renderHead() {
    const o = this.opts;
    const p = this.phase;
    const r = this.result;
    const lv = this.lv;
    let title, hint;
    if (p === "ready") {
      title = lv ? `Level ${lv.id}: ${lv.name}` : "Ready";
      hint = lv
        ? `${LIGHTS[lv.lights]}. Press Space to see the scramble.`
        : "Press Space to see the scramble. The memo clock starts then.";
    } else if (p === "memo") {
      title = "Memorise";
      hint =
        (lv ? lv.memo + " " : "") +
        (o.memo
          ? `${o.memo} s, then the numbers hide. Space or a move hides them sooner.`
          : lv
            ? "The numbers hide when you press Space or make your first move."
            : "Take your time. The numbers hide when you press Space or make your first move.");
    } else if (p === "hidden") {
      title = "Go";
      hint = this.lights === "dark" ? "The board is covered. Make your first move with the keys." : "The numbers are hidden. Make your first move.";
    } else if (p === "solve") {
      title = "Solving blind";
      hint =
        `Memo ${fmtTime(this.memoMs)}. ` +
        (o.finish === "call"
          ? "Press Enter when you think it is solved."
          : lv
            ? `It stops by itself when ${lv.stop}.`
            : "It stops by itself when the board is solved.");
    } else if (r && r.ok) {
      const next = this.justPassed ? LEVELS[this.justPassed.id] : null;
      title = this.justPassed ? `Level ${this.justPassed.id} passed` : lv && lv.tiles.length < 15 ? "Done" : "Solved";
      hint = `${fmtTime(r.ms)} in total: ${fmtTime(r.memo)} to memorise, ${fmtTime(r.exec)} to solve.`;
      if (this.justPassed)
        hint += next
          ? ` Next is level ${next.id}: ${next.name}, ${LIGHTS[next.lights].toLowerCase()}.`
          : " That was the last level: a real blind solve.";
    } else {
      title = "Did not finish";
      const all = this.total();
      hint = r ? `${all - r.left} of ${all} ${lv ? "tiles you needed" : "tiles"} were home.` : "";
    }
    this.titleEl.textContent = title;
    this.hintEl.textContent = hint;
  }

  renderControls() {
    const o = this.opts;
    const p = this.phase;
    const btn = (label, key, fn, cls) =>
      h("button", { class: "btn" + (cls ? " " + cls : ""), type: "button", onclick: fn }, label, key ? " " : null, key ? h("kbd", null, key) : null);
    clear(this.controls);
    if (p === "ready") this.controls.append(btn("Show the scramble", "Space", () => this.space(), "btn--primary"));
    else if (p === "memo")
      this.controls.append(
        btn("Hide and start", "Space", () => this.space(), "btn--primary"),
        btn("New scramble", "N", () => this.skip()),
      );
    else if (p === "hidden" || p === "solve") {
      if (p === "solve" && o.finish === "call") this.controls.append(btn("Done", "Enter", () => this.call(), "btn--primary"));
      if (o.peeks !== 0) {
        const left = o.peeks < 0 ? null : o.peeks - this.peeks;
        const b = btn(left == null ? "Peek" : `Peek (${left} left)`, "C", () => this.peek());
        b.disabled = left === 0 || this.peeking;
        this.controls.append(b);
      }
      this.controls.append(h("span", { class: "spacer" }), btn("Give up", "Esc", () => this.giveUp()));
    } else {
      this.controls.append(
        btn(this.justPassed && LEVELS[this.justPassed.id] ? "Next level" : "Next scramble", "Space", () => this.space(), "btn--primary"),
        btn("Same again", "R", () => this.again()),
      );
    }
  }

  reveal() {
    if (this.phase !== "ready") return;
    const o = this.opts;
    this.memoStart = performance.now();
    this.setPhase("memo");
    this.view.enter();
    if (o.memo)
      this.memoTimer = setTimeout(() => {
        if (this.phase === "memo") this.setPhase("hidden");
      }, o.memo * 1000);
    this.startClock();
  }

  startClock() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const g = this.game;
      const p = this.phase;
      if (!g || p === "ready" || p === "done") return;
      if (p === "solve") {
        if (!this.opts.hideClock) this.clockEl.textContent = sec(g.elapsed());
        if (this.flashing.size) this.paintFlash();
      } else if (p === "memo") {
        const gone = performance.now() - this.memoStart;
        const lim = (this.opts.memo || 0) * 1000;
        this.clockEl.textContent = sec(lim ? Math.max(0, lim - gone) : gone);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  onFirstMove() {
    clearTimeout(this.memoTimer);
    this.memoMs = Math.max(0, Math.round(this.game.t0 - this.memoStart));
    this.clockEl.textContent = this.opts.hideClock ? "-" : "0.00";
    if (this.opts.hideClock) this.movesEl.textContent = "-";
    this.setPhase("solve");
  }

  onMove(data) {
    const g = this.game;
    const o = this.opts;
    this.view.set(g.board, g.N);
    if (!o.hideClock) this.movesEl.textContent = String(g.moves.length);
    const home = data.to === data.tile - 1;
    if (this.lights === "flash" && home) this.flashing.set(data.tile, performance.now() + 450);
    this.paintFlash();
    // the home ping would give positions away when home tiles are not lit
    audio.tock({ tile: data.tile, col: data.to % g.N, N: g.N, home: (this.lights === "on" || this.lights === "flash") && home });
  }

  /** Lights blink: a tile that just landed home shows its home colour for a moment, then goes dark. */
  paintFlash() {
    if (!this.flashing.size) return;
    const blind = (this.phase === "hidden" || this.phase === "solve") && !this.peeking;
    const now = performance.now();
    let ended = false;
    for (const [t, until] of this.flashing)
      if (!blind || now >= until || this.game.board[t - 1] !== t) {
        this.flashing.delete(t);
        ended = true;
      }
    if (ended && blind) this.view.paint();
    for (const t of this.flashing.keys()) {
      const el = this.view.tiles.get(t);
      if (!el) continue;
      el.style.setProperty("--tile-ink", "var(--home-ink)");
      el.style.setProperty("--tile-face", "var(--home)");
    }
  }

  peek() {
    const o = this.opts;
    if (this.phase !== "hidden" && this.phase !== "solve") return;
    if (o.peeks === 0 || this.peeking || (o.peeks > 0 && this.peeks >= o.peeks)) {
      audio.bump();
      return;
    }
    this.peeks++;
    this.peeking = true;
    this.cover();
    this.renderControls();
    this.peekTimer = setTimeout(() => {
      this.peeking = false;
      if (this.phase === "hidden" || this.phase === "solve") {
        this.cover();
        this.renderControls();
      }
    }, o.peekMs);
  }

  call() {
    if (this.phase !== "solve" || this.opts.finish !== "call") return;
    this.end(this.met(this.game.board));
  }

  giveUp() {
    if (this.phase !== "hidden" && this.phase !== "solve") return;
    this.end(false);
  }

  end(ok) {
    if (this.phase === "done" || this.phase === "ready") return;
    const g = this.game;
    const o = this.opts;
    const now = performance.now();
    this.stop();
    if (g.status === "running") {
      g.finishedAt = now;
      g.status = ok ? "solved" : "failed";
    }
    const exec = g.moves.length ? Math.round(g.elapsed()) : 0;
    const memo = this.memoMs != null ? this.memoMs : Math.max(0, Math.round(now - this.memoStart));
    const lv = this.lv;
    let left = 0;
    if (lv) left = lv.tiles.filter((t) => g.board[t - 1] !== t).length;
    else for (let c = 0; c < g.board.length; c++) if (g.board[c] && g.board[c] !== c + 1) left++;
    const rep = {
      d: Date.now(),
      ok: ok ? 1 : 0,
      ms: memo + exec,
      memo,
      exec,
      m: g.moves.length,
      pk: this.peeks,
      len: o.scramble || 0,
      lim: o.memo || 0,
      home: this.lights === "on" ? 1 : 0,
      call: o.finish === "call" ? 1 : 0,
      retry: this.retry ? 1 : 0,
      left,
    };
    if (lv) rep.lv = lv.id;
    this.flashing.clear();
    this.result = rep;
    this.visit++;
    this.clockEl.textContent = sec(memo + exec);
    this.movesEl.textContent = String(rep.m);
    this.phase = "done";
    const wasPassed = lv ? this.levelInfo(lv.id).passed : null;
    this.store.addRep(this.key(), rep);
    if (lv && !wasPassed && this.levelInfo(lv.id).passed) {
      // first pass of this level: the next one is up
      this.justPassed = lv;
      const next = LEVELS[lv.id];
      if (next) this.store.set("blind", { ...this.o, level: next.id });
    }
    this.setPhase("done");
    if (ok) {
      this.view.inkWave();
      audio.thunk();
    } else audio.fail();
  }

  /* ---------- input ---------- */

  space() {
    const p = this.phase;
    if (p === "ready") this.reveal();
    else if (p === "memo") this.hideNow();
    else if (p === "done") this.deal({ reveal: true });
    else toast("Esc gives up this attempt");
  }

  /** Done memorising: hide the numbers and wait for the first move. */
  hideNow() {
    if (this.phase !== "memo") return;
    clearTimeout(this.memoTimer);
    this.setPhase("hidden");
  }

  /** A different scramble while still memorising. Nothing is logged. */
  skip() {
    if (this.phase === "memo") this.deal({ reveal: true });
  }

  again() {
    if (this.phase === "done") this.deal({ same: true, reveal: true });
  }

  onKey(e) {
    if (this.o.mode === "chain") return this.chain.onKey(e);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = KEYMAP[this.s.arrowMode] || KEYMAP.tile;
    if (key in map && (key.startsWith("Arrow") || this.s.wasd)) {
      e.preventDefault();
      this.tryMove(map[key], "key");
      return;
    }
    if (key === " ") {
      e.preventDefault();
      this.space();
    } else if (key === "r") {
      e.preventDefault();
      this.again();
    } else if (key === "n") {
      e.preventDefault();
      this.skip();
    } else if (key === "c" || key === "p") {
      e.preventDefault();
      this.peek();
    } else if (key === "Enter") {
      if (this.phase === "solve" && this.opts.finish === "call") {
        e.preventDefault();
        this.call();
      }
    } else if (key === "Escape") {
      e.preventDefault();
      this.giveUp();
    }
  }

  tryMove(dir, source) {
    const g = this.game;
    const p = this.phase;
    if (!g || p === "ready" || p === "done") return false;
    if (!g.move(dir, { source })) {
      audio.bump();
      return false;
    }
    return true;
  }

  tryCell(cell) {
    const g = this.game;
    if (!g) return;
    if (this.phase === "ready") return;
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

  /* ---------- records ---------- */

  renderSide() {
    if (!this.side) return;
    const o = this.opts || this.o;
    const lv = this.lv;
    const reps = this.store.reps(this.key());
    const rec = lv ? blindRecords(reps, 0, null) : blindRecords(reps, o.scramble, o.showHome);
    const st = lv ? levelState(reps) : null;
    const res = this.result;
    clear(this.side);

    if (res) {
      const all = this.total();
      const isBest = res.ok && !res.pk && !res.retry && rec.best === res.ms && rec.solved.length > 1;
      this.side.append(
        h(
          "section",
          { class: "train-card" },
          h("h2", { class: "sub-title sub-title--small" }, res.ok ? (isBest ? "That attempt: new best" : "That attempt") : "That attempt: DNF"),
          h(
            "div",
            { class: "train-figs" },
            fig("Total", res.ok ? fmtTime(res.ms) : "DNF", res.ok ? null : `${all - res.left} of ${all} home`, res.ok ? "is-key" : null),
            fig("Memo", fmtTime(res.memo)),
            fig("Solve", fmtTime(res.exec), `${res.m} moves` + (res.pk ? `, ${res.pk} peek${res.pk === 1 ? "" : "s"}` : "")),
          ),
        ),
      );
    }

    const card = h(
      "section",
      { class: "train-card" },
      h("h2", { class: "sub-title sub-title--small" }, lv ? `Level ${lv.id} of ${LEVELS.length}` + (st.passed ? ": passed" : "") : "Blind records"),
      h(
        "p",
        { class: "hint-text" },
        lv
          ? `${lv.name}. ${LIGHTS[lv.lights]}: ${LIGHT_NOTE[lv.lights]}` + (lv.finish === "call" ? " It does not stop by itself: press Enter when you think it is solved." : "")
          : `${this.N}×${this.N}, ${scrName(o.scramble)}, home lights ${o.showHome ? "on" : "off"}`,
      ),
      lv
        ? h(
            "p",
            { class: "hint-text" },
            st.passed
              ? `Goal reached ${relDate(st.passed)}.`
              : `Goal: ${PASS.need} clean solves in your last ${PASS.of} tries. Clean means no peeks, and "Same again" does not count.`,
          )
        : null,
    );
    if (!rec.list.length) card.append(h("p", { class: "muted" }, lv ? "No tries on this level yet." : "No attempts yet with these settings."));
    else {
      card.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Best", fmtTime(rec.best), rec.best == null ? (rec.bestAny != null ? "no clean solve yet" : "no solve yet") : "no peeks", rec.best != null ? "is-key" : null),
          fig("Last 5", fmtTime(rec.last5), "solved ones"),
          fig("Solved", Math.round(rec.rate * 100) + "%", `${rec.solved.length} of ${rec.list.length}`),
        ),
        h(
          "div",
          { class: "train-figs" },
          lv
            ? fig("Clean", `${st.cleanLast}/${PASS.of}`, st.passed ? "passed" : `need ${PASS.need}`, st.passed ? "is-key" : null)
            : fig("Streak", rec.streak, "solved in a row"),
          fig("Memo", fmtTime(rec.memo5), "last 5"),
          fig("Solve", fmtTime(rec.exec5), "last 5"),
        ),
      );
      const tail = rec.list.slice(-30);
      const max = Math.max(...tail.map((r) => r.ms), 1);
      card.append(
        h(
          "div",
          { class: "rep-bars", role: "img", "aria-label": "Last " + tail.length + " attempts" },
          ...tail.map((r) =>
            h("i", {
              class: r.ok && r.ms === rec.best ? "is-best" : null,
              style: { height: Math.max(3, (r.ms / max) * 100) + "%", opacity: r.ok ? null : "0.25" },
              title: (r.ok ? fmtTime(r.ms) : "DNF") + ", " + relDate(r.d),
            }),
          ),
        ),
        h("p", { class: "hint-text" }, "Each bar is an attempt, shorter is faster. Faded bars did not finish."),
      );
    }
    this.side.append(card);

    if (rec.list.length) {
      const rows = rec.list.slice(-8).reverse();
      this.side.append(
        h(
          "section",
          { class: "train-card" },
          h("h2", { class: "sub-title sub-title--small" }, "Last attempts"),
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "ledger" },
              h("thead", null, h("tr", null, ...["Result", "Memo", "Solve", "Moves", "Peeks"].map((x) => h("th", { class: "tnum" }, x)))),
              h(
                "tbody",
                null,
                ...rows.map((r) =>
                  h(
                    "tr",
                    { title: relDate(r.d) + (r.retry ? ", same scramble again" : "") },
                    h("td", { class: "tnum" }, r.ok ? fmtTime(r.ms) : "DNF"),
                    h("td", { class: "tnum" }, fmtTime(r.memo)),
                    h("td", { class: "tnum" }, fmtTime(r.exec)),
                    h("td", { class: "tnum" }, r.m),
                    h("td", { class: "tnum" }, r.pk || ""),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  /* ---------- the ladder ---------- */

  renderLadder() {
    const el = this.ladderEl;
    if (!el) return;
    clear(el);
    el.hidden = this.o.mode !== "ladder";
    if (el.hidden) return;
    const cur = this.curLevel().id;
    const open = this.firstOpen();
    const pick = (id) => this.setOpt("level", id);
    el.append(
      h("h2", { class: "sub-title" }, "The progression"),
      h(
        "p",
        { class: "hint-text" },
        `Pass a level with ${PASS.need} clean solves in your last ${PASS.of} tries, then the next one opens up. Click any level to play it.`,
      ),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "ledger" },
          h("thead", null, h("tr", null, h("th", { class: "tnum" }, "Level"), h("th", null, "Solve blind"), h("th", null, "Home lights"), h("th", null, "Goal"))),
          h(
            "tbody",
            null,
            ...LEVELS.map((lv) => {
              const st = this.levelInfo(lv.id);
              const status = st.passed
                ? "passed, best " + fmtTime(st.best)
                : st.tries
                  ? `${st.cleanLast} of ${PASS.need} clean`
                  : lv.id === open
                    ? "you are here"
                    : "";
              const tr = h(
                "tr",
                {
                  class: "is-link" + (lv.id === cur ? " is-me" : ""),
                  tabindex: "0",
                  "aria-current": lv.id === cur ? "true" : null,
                  title: LIGHT_NOTE[lv.lights],
                  onclick: () => pick(lv.id),
                },
                h("td", { class: "tnum" }, lv.id),
                h("td", null, lv.name),
                h("td", null, LIGHTS[lv.lights]),
                h("td", null, status),
              );
              tr.addEventListener("keydown", (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.stopPropagation();
                pick(lv.id);
              });
              return tr;
            }),
          ),
        ),
      ),
    );
  }
}
