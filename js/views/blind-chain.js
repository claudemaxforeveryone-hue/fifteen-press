// Blind, the chain method: the way a 4×4 is solved fully blindfolded.
// You do not hold the board in your head. You read off a chain of numbers, then every number in
// the chain is one fixed run of moves that sends the tile in the start spot (spot 15) home.
// Every run also trades spots 11 and 12, which is why those two have their own rule.
// A lesson that walks through the whole idea, then three stages: learn the moves for one number,
// memorise a chain, solve blind.
// Its attempts are training reps under "blindch:...", apart from everything else.
import { BoardView } from "../board-view.js";
import * as audio from "../audio.js";
import { h, clear, seg, toast } from "../ui.js";
import { fmtTime, mean } from "../stats.js";

const E = window.FifteenEngine;
const N = 4;
const BUF = 14; // spot 15, left of the empty corner
const VIDEO = "https://www.youtube.com/watch?v=4hRvVgrYwyY";

export const CHAIN_DEFAULTS = {
  stage: "lesson", // 'lesson' | 'moves' | 'memo' | 'solve'
  num: 14, // the number being learned
  link: "odd", // 11 and 12 only: is it an odd or an even link of the chain
  how: "follow", // 'follow': the moves are shown. 'memory': nothing shown. 'test': every ticked number, random order
  got: [], // the numbers you ticked as "I've got it". The test asks these
  len: 4, // links in a practice scramble. 0: a full scramble
  see: "open", // while solving: 'open' numbers shown, 'hidden' numbers hidden, 'dark' board covered
  help: true, // the chain and the moves for the current link stay on screen while solving
};

// written as tile moves, like the video: D = a tile slides down into the gap
const T2B = { D: 0, U: 1, R: 2, L: 3 };
const parse = (s) => s.split(" ").flatMap((tok) => Array(Number(tok.slice(1) || 1)).fill(T2B[tok[0]]));
/** 11 and 12 take four moves. This way round the start tile goes to spot 11, 11 to 12, 12 to the start spot. */
const INTO_11 = parse("D R U L");
/** And this way round the start tile goes to spot 12, 12 to 11, 11 to the start spot. */
const INTO_12 = parse("R D L U");
/**
 * The run of moves for every other number: bring the target tile next to the corner, trade, walk back, trade,
 * with every move that cancels left out. Checked against the solver (LONGER lists the ones it can beat). A run trades the
 * tile in the start spot (spot 15) with the tile in that number's spot, and trades spots 11 and 12.
 */
const RUN = {
  1: "D3 R3 U L D L U R U L D L U R U L D2 R U R D L D R U R D L3 U2 R U L", // 40
  2: "D2 R2 D L U R U L D L U R U L D2 R U R D L D R U L2 U R U L", // 32
  3: "D2 R D R U2 L D L U R U L D2 R U R D2 L U L U R U L", // 28
  4: "D3 R U2 L D R U2 L D R D L U R D2 L U2 R U L", // 26
  5: "R D2 R2 U L D L U R U L2 D R U R D L D R U R D L2 U2 L D R U L", // 34
  6: "D2 R2 U L D L U R U L D2 R U R D L2 U R U L", // 24
  7: "D R D L U R U L D2 R U2 L", // 14
  8: "D2 R U2 L D R D L U R U L", // 14
  9: "R D R2 D L2 U R U L2 D R U R D L D R2 U L2 U L D R U L", // 30
  10: "R D R U L2 D R U R D L U L D R U L", // 18
  13: "R3 D L U L D R U L2 D R U R D L U R D R U L3 D R U L", // 30
  14: "R2 D L U L D R2 U L2 D R U L", // 16
};
for (const k of Object.keys(RUN)) RUN[k] = parse(RUN[k]);
/** Runs a little longer than the solver's shortest, kept because they are easier to remember: number -> shortest length. */
const LONGER = { 1: 38, 2: 30, 3: 26, 5: 30, 6: 22, 9: 24, 13: 26 };
/** Shortest runs first: the order to learn them in, and the spots a new chain starts on. */
const ORDER = [8, 7, 14, 10, 6, 4, 3, 13, 9, 2, 5, 1, 11, 12];

/**
 * The moves for one link of the chain.
 * `done` is how many links came before it. That only matters for 11 and 12: an odd link
 * (1st, 3rd...) goes to the other one's spot, an even link goes to its own.
 */
export function linkMoves(t, done = 0) {
  if (t === 11 || t === 12) {
    const spot = done % 2 === 1 ? t : t === 11 ? 12 : 11;
    return [{ name: `Into spot ${spot}`, moves: spot === 11 ? INTO_11 : INTO_12 }];
  }
  return [{ name: "Moves", moves: RUN[t] }];
}

const flat = (parts) => parts.flatMap((p) => p.moves);
const same = (a, b) => a.every((v, i) => v === b[i]);
/** Everything one finished link can be: the twelve runs, and the two ways round for 11 and 12. */
const LINKS = [...Object.values(RUN), INTO_11, INTO_12];
function run(board, moves) {
  const b = board.slice();
  for (const m of moves) E.applyMove(b, N, m);
  return b;
}

/** A chain that solves this board (empty spot in the corner). New loops start on the easiest spot. */
export function chainFor(board) {
  const L = board.slice(0, 15);
  const chain = [];
  while (chain.length < 40) {
    let t = L[BUF];
    if (t === 15) {
      t = ORDER.find((x) => L[x - 1] !== x);
      if (!t) break;
    }
    chain.push(t);
    [L[t - 1], L[BUF]] = [L[BUF], L[t - 1]];
  }
  return chain;
}

/** The board after each link of a chain: [start, after link 1, after link 2, ...]. */
export function checkpoints(board, chain) {
  const out = [board.slice()];
  chain.forEach((t, i) => out.push(run(out[i], flat(linkMoves(t, i)))));
  return out;
}

/* ---------- drawing ---------- */

const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

/**
 * The cells the empty spot visits for a run of moves, cut into legs that never cross themselves,
 * so each leg draws as one clean line. A leg may end by coming back to its own start.
 */
export function legsOf(moves, from = N * N - 1) {
  const legs = [];
  let cur = from;
  let leg = { cells: [cur], dirs: [], first: 0 };
  moves.forEach((m, i) => {
    const nx = E.neighbor(cur, m, N);
    if (leg.cells.includes(nx)) {
      if (nx === leg.cells[0] && leg.cells.length > 2) {
        leg.cells.push(nx);
        leg.dirs.push(m);
        legs.push(leg);
        leg = { cells: [nx], dirs: [], first: i + 1 };
      } else {
        legs.push(leg);
        leg = { cells: [cur, nx], dirs: [m], first: i };
      }
    } else {
      leg.cells.push(nx);
      leg.dirs.push(m);
    }
    cur = nx;
  });
  if (leg.dirs.length) legs.push(leg);
  return legs;
}

/** A run in pieces for the eye: each piece is one walk of the empty spot that never crosses itself. */
const pieces = (moves) => legsOf(moves).map((leg, i) => ({ name: String(i + 1), moves: leg.dirs }));

/* ---------- the lesson ---------- */

/** The whole method on one small scramble, a step at a time. */
function lessonSteps() {
  const EX = [1, 2, 7, 4, 15, 6, 5, 8, 9, 10, 11, 12, 13, 3, 14, 0];
  const list = [14, 3, 7, 5];
  const solved = E.solvedBoard(N);
  const steps = [
    {
      title: "The idea",
      text: "You never remember where every tile is. You remember a short list of numbers, then you play that list back with moves you know by heart. This scramble needs a list of only four.",
      board: EX,
    },
    {
      title: "The start spot",
      text: "This is the spot where 15 belongs, next to the empty corner. Call it the start spot (cubers call it the buffer). Every tile goes home through it.",
      board: EX,
      cells: [[14, "start"]],
    },
    {
      title: "Reading the list",
      text: "Look at the tile in the start spot. It is 14. So 14 is first on your list.",
      board: EX,
      cells: [[14, "start"]],
      list: [14],
    },
    {
      title: "Follow it home",
      text: "Now look at where 14 belongs: spot 14. The tile sitting there is 3. So 3 is next on the list.",
      board: EX,
      cells: [[13, "spot 14"]],
      arrows: [[14, 13]],
      list: [14, 3],
    },
    {
      title: "Again",
      text: "Where does 3 belong? Spot 3. The tile sitting there is 7. Next on the list: 7.",
      board: EX,
      cells: [[2, "spot 3"]],
      arrows: [[13, 2]],
      list: [14, 3, 7],
    },
    {
      title: "And again",
      text: "Spot 7 holds 5. Next on the list: 5.",
      board: EX,
      cells: [[6, "spot 7"]],
      arrows: [[2, 6]],
      list,
    },
    {
      title: "The list is done",
      text: "Spot 5 holds 15, the tile that belongs in the start spot. That closes the list. Your whole memo is 14 3 7 5. From here the board could be covered.",
      board: EX,
      cells: [[4, "spot 5"]],
      arrows: [[6, 4]],
      list,
    },
    {
      title: "One run of moves per number",
      text: "Solving is simple from here. Every number has its own run of moves, and you learn it by heart. A run does one job: the tile in the start spot and the tile in that number's spot trade places. Watch the run for 14 on a solved board: 14 and 15 trade. So do 11 and 12, every time, and the next run trades them back.",
      board: solved,
      play: RUN[14],
      parts: pieces(RUN[14]),
      cells: [
        [14, "start"],
        [13, "spot 14"],
      ],
    },
  ];
  let b = EX;
  const play = (o) => {
    steps.push({ ...o, board: b, list });
    b = run(b, o.play);
  };
  const say = [
    [14, "Back to the scramble. First on the list is 14, so do the run for 14. The 14 in the start spot goes home to spot 14, and the 3 that was sitting there lands in the start spot, ready to be next."],
    [3, "3 is in the start spot and next on the list. Do the run for 3: 3 goes home and 7 arrives in the start spot."],
    [7, "Now 7. It goes home and 5 arrives in the start spot."],
    [5, "Last one. 5 goes home, 15 drops into the start spot, and 11 and 12 end up back in place. Solved, and you never needed to see the board."],
  ];
  say.forEach(([t, text], k) =>
    play({
      title: "Do " + t,
      text,
      play: RUN[t],
      parts: pieces(RUN[t]),
      fast: k > 0,
      cells: [
        [14, "start"],
        [t - 1, "spot " + t],
      ],
      cellsAfter: k < 3 ? [[14, "start"]] : [],
      listAt: k,
      listAfter: k + 1,
    }),
  );
  steps.push({
    title: "That is the whole method",
    text: "So the real work is one run per number, learned once. They are short: 8 and 7 take 14 moves, 14 takes 16. 1 Moves teaches them one at a time with a map of the path, and Test checks the ones you ticked.",
    board: b,
    list,
    listAt: 4,
    last: true,
  });
  return steps;
}

/** A scramble with the empty spot in the corner: `len` links from solved, or fully random. */
export function chainScramble(len) {
  for (;;) {
    let b;
    if (len) {
      const pool = ORDER.filter((t) => t !== 11 && t !== 12);
      b = E.solvedBoard(N);
      for (let i = 0; i < len; i++) b = run(b, flat(linkMoves(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], i)));
    } else {
      const a = Array.from({ length: 15 }, (_, i) => i + 1);
      for (let i = 14; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      let inv = 0;
      for (let i = 0; i < 15; i++) for (let j = i + 1; j < 15; j++) if (a[i] > a[j]) inv++;
      if (inv % 2) [a[0], a[1]] = [a[1], a[0]];
      b = [...a, 0];
    }
    if (!E.isSolved(b)) return b;
  }
}

/** Best, last 5 and success rate from a list of reps. */
function tally(reps) {
  const ok = reps.filter((r) => r.ok);
  let streak = 0;
  for (let i = reps.length - 1; i >= 0 && reps[i].ok; i--) streak++;
  return {
    n: reps.length,
    ok: ok.length,
    best: ok.length ? Math.min(...ok.map((r) => r.ms)) : null,
    last5: ok.length ? mean(ok.slice(-5).map((r) => r.ms)) : null,
    streak,
  };
}

/** A small caption above a line of moves or numbers. */
const cap = (text) => h("div", { style: { font: "400 11px/1 var(--ui)", color: "var(--ink-3)", letterSpacing: "0.04em" } }, text);

function fig(label, value, sub, cls) {
  return h(
    "div",
    { class: cls || null },
    h("div", { class: "label" }, label),
    h("div", { class: "figure tnum" }, value),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

const STAGES = [
  { value: "lesson", label: "Lesson", title: "The whole idea, one step at a time" },
  { value: "moves", label: "1 Moves", title: "Learn the run of moves for one number" },
  { value: "memo", label: "2 Chain", title: "Read the chain off a scramble and remember it" },
  { value: "solve", label: "3 Solve", title: "Memorise, then solve with the chain" },
];
const LEN = [
  { value: 2, label: "2 links" },
  { value: 4, label: "4 links" },
  { value: 8, label: "8 links" },
  { value: 0, label: "Full" },
];
const SEE = [
  { value: "open", label: "Numbers shown", title: "Watch what every run of moves does" },
  { value: "hidden", label: "Numbers hidden", title: "You see the tiles slide, not which is which" },
  { value: "dark", label: "Board covered", title: "Like a blindfold. Keys only" },
];
const LEARNED = 3; // from memory, in a row

export class ChainTrainer {
  constructor(host) {
    this.host = host;
    this.store = host.store;
    this.raf = 0;
    this.timer = 0;
    this.phase = "ready";
  }

  get s() {
    return this.store.settings;
  }

  get c() {
    const c = { ...CHAIN_DEFAULTS, ...((this.s.blind || {}).chain || {}) };
    if (c.how === "own") c.how = "follow"; // saved by a version that still had "My own way"
    return c;
  }

  set(key, value) {
    this.store.set("blind", { ...this.host.o, chain: { ...this.c, [key]: value } });
    this.host.render();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.raf = this.timer = 0;
    this.peeking = false;
  }

  /** A link's moves as they are shown: a run in the same pieces as its path maps. */
  shownParts(t, done = 0) {
    return t === 11 || t === 12 ? linkMoves(t, done) : pieces(RUN[t]);
  }

  /** The numbers you ticked as "I've got it". */
  got() {
    const g = this.c.got;
    return Array.isArray(g) ? ORDER.filter((n) => g.includes(n)) : [];
  }

  toggleGot(t) {
    const g = new Set(this.got());
    if (g.has(t)) g.delete(t);
    else g.add(t);
    this.quiz = null;
    this.set(
      "got",
      ORDER.filter((n) => g.has(n)),
    );
  }

  /** Several options in one go. */
  setMany(patch) {
    this.store.set("blind", { ...this.host.o, chain: { ...this.c, ...patch } });
    this.host.render();
  }

  /** A test round: every ticked number once, shuffled. 11 and 12 get a random odd or even link. */
  newQuiz(pool) {
    const queue = pool.map((n) => ({ n, done: n === 11 || n === 12 ? Math.floor(Math.random() * 2) : 0 }));
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    // not the same first question as the last one of the round before
    if (queue.length > 1 && queue[0].n === this.lastAsked) queue.push(queue.shift());
    return { pool: pool.join(), queue, i: 0, right: 0, missed: [], over: false };
  }

  /** The arrow for a move, as the key you press for it. */
  arrow(dir) {
    return (this.s.arrowMode === "blank" ? "↑↓←→" : "↓↑→←")[dir];
  }

  /** The pickers that sit on the title's line. */
  filters() {
    const c = this.c;
    return [
      seg(STAGES, c.stage, (v) => this.set("stage", v), "Stage"),
      c.stage === "lesson"
        ? null
        : c.stage === "moves"
        ? seg(
            [
              { value: "follow", label: "Follow", title: "The moves are on screen and only the right move goes through" },
              { value: "memory", label: "From memory", title: "The moves are hidden. This is what counts as learned" },
              { value: "test", label: "Test", title: "Every number you ticked, in random order, from memory" },
            ],
            c.how,
            (v) => this.set("how", v),
            "Moves shown, from memory or a test",
          )
        : seg(LEN, c.len, (v) => this.set("len", v), "Chain length"),
    ].filter(Boolean);
  }

  /* ---------- page ---------- */

  render(root) {
    this.stop();
    const c = this.c;
    this.titleEl = h("h2", { class: "sub-title" }, "");
    this.hintEl = h("p", { class: "hint-text" }, "");
    this.lineEl = h("div", { style: { minHeight: "52px", display: "flex", flexWrap: "wrap", alignItems: "end", gap: "8px 20px", marginTop: "12px" } });
    this.clockEl = h("div", { class: "figure timer tnum" }, "0.00");
    this.movesEl = h("div", { class: "figure tnum" }, "0");
    this.thirdEl = h("div", { class: "figure tnum" }, "0");
    this.thirdLabel = h("div", { class: "label" }, "");
    this.movesLabel = h("div", { class: "label" }, "Moves");
    this.controls = h("div", { class: "controls" });
    this.side = h("aside", { class: "train-side" });
    this.boardWrap = h("div", { class: "board-wrap" });
    this.view = new BoardView(this.boardWrap, {
      interactive: true,
      onCell: (cell) => this.onCell(cell),
      onHover: (cell) => {
        // hover play never starts an attempt by brushing the board
        if (this.s.mouseMode === "hover" && this.moving() && this.phase !== "memo") this.slideTo(cell);
      },
      label: "Blind board. Use the arrow keys to slide tiles.",
    });
    root.append(
      h(
        "div",
        { class: "train-run" },
        h(
          "div",
          // the line of moves sits above the board, so the board gives up a little height for it
          { class: "train-main", style: { width: "clamp(360px, calc(100vh - 500px), 620px)" } },
          h("div", { class: "train-head" }, this.titleEl, this.hintEl, this.lineEl),
          (this.ticket = h(
            "div",
            { class: "ticket" },
            h("div", { class: "stat" }, h("div", { class: "label" }, "Time"), this.clockEl),
            h("div", { class: "stat" }, this.movesLabel, this.movesEl),
            h("div", { class: "stat" }, this.thirdLabel, this.thirdEl),
          )),
          this.boardWrap,
          this.controls,
        ),
        this.side,
      ),
      this.howItWorks(),
    );
    this.stage = c.stage;
    this.ov = null;
    this.movesLabel.textContent = c.stage === "memo" ? "Slips" : "Moves";
    this.ticket.hidden = c.stage === "lesson";
    if (c.stage === "lesson") this.startLesson();
    else if (c.stage === "moves") this.startMoves();
    else if (c.stage === "memo") this.startMemo();
    else this.startSolve();
  }

  howItWorks() {
    const li = (t) => h("li", null, t);
    return h(
      "section",
      { class: "blind-ladder" },
      h("h2", { class: "sub-title" }, "How the chain method works"),
      h(
        "ol",
        { class: "hint-text", style: { display: "grid", gap: "6px", paddingLeft: "20px", margin: "0" } },
        li("The empty spot stays in the bottom right corner. The spot left of it, where 15 lives, is the start spot (the buffer)."),
        li("Read the tile in the start spot. Its number is the first link of your chain."),
        li("Look at that number's home and read the tile sitting there. That is the next link. Keep going until every tile is covered."),
        li("To solve, do the run of moves for each link in order. Each run sends the start spot's tile home."),
        li("Every run also trades spots 11 and 12. So when 11 or 12 is an odd link (1st, 3rd, 5th) it goes to the other one's spot, and as an even link to its own."),
      ),
      h(
        "p",
        { class: "hint-text" },
        "This is the method from ",
        h("a", { href: VIDEO, target: "_blank", rel: "noopener" }, "How To Solve a 15 Puzzle Blindfolded"),
        " by Bobby Mack. On a normal scramble, first slide the empty spot to the corner in your head.",
      ),
    );
  }

  /* ---------- shared ---------- */

  head(title, hint) {
    this.titleEl.textContent = title;
    this.hintEl.textContent = hint;
  }

  btn(label, key, fn, cls) {
    return h("button", { class: "btn" + (cls ? " " + cls : ""), type: "button", onclick: fn }, label, key ? " " : null, key ? h("kbd", null, key) : null);
  }

  setControls(...items) {
    clear(this.controls);
    this.controls.append(...items.filter(Boolean));
  }

  third(label, value) {
    this.thirdLabel.textContent = label;
    this.thirdEl.textContent = value;
  }

  startClock(from) {
    this.t0 = from;
    cancelAnimationFrame(this.raf);
    const tick = () => {
      this.clockEl.textContent = (Math.max(0, performance.now() - this.t0) / 1000).toFixed(2);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopClock() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    return this.t0 ? Math.round(performance.now() - this.t0) : 0;
  }

  /** Numbers shown, numbers hidden or the whole board covered. */
  look(mode) {
    const hide = mode !== "open";
    this.view.setMods({ "mod-blind": hide });
    this.view.setRunning(hide);
    this.view.setHidden(mode === "dark");
    this.view.setColoring(hide ? "plain" : "correct");
  }

  dim(fn) {
    for (const [t, el] of this.view.tiles) el.style.opacity = fn && fn(t) ? "0.3" : "";
  }

  /** The moves, part by part. `at` is the move you are on (-1: none marked). */
  drawMoves(parts, at = -1) {
    clear(this.lineEl);
    this.lineEl.append(...this.moveEls(parts, at));
  }

  moveEls(parts, at = -1) {
    const out = [];
    let k = 0;
    for (const p of parts) {
      const arrows = h("div", { style: { font: "600 22px/1.3 var(--ui)", letterSpacing: "4px", display: "flex", flexWrap: "wrap" } });
      for (const m of p.moves) {
        const on = k === at;
        arrows.append(h("span", { style: { color: k < at ? "var(--faint)" : on ? "var(--spot)" : "var(--ink)", borderBottom: on ? "2px solid var(--spot)" : "2px solid transparent" } }, this.arrow(m)));
        k++;
      }
      out.push(h("div", { style: { display: "grid", gap: "6px" } }, cap(p.name), arrows));
    }
    return out;
  }

  /** The chain as numbers. `at`: the link you are on. `upTo`: only this many are shown. */
  drawChain(chain, { at = -1, upTo = chain.length, label = "Chain" } = {}) {
    const row = h("div", { style: { font: "600 20px/1.2 var(--ui)", display: "flex", flexWrap: "wrap", gap: "4px 12px" } });
    chain.slice(0, upTo).forEach((t, i) => {
      const special = t === 11 || t === 12;
      const spot = special ? (i % 2 === 1 ? t : t === 11 ? 12 : 11) : 0;
      row.append(
        h(
          "span",
          {
            class: "tnum",
            style: { color: i < at ? "var(--faint)" : i === at ? "var(--spot)" : "var(--ink)" },
            title: special ? `${t} is link ${i + 1}, so it goes into spot ${spot}` : null,
          },
          String(t),
          special ? h("span", { style: { fontSize: "11px", fontWeight: "400", color: "var(--ink-3)", marginLeft: "4px" } }, "into " + spot) : null,
        ),
      );
    });
    if (!row.childNodes.length) row.append(h("span", { style: { color: "var(--faint)" } }, "..."));
    return h("div", { style: { display: "grid", gap: "6px", flexBasis: "100%" } }, cap(label), row);
  }

  /** Outlines and arrows drawn over the board. Cells are [cell, label], arrows are [from, to]. */
  marks({ cells = [], arrows = [] } = {}) {
    if (this.ov) this.ov.remove();
    this.ov = null;
    if (!cells.length && !arrows.length) return;
    const bed = this.view.bed;
    const W = bed.clientWidth || 480;
    const gap = 0.012 * W + 2;
    const u = (W - 3 * gap) / 4;
    const at = (cell) => [(cell % N) * (u + gap), Math.floor(cell / N) * (u + gap)];
    const ov = svg("svg", {
      viewBox: `0 0 ${W} ${W}`,
      "aria-hidden": "true",
      style: "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible",
    });
    for (const [cell, label] of cells) {
      const [x, y] = at(cell);
      const box = { x: x + 2, y: y + 2, width: u - 4, height: u - 4, fill: "none" };
      ov.append(svg("rect", { ...box, style: "stroke:var(--paper);stroke-width:7" }), svg("rect", { ...box, style: "stroke:var(--ink-c);stroke-width:3" }));
      if (label) {
        const tag = svg("text", { x: x + 10, y: y + 18, style: "font:600 12px var(--ui);fill:var(--ink-c)" });
        tag.textContent = label;
        ov.append(svg("rect", { x: x + 4, y: y + 4, width: label.length * 7.4 + 12, height: 19, style: "fill:var(--paper)" }), tag);
      }
    }
    for (const [a, b] of arrows) {
      const [ax, ay] = at(a).map((v) => v + u / 2);
      const [bx, by] = at(b).map((v) => v + u / 2);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len,
        uy = (by - ay) / len;
      const x1 = ax + ux * u * 0.3,
        y1 = ay + uy * u * 0.3,
        x2 = bx - ux * u * 0.36,
        y2 = by - uy * u * 0.36;
      const head = 11;
      const tip = `${x2 + ux * head},${y2 + uy * head} ${x2 - uy * head * 0.6},${y2 + ux * head * 0.6} ${x2 + uy * head * 0.6},${y2 - ux * head * 0.6}`;
      ov.append(
        svg("line", { x1, y1, x2, y2, style: "stroke:var(--paper);stroke-width:8;stroke-linecap:round" }),
        svg("polygon", { points: tip, style: "fill:var(--ink-c);stroke:var(--paper);stroke-width:3;paint-order:stroke" }),
        svg("line", { x1, y1, x2, y2, style: "stroke:var(--ink-c);stroke-width:3;stroke-linecap:round" }),
      );
    }
    bed.append(ov);
    this.ov = ov;
  }

  /** One leg of a path as a small map: the line the empty spot walks, with your key on each step. */
  legMap(leg, at) {
    const S = 17,
      P = 19,
      W = 4 * S + 3 * (P - S);
    const mid = (cell) => [(cell % N) * P + S / 2, Math.floor(cell / N) * P + S / 2];
    const el = svg("svg", { viewBox: `0 0 ${W} ${W}`, width: W, height: W, "aria-hidden": "true", style: "display:block;flex:none" });
    const k0 = at - leg.first;
    const hot = k0 >= 0 && k0 < leg.dirs.length ? leg.cells[k0 + 1] : -1;
    for (let c = 0; c < N * N; c++)
      el.append(svg("rect", { x: (c % N) * P, y: Math.floor(c / N) * P, width: S, height: S, style: `fill:${c === hot ? "var(--spot)" : "var(--paper-2)"};stroke:var(--rule)` }));
    el.append(svg("polyline", { points: leg.cells.map((c) => mid(c).join(",")).join(" "), style: "fill:none;stroke:var(--ink-3);stroke-width:1.5;stroke-linejoin:round" }));
    const [sx, sy] = mid(leg.cells[0]);
    const closed = leg.cells[leg.cells.length - 1] === leg.cells[0];
    el.append(svg("circle", { cx: sx - (closed ? 5 : 0), cy: sy - (closed ? 5 : 0), r: closed ? 2 : 3, style: "fill:var(--ink-c)" }));
    leg.dirs.forEach((m, k) => {
      const cell = leg.cells[k + 1];
      const [x, y] = mid(cell);
      const on = cell === hot;
      const g = svg("text", {
        x,
        y: y + 0.5,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        style: `font:600 11px var(--ui);fill:${on ? "var(--spot-ink)" : k < k0 ? "var(--faint)" : "var(--ink)"};paint-order:stroke;stroke:${on ? "var(--spot)" : "var(--paper-2)"};stroke-width:3px`,
      });
      g.textContent = this.arrow(m);
      el.append(g);
    });
    return el;
  }

  /** A run of moves as a row of maps. `at`: the move you are on, counted inside this run. */
  maps(moves, at = -1) {
    const legs = legsOf(moves);
    return h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "8px" } },
      ...legs.map((leg, i) => h("div", { style: { display: "grid", gap: "4px" } }, legs.length > 1 ? cap(String(i + 1)) : null, this.legMap(leg, at))),
    );
  }

  /* ---------- the lesson ---------- */

  startLesson() {
    this.steps = this.steps || lessonSteps();
    this.hintEl.style.cssText = "font-size:14px;line-height:1.6;color:var(--ink-2);max-width:60ch;margin-top:6px";
    this.lookNow = "open";
    this.lessonGo(this.li || 0);
  }

  lessonGo(i) {
    this.stop();
    const n = this.steps.length;
    this.li = Math.min(n - 1, Math.max(0, i));
    const st = this.steps[this.li];
    this.board = st.board.slice();
    this.view.clearProofed();
    this.view.set(this.board, N, { instant: true });
    this.look("open");
    this.dim(null);
    this.view.markHint(null);
    this.playing = !!st.play;
    this.pi = 0;
    this.phase = "lesson";
    this.paintLesson();
    if (!st.play) return;
    const beat = st.fast ? 150 : 330;
    const step = () => {
      if (this.pi >= st.play.length) {
        this.playing = false;
        return this.paintLesson();
      }
      const m = st.play[this.pi];
      const from = this.board.indexOf(0);
      const to = E.neighbor(from, m, N);
      const tile = this.board[to];
      E.applyMove(this.board, N, m);
      this.view.set(this.board, N);
      audio.tock({ tile, col: from % N, N, home: from === tile - 1 });
      this.pi++;
      this.paintLesson();
      this.timer = setTimeout(step, beat);
    };
    this.timer = setTimeout(step, 800);
  }

  lessonNext() {
    const st = this.steps[this.li];
    if (this.playing) {
      // skip to the end of what is playing
      this.stop();
      this.playing = false;
      this.board = run(st.board, st.play);
      this.view.set(this.board, N, { instant: true });
      return this.paintLesson();
    }
    if (st.last) {
      this.li = 0;
      this.store.set("blind", { ...this.host.o, chain: { ...this.c, stage: "moves", num: ORDER[0], how: "follow" } });
      return this.host.render();
    }
    this.lessonGo(this.li + 1);
  }

  paintLesson() {
    const st = this.steps[this.li];
    const n = this.steps.length;
    const done = !!st.play && !this.playing;
    this.head(`${this.li + 1}. ${st.title}`, st.text);
    clear(this.lineEl);
    if (st.list) this.lineEl.append(this.drawChain(st.list, { at: done && st.listAfter != null ? st.listAfter : st.listAt != null ? st.listAt : -1, label: "Your list" }));
    if (st.parts)
      this.lineEl.append(
        h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "end", gap: "8px 20px", flexBasis: "100%" } }, ...this.moveEls(st.parts, this.playing ? this.pi : done ? 999 : -1)),
      );
    this.marks({ cells: done && st.cellsAfter ? st.cellsAfter : st.cells || [], arrows: st.arrows || [] });
    this.setControls(
      this.btn(st.last ? `Start with number ${ORDER[0]}` : this.playing ? "Skip" : "Next", "Space", () => this.lessonNext(), "btn--primary"),
      this.li > 0 ? this.btn("Back", "B", () => this.lessonGo(this.li - 1)) : null,
      st.play ? this.btn("Play it again", "R", () => this.lessonGo(this.li)) : null,
    );
    clear(this.side);
    this.side.append(
      h(
        "section",
        { class: "train-card" },
        h("h2", { class: "sub-title sub-title--small" }, `Lesson: step ${this.li + 1} of ${n}`),
        h(
          "div",
          { style: { display: "grid", gap: "2px" } },
          ...this.steps.map((x, i) =>
            h(
              "button",
              {
                type: "button",
                onclick: () => this.lessonGo(i),
                "aria-current": i === this.li ? "step" : null,
                style: {
                  font: "400 12px/1.5 var(--ui)",
                  textAlign: "left",
                  padding: "2px 0",
                  border: "0",
                  borderRadius: "0",
                  background: "transparent",
                  cursor: "pointer",
                  color: i === this.li ? "var(--spot)" : i < this.li ? "var(--ink-3)" : "var(--ink-2)",
                },
              },
              `${i + 1}. ${x.title}`,
            ),
          ),
        ),
      ),
    );
  }

  moving() {
    return (this.stage === "moves" && this.phase === "go") || (this.stage === "solve" && (this.phase === "memo" || this.phase === "solve"));
  }

  /** One slide of the empty spot. */
  move(dir) {
    if (!this.moving()) return;
    const from = this.board.indexOf(0);
    const to = E.neighbor(from, dir, N);
    if (to < 0) return audio.bump();
    if (this.stage === "moves" && this.shown && dir !== this.seq[this.i]) return audio.bump();
    const tile = this.board[to];
    E.applyMove(this.board, N, dir);
    this.count++;
    this.view.set(this.board, N);
    audio.tock({ tile, col: from % N, N, home: this.lookNow === "open" && from === tile - 1 });
    if (this.stage === "moves") this.afterLearnMove();
    else this.afterSolveMove();
  }

  /** Slide the row or column between the empty spot and this cell. */
  slideTo(cell) {
    const b = this.board.indexOf(0);
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
    for (let i = 0; i < count; i++) this.move(dir);
  }

  onCell(cell) {
    if (this.stage === "lesson") return;
    if (this.stage === "memo") this.tap(cell);
    else if (this.phase === "ready") this.space();
    else if (this.s.mouseMode !== "hover") this.slideTo(cell);
  }

  onKey(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map =
      this.s.arrowMode === "blank"
        ? { ArrowLeft: 2, ArrowRight: 3, ArrowUp: 0, ArrowDown: 1, a: 2, d: 3, w: 0, s: 1 }
        : { ArrowLeft: 3, ArrowRight: 2, ArrowUp: 1, ArrowDown: 0, a: 3, d: 2, w: 1, s: 0 };
    if (this.stage === "lesson") {
      const go = { " ": 1, ArrowRight: 1, Enter: 1, ArrowLeft: -1, Backspace: -1, b: -1 }[key];
      if (go || key === "r") e.preventDefault();
      if (go === 1) this.lessonNext();
      else if (go === -1) this.lessonGo(this.li - 1);
      else if (key === "r") this.lessonGo(this.li);
      return;
    }
    if (key in map && (key.startsWith("Arrow") || this.s.wasd)) {
      e.preventDefault();
      this.move(map[key]);
    } else if (key === " ") {
      e.preventDefault();
      this.space();
    } else if (key === "r") {
      e.preventDefault();
      this.again();
    } else if (key === "n") {
      e.preventDefault();
      this.fresh();
    } else if (key === "c" || key === "p") {
      e.preventDefault();
      this.peek();
    } else if (key === "z" || key === "Backspace") {
      e.preventDefault();
      this.solveUndo();
    } else if (key === "g") {
      e.preventDefault();
      if (this.stage === "moves" && !this.testing) this.toggleGot(this.num);
    } else if (key === "Escape") {
      e.preventDefault();
      this.giveUp();
    }
  }

  space() {
    if (this.stage === "lesson") return this.lessonNext();
    if (this.stage === "moves") {
      if (this.testing) this.testNext();
      else if (this.phase === "done") this.startMoves({ keep: true });
    } else if (this.stage === "memo") {
      if (this.phase === "ready") this.memoShow();
      else if (this.phase === "traced") this.memoRecall();
      else if (this.phase === "done") this.startMemo({ show: true });
    } else if (this.phase === "ready") this.solveShow();
    else if (this.phase === "memo") this.solveGo();
    else if (this.phase === "done") this.startSolve({ show: true });
  }

  again() {
    if (this.stage === "moves") {
      if (this.testing && this.phase !== "go") this.testNext();
      else this.startMoves();
    } else if (this.phase === "done") this.stage === "memo" ? this.startMemo({ same: true, show: true }) : this.startSolve({ same: true, show: true });
  }

  /** A different scramble before the attempt really starts. Nothing is logged. */
  fresh() {
    if (this.stage === "memo" && (this.phase === "trace" || this.phase === "traced")) this.startMemo({ show: true });
    else if (this.stage === "solve" && this.phase === "memo") this.startSolve({ show: true });
  }

  peek() {
    if (this.stage === "moves") this.showMoves();
    else if (this.stage === "memo") this.memoPeek();
    else this.solvePeek();
  }

  giveUp() {
    if (this.stage === "moves") {
      if (this.phase === "go" && (this.count || this.testing)) this.endLearn(false);
    } else if (this.stage === "memo") {
      if (this.phase === "recall") this.memoEnd(false);
    } else if (this.phase === "solve") this.solveEnd(false);
  }

  /* ---------- stage 1: the moves for one number ---------- */

  numKey(t) {
    return "blindch:n" + t;
  }

  learned(t) {
    const reps = this.store.reps(this.numKey(t));
    return reps.length >= LEARNED && reps.slice(-LEARNED).every((r) => r.ok);
  }

  startMoves({ keep = false } = {}) {
    this.stop();
    const c = this.c;
    this.testing = c.how === "test";
    let ask = null;
    if (this.testing) {
      const pool = this.got();
      if (!this.quiz || this.quiz.pool !== pool.join()) this.quiz = pool.length ? this.newQuiz(pool) : null;
      const q = this.quiz;
      if (q) ask = q.queue[Math.min(q.i, q.queue.length - 1)];
      keep = false;
    } else this.quiz = null;
    const t = (this.num = ask ? ask.n : c.num);
    if (!keep || !this.board) this.board = E.solvedBoard(N);
    this.base = this.board.slice();
    const special = t === 11 || t === 12;
    this.linkDone = ask ? ask.done : special && c.link === "even" ? 1 : 0;
    this.seq = flat(linkMoves(t, this.linkDone));
    this.parts = this.shownParts(t, this.linkDone);
    this.target = run(this.base, this.seq);
    this.i = 0;
    this.count = 0;
    this.t0 = 0;
    this.shown = c.how === "follow";
    if (ask) this.lastAsked = t;
    this.helped = false;
    this.result = null;
    // a test with nothing ticked has nothing to ask, and a finished round shows its result
    this.phase = this.testing ? (!this.quiz ? "empty" : this.quiz.over ? "over" : "go") : "go";
    this.lookNow = "open";
    this.view.clearProofed();
    this.view.set(this.board, N, { instant: true });
    this.look("open");
    this.dim(null);
    this.clockEl.textContent = "0.00";
    this.movesEl.textContent = "0";
    this.paintLearn();
  }

  paintLearn() {
    const t = this.num;
    const special = t === 11 || t === 12;
    const total = this.seq.length;
    this.third("Of", String(total));
    this.marks();
    if (this.testing) return this.paintTest();
    if (this.phase === "go") {
      this.head(
        `Number ${t}`,
        this.shown
          ? special
            ? "Four moves. Follow the arrows."
            : LONGER[t]
            ? `Follow the arrows. ${total} moves.`
            : `Follow the arrows. ${total} moves, the shortest way there is.`
          : `Do the moves for ${t} from memory. It stops by itself when you get it right.`,
      );
      if (this.shown) {
        this.drawMoves(this.parts, this.i);
        const b = this.board.indexOf(0);
        this.view.markHint(this.board[E.neighbor(b, this.seq[this.i], N)]);
      } else {
        clear(this.lineEl);
        this.lineEl.append(cap(`The moves are hidden. ${total} moves.`));
        this.view.markHint(null);
      }
      this.setControls(
        !this.shown ? this.btn("Show the moves", "C", () => this.showMoves()) : null,
        this.count ? this.btn("Start over", "R", () => this.again()) : null,
        h("span", { class: "spacer" }),
        !this.shown && this.count ? this.btn("Give up", "Esc", () => this.giveUp()) : null,
      );
    } else {
      const r = this.result;
      this.view.markHint(null);
      this.drawMoves(this.parts, -1);
      this.head(
        r.ok ? "That is it" : "Not yet",
        r.ok
          ? special
            ? `${t} moved round spots 11, 12 and the start spot.`
            : `${t} and 15 traded places. So did 11 and 12, and that is normal: the next number trades them back. Do it again and everything is home.`
          : "The board is back where it started. The moves are above.",
      );
      if (r.ok && this.c.how === "follow") this.hintEl.textContent += " When it feels easy, switch to From memory.";
      this.setControls(this.btn("Again", "Space", () => this.space(), "btn--primary"), this.btn("Start from solved", "R", () => this.again()));
    }
    this.sideLearn();
  }

  /** The test: one ticked number at a time, in random order, nothing on screen but its name. */
  paintTest() {
    const q = this.quiz;
    const t = this.num;
    const special = t === 11 || t === 12;
    this.view.markHint(null);
    clear(this.lineEl);
    if (this.phase === "empty") {
      this.head("Test", "Nothing is ticked yet. Click the numbers you think you have in the grid on the right, then the test asks every one of them in random order.");
      this.setControls();
    } else if (this.phase === "over") {
      const n = q.queue.length;
      this.head(
        `Test done: ${q.right} of ${n} right`,
        q.missed.length
          ? `Missed: ${q.missed.join(", ")}. Run ${q.missed.length > 1 ? "those" : "that one"} in Follow a few times, then test again.`
          : n < 14
          ? "All of them. Tick the next numbers when you think you have them."
          : "All 14. You know every move: go to 2 Chain.",
      );
      this.setControls(
        this.btn("New round", "Space", () => this.testNext(), "btn--primary"),
        q.missed.length ? this.btn(`Practise ${q.missed[0]}`, null, () => this.setMany({ num: q.missed[0], how: "follow" })) : null,
        q.missed.length ? this.btn(q.missed.length > 1 ? "Untick the missed ones" : "Untick it", null, () => this.untick(q.missed)) : null,
      );
    } else if (this.phase === "go") {
      this.head(
        `Test: number ${t}` + (special ? `, as an ${this.linkDone ? "even" : "odd"} link` : ""),
        `Question ${q.i + 1} of ${q.queue.length}. Do the moves for ${t} from memory. It stops by itself when you get it right.`,
      );
      this.lineEl.append(cap(`Nothing is shown. ${this.seq.length} moves.`));
      this.setControls(this.count ? this.btn("Start over", "R", () => this.again()) : null, h("span", { class: "spacer" }), this.btn("I don't know", "Esc", () => this.giveUp()));
    } else {
      const r = this.result;
      const last = q.i + 1 >= q.queue.length;
      this.drawMoves(this.parts, -1);
      this.head(
        r.ok ? "Right" : `Missed ${t}`,
        r.ok ? `Number ${t} in ${fmtTime(r.ms)}. ${q.right} right so far.` : `These are the moves for ${t}, and the maps are on the right. It stays ticked unless you untick it.`,
      );
      this.setControls(this.btn(last ? "See the result" : "Next number", "Space", () => this.testNext(), "btn--primary"));
    }
    this.sideLearn();
  }

  testNext() {
    const q = this.quiz;
    if (!this.testing || !q) return;
    if (this.phase === "over") this.quiz = null;
    else if (this.phase === "done") {
      q.i++;
      if (q.i >= q.queue.length) q.over = true;
    } else return;
    this.startMoves();
  }

  untick(list) {
    const drop = new Set(list);
    this.quiz = null;
    this.set(
      "got",
      this.got().filter((n) => !drop.has(n)),
    );
  }

  afterLearnMove() {
    if (!this.t0) this.startClock(performance.now());
    this.i++;
    this.movesEl.textContent = String(this.count);
    if (same(this.board, this.target)) return this.endLearn(true);
    this.paintLearn();
  }

  showMoves() {
    if (this.stage !== "moves" || this.phase !== "go" || this.shown || this.testing) return;
    this.stopClock();
    this.board = this.base.slice();
    this.view.set(this.board, N, { instant: true });
    this.i = this.count = this.t0 = 0;
    this.clockEl.textContent = "0.00";
    this.movesEl.textContent = "0";
    this.shown = this.helped = true;
    this.paintLearn();
  }

  endLearn(ok) {
    const ms = this.stopClock();
    this.phase = "done";
    this.result = { ok, ms };
    if (!ok) {
      this.board = this.base.slice();
      this.view.set(this.board, N, { instant: true });
    }
    // only tries from memory count towards "learned", and a test answer is one of those
    if (this.testing && this.quiz) {
      if (ok) this.quiz.right++;
      else this.quiz.missed.push(this.num);
      this.store.addRep(this.numKey(this.num), { d: Date.now(), ok: ok ? 1 : 0, ms, m: this.count, test: 1 });
    } else if (this.c.how === "memory") this.store.addRep(this.numKey(this.num), { d: Date.now(), ok: ok && !this.helped ? 1 : 0, ms, m: this.count });
    this.clockEl.textContent = (ms / 1000).toFixed(2);
    this.paintLearn();
    if (ok) audio.thunk();
    else audio.fail();
  }

  sideLearn() {
    const c = this.c;
    const t = this.num;
    const special = t === 11 || t === 12;
    const testing = this.testing;
    const ticked = this.got();
    clear(this.side);
    const cell = (i) => {
      const n = i + 1;
      const base = {
        height: "40px",
        font: "600 15px/1 var(--ui)",
        border: "1px solid var(--rule)",
        borderRadius: "0",
        background: "transparent",
        color: "var(--ink-2)",
        cursor: "pointer",
        position: "relative",
      };
      if (n === 16) return h("div", { style: { ...base, cursor: "default", borderStyle: "dashed" } });
      if (n === 15)
        return h("div", { style: { ...base, cursor: "default", display: "grid", placeItems: "center", fontSize: "11px", color: "var(--ink-3)" }, title: "Spot 15 is the start spot" }, "start");
      const got = this.learned(n);
      const tick = ticked.includes(n);
      const on = testing ? this.phase !== "empty" && this.phase !== "over" && n === t : n === t;
      if (got) Object.assign(base, { color: "var(--spot)", borderColor: "var(--spot)" });
      if (on) Object.assign(base, { background: "var(--spot)", color: "var(--spot-ink)", borderColor: "var(--spot)" });
      return h(
        "button",
        {
          type: "button",
          style: base,
          "aria-pressed": String(testing ? tick : n === t),
          title: `Number ${n}` + (tick ? ", ticked" : "") + (got ? ", learned" : "") + (testing ? (tick ? ". Click to take it out of the test" : ". Click to put it in the test") : ""),
          onclick: () => (testing ? this.toggleGot(n) : this.set("num", n)),
        },
        String(n),
        tick
          ? svg(
              "svg",
              { viewBox: "0 0 10 10", "aria-hidden": "true", style: "position:absolute;top:3px;right:3px;width:10px;height:10px;pointer-events:none" },
              svg("polyline", { points: "1,5.5 4,8.5 9,1.5", style: "fill:none;stroke:currentColor;stroke-width:1.8" }),
            )
          : null,
      );
    };
    const got = ORDER.filter((n) => this.learned(n)).length;
    const next = ORDER.find((n) => !this.learned(n) && !ticked.includes(n));
    this.side.append(
      h(
        "section",
        { class: "train-card" },
        h("h2", { class: "sub-title sub-title--small" }, `Numbers: ${ticked.length} ticked, ${got} of 14 learned`),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "4px", maxWidth: "260px" } }, ...Array.from({ length: 16 }, (_, i) => cell(i))),
        h(
          "p",
          { class: "hint-text" },
          testing
            ? "Click a number to put it in the test or take it out. The test asks every ticked number once, in random order."
            : `Pick a number. Tick it (G) when you think you have it, then Test asks every ticked one at random. It counts as learned after ${LEARNED} in a row from memory. Shortest first: 8, 7, 14, 10, then 6, 4, 3, 13, then 9, 2, 5, 1, and 11 and 12 last.` +
                (next ? ` Next up: ${next}.` : " All done: go to stage 2."),
        ),
      ),
    );
    if (testing) return this.sideTest();
    const reps = this.store.reps(this.numKey(t));
    const tl = tally(reps);
    const mine = ticked.includes(t);
    const card = h(
      "section",
      { class: "train-card" },
      h("h2", { class: "sub-title sub-title--small" }, `Number ${t}` + (this.learned(t) ? ": learned" : mine ? ": ticked" : "")),
      h("div", { style: { margin: "8px 0 4px" } }, this.btn(mine ? "Untick it" : "I've got it", "G", () => this.toggleGot(t), mine ? "" : "btn--primary")),
    );
    if (special)
      card.append(
        seg(
          [
            { value: "odd", label: "Odd link", title: "1st, 3rd, 5th... link of the chain" },
            { value: "even", label: "Even link", title: "2nd, 4th, 6th... link of the chain" },
          ],
          c.link,
          (v) => this.set("link", v),
          "Odd or even link",
        ),
        h(
          "p",
          { class: "hint-text" },
          `11 and 12 are four moves each. Which way round depends on where ${t} sits in your chain: as an odd link it goes into spot ${t === 11 ? 12 : 11}, as an even link into spot ${t}.`,
        ),
      );
    else
      card.append(
        h(
          "p",
          { class: "hint-text" },
          `What this run does: the tile in the start spot and the tile in spot ${t} trade places, and 11 and 12 trade too. ${this.seq.length} moves` +
            (LONGER[t] ? `. A ${LONGER[t]} move way exists, but this one is easier to remember.` : ", and no shorter way exists."),
        ),
      );
    // the path as maps. From memory they stay hidden until the try is over
    const open = this.shown || this.phase === "done";
    const at = this.shown && this.phase === "go" ? this.i : -1;
    if (!open) card.append(h("p", { class: "muted" }, "The path maps are hidden while you try from memory. Press C to see them."));
    else
      card.append(
        h("p", { class: "hint-text" }, "The path: the empty spot walks each map in turn, starting at the dot. The arrow in a square is the key you press there. The numbers match the pieces above the board."),
        this.maps(this.seq, at),
      );
    card.append(
      h(
        "div",
        { class: "train-figs" },
        fig("Best", fmtTime(tl.best), "from memory", tl.best != null ? "is-key" : null),
        fig("In a row", String(tl.streak), `need ${LEARNED}`),
        fig("Tries", String(tl.n), `${tl.ok} right`),
      ),
    );
    this.side.append(card);
  }

  /** The side of a test: where the round stands, and the answer once a number is over. */
  sideTest() {
    const q = this.quiz;
    if (!q) return;
    const n = q.queue.length;
    const asked = q.over ? n : q.i + (this.phase === "done" ? 1 : 0);
    const card = h("section", { class: "train-card" }, h("h2", { class: "sub-title sub-title--small" }, q.over ? "This round" : `This round: ${n} number${n === 1 ? "" : "s"}`));
    card.append(
      h(
        "div",
        { class: "train-figs" },
        fig("Asked", `${asked} of ${n}`, q.over ? "done" : "random order"),
        fig("Right", String(q.right), null, q.right ? "is-key" : null),
        fig("Missed", String(q.missed.length), q.missed.length ? q.missed.join(", ") : "none"),
      ),
    );
    if (this.phase === "done") card.append(h("p", { class: "hint-text" }, `The path for ${this.num}: the empty spot walks each map in turn, starting at the dot.`), this.maps(this.seq, -1));
    this.side.append(card);
  }

  /* ---------- stage 2: read the chain and remember it ---------- */

  startMemo({ same: keep = false, show = false } = {}) {
    this.stop();
    const c = this.c;
    this.board = keep && this.startBoard ? this.startBoard.slice() : chainScramble(c.len);
    this.startBoard = this.board.slice();
    this.L = this.board.slice(0, 15);
    this.chain = [];
    this.at = 0;
    this.slips = 0; // wrong clicks while reading the chain
    this.misses = 0; // wrong taps while giving it back
    this.peeks = 0;
    this.memoMs = 0;
    this.count = 0;
    this.result = null;
    this.phase = "ready";
    this.lookNow = "hidden";
    this.view.clearProofed();
    this.view.set(this.board, N, { instant: true });
    this.view.markHint(null);
    this.clockEl.textContent = "0.00";
    this.paintMemo();
    if (show) this.memoShow();
  }

  memoShow() {
    if (this.phase !== "ready") return;
    this.phase = "trace";
    this.view.enter();
    this.startClock(performance.now());
    this.paintMemo();
  }

  paintMemo() {
    const p = this.phase;
    const want = this.L[BUF];
    this.third("Links", p === "recall" || p === "done" ? `${this.at}/${this.chain.length}` : String(this.chain.length));
    this.movesEl.textContent = String(this.slips + this.misses);
    clear(this.lineEl);
    if (p === "ready") {
      this.look("hidden");
      this.dim(null);
      this.head("Read the chain", "Press Space to see the scramble. You click the spots, nothing slides here.");
      this.setControls(this.btn("Show the scramble", "Space", () => this.space(), "btn--primary"));
    } else if (p === "trace") {
      this.look("open");
      this.view.setColoring("plain");
      // a tile fades once the chain has placed it (or it was home from the start)
      this.dim((t) => this.L[t - 1] === t);
      const first = !this.chain.length;
      let hint;
      if (want !== 15) {
        const from = first ? "The start spot" : `Spot ${this.chain[this.chain.length - 1]}`;
        hint = `${from} holds ${want}. Click the spot where ${want} lives.`;
        this.view.markHint(want);
      } else {
        hint = first
          ? "15 is already in the start spot. Start a new chain: click any bright tile."
          : "That chain is closed. Start a new one: click any bright tile. You will come back to that spot to close it.";
        this.view.markHint(null);
      }
      this.head("Read the chain", hint);
      this.lineEl.append(this.drawChain(this.chain, { at: -1 }));
      this.setControls(this.btn("New scramble", "N", () => this.fresh()));
    } else if (p === "traced") {
      this.dim(null);
      this.view.markHint(null);
      this.head(`${this.chain.length} links`, "Say it to yourself in a rhythm, a few numbers at a time. Then press Space and tap the spots back in order.");
      this.lineEl.append(this.drawChain(this.chain, { at: -1 }));
      this.setControls(this.btn("Hide it and tap it back", "Space", () => this.space(), "btn--primary"), this.btn("New scramble", "N", () => this.fresh()));
    } else if (p === "recall") {
      this.look("hidden");
      this.dim(null);
      this.head("Tap it back", `Click the spots in the order of your chain. Memo ${fmtTime(this.memoMs)}.`);
      this.lineEl.append(this.drawChain(this.chain, { at: -1, upTo: this.peeking ? this.chain.length : this.at, label: this.peeking ? "Chain" : "So far" }));
      this.setControls(this.btn("Peek", "C", () => this.peek()), h("span", { class: "spacer" }), this.btn("Give up", "Esc", () => this.giveUp()));
    } else {
      const r = this.result;
      this.look("open");
      this.view.setColoring("plain");
      this.dim(null);
      this.head(
        r.ok ? (r.clean ? "Clean" : "Got there") : "Not this time",
        r.ok
          ? `${this.chain.length} links: ${fmtTime(r.ms)} to memorise, ${fmtTime(r.rc)} to tap back` + (r.clean ? "." : `, with ${this.misses} wrong tap${this.misses === 1 ? "" : "s"} and ${this.peeks} peek${this.peeks === 1 ? "" : "s"}.`)
          : `You had ${this.at} of ${this.chain.length}. The chain is above.`,
      );
      this.lineEl.append(this.drawChain(this.chain, { at: r.ok ? -1 : this.at }));
      this.setControls(this.btn("Next scramble", "Space", () => this.space(), "btn--primary"), this.btn("Same again", "R", () => this.again()));
    }
    this.sideMemo();
  }

  tap(cell) {
    const p = this.phase;
    if (p === "ready") return this.space();
    const t = cell + 1;
    if (p === "trace") {
      const want = this.L[BUF];
      const ok = cell !== BUF && (want !== 15 ? t === want : this.L[cell] !== t);
      if (!ok) {
        this.slips++;
        audio.bump();
        toast(cell === BUF ? "That is the start spot itself. Click where its tile lives." : want !== 15 ? `The tile to place is ${want}. Click spot ${want}, where ${want} lives when solved.` : "That spot is already right. Click a bright tile.");
        this.movesEl.textContent = String(this.slips);
        return;
      }
      this.chain.push(t);
      [this.L[cell], this.L[BUF]] = [this.L[BUF], this.L[cell]];
      audio.tock({ tile: t, col: cell % N, N });
      if (this.L.every((v, i) => v === i + 1)) this.phase = "traced";
      this.paintMemo();
    } else if (p === "recall") {
      if (t !== this.chain[this.at]) {
        this.misses++;
        audio.bump();
        this.movesEl.textContent = String(this.slips + this.misses);
        return;
      }
      this.at++;
      audio.tock({ tile: t, col: cell % N, N });
      if (this.at === this.chain.length) this.memoEnd(true);
      else this.paintMemo();
    }
  }

  memoRecall() {
    if (this.phase !== "traced") return;
    this.memoMs = this.stopClock();
    this.phase = "recall";
    this.startClock(performance.now());
    this.paintMemo();
  }

  memoPeek() {
    if (this.phase !== "recall" || this.peeking) return;
    this.peeks++;
    this.peeking = true;
    this.paintMemo();
    this.timer = setTimeout(() => {
      this.peeking = false;
      if (this.phase === "recall") this.paintMemo();
    }, 1500);
  }

  memoEnd(ok) {
    const rc = this.stopClock();
    clearTimeout(this.timer);
    this.peeking = false;
    this.phase = "done";
    const clean = ok && !this.misses && !this.peeks;
    this.result = { ok, clean, ms: this.memoMs, rc };
    this.clockEl.textContent = ((this.memoMs + rc) / 1000).toFixed(2);
    this.store.addRep("blindch:memo", {
      d: Date.now(),
      ok: clean ? 1 : 0,
      ms: this.memoMs,
      rc,
      n: this.chain.length,
      mis: this.misses,
      pk: this.peeks,
      len: this.c.len,
    });
    this.paintMemo();
    if (ok) audio.thunk();
    else audio.fail();
  }

  sideMemo() {
    const c = this.c;
    clear(this.side);
    const reps = this.store.reps("blindch:memo").filter((r) => (r.len || 0) === c.len);
    const tl = tally(reps);
    const card = h(
      "section",
      { class: "train-card" },
      h("h2", { class: "sub-title sub-title--small" }, "Chain memory"),
      h("p", { class: "hint-text" }, `${c.len ? c.len + " link scrambles" : "Full scrambles, about 14 links"}. Clean means no wrong taps and no peeks when you tap it back.`),
    );
    if (!tl.n) card.append(h("p", { class: "muted" }, "No tries yet at this length."));
    else
      card.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Best memo", fmtTime(tl.best), "clean ones", tl.best != null ? "is-key" : null),
          fig("Last 5", fmtTime(tl.last5), "clean ones"),
          fig("Clean", Math.round((tl.ok / tl.n) * 100) + "%", `${tl.ok} of ${tl.n}`),
        ),
      );
    this.side.append(
      card,
      h(
        "section",
        { class: "train-card" },
        h("h2", { class: "sub-title sub-title--small" }, "How to hold it"),
        h(
          "p",
          { class: "hint-text" },
          "Do not picture the board. Say the numbers in groups of three or four, like a phone number, or trace the shape your clicks draw. Start at 2 links and move up when it feels easy.",
        ),
      ),
    );
  }

  /* ---------- stage 3: memorise, then solve with the chain ---------- */

  startSolve({ same: keep = false, show = false } = {}) {
    this.stop();
    const c = this.c;
    this.opt = { see: c.see, help: c.help, len: c.len };
    this.board = keep && this.startBoard ? this.startBoard.slice() : chainScramble(c.len);
    this.startBoard = this.board.slice();
    this.chain = chainFor(this.board);
    this.stops = checkpoints(this.board, this.chain);
    this.at = 0;
    this.count = 0;
    this.peeks = 0;
    // undo: the board at the end of every link you finished, the scramble first
    this.done = [this.board.slice()];
    this.loose = 0; // moves made since the last of those
    this.undos = 0;
    this.memoMs = 0;
    this.result = null;
    this.phase = "ready";
    this.lookNow = "hidden";
    this.view.clearProofed();
    this.view.set(this.board, N, { instant: true });
    this.view.markHint(null);
    this.dim(null);
    this.clockEl.textContent = "0.00";
    this.movesEl.textContent = "0";
    this.paintSolve();
    if (show) this.solveShow();
  }

  solveShow() {
    if (this.phase !== "ready") return;
    this.phase = "memo";
    this.view.enter();
    this.startClock(performance.now());
    this.paintSolve();
  }

  solveGo() {
    if (this.phase !== "memo") return;
    this.memoMs = this.stopClock();
    this.phase = "solve";
    this.clockEl.textContent = "0.00";
    this.t0 = 0;
    this.paintSolve();
  }

  paintSolve() {
    const p = this.phase;
    const o = this.opt;
    const n = this.chain.length;
    this.third("Link", p === "ready" ? "-" : o.help || p === "done" ? `${Math.min(this.at + 1, n)}/${n}` : "-");
    clear(this.lineEl);
    const chainLine = () => this.lineEl.append(this.drawChain(this.chain, { at: p === "done" ? -1 : this.at, label: p === "done" ? "A chain that works" : "Chain" }));
    const movesLine = () => {
      if (this.at >= n) return;
      this.lineEl.append(
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", alignItems: "end", gap: "8px 20px", flexBasis: "100%" } },
          ...this.moveEls(this.shownParts(this.chain[this.at], this.at)),
        ),
      );
    };
    if (p === "ready") {
      this.lookNow = "hidden";
      this.look("hidden");
      this.head("Blind solve", "Press Space to see the scramble. The memo clock starts then.");
      this.setControls(this.btn("Show the scramble", "Space", () => this.space(), "btn--primary"));
    } else if (p === "memo") {
      this.lookNow = "open";
      this.look("open");
      this.view.setColoring("plain");
      this.head("Memorise", o.help ? "The chain is given this time. Press Space or make your first move to start." : "Read your chain off the board. Press Space or make your first move when you have it.");
      if (o.help) chainLine();
      this.setControls(this.btn("Start solving", "Space", () => this.space(), "btn--primary"), this.btn("New scramble", "N", () => this.fresh()));
    } else if (p === "solve") {
      this.lookNow = this.peeking ? "open" : o.see;
      this.look(this.lookNow);
      this.head(
        "Solving",
        (o.help ? `Do the moves for ${this.at < n ? this.chain[this.at] : "the last link"}. ` : "One link at a time. ") +
          "It stops by itself when the board is solved. Lost? Z takes you back to the start of the number you are on.",
      );
      if (o.help) chainLine();
      if (o.help) movesLine();
      this.setControls(
        this.btn("Undo", "Z", () => this.solveUndo()),
        o.see !== "open" ? this.btn("Peek", "C", () => this.peek()) : null,
        h("span", { class: "spacer" }),
        this.btn("Give up", "Esc", () => this.giveUp()),
      );
    } else {
      const r = this.result;
      this.lookNow = "open";
      this.look("open");
      this.head(
        r.ok ? (r.real ? "A real blindfold solve" : "Solved") : "Did not finish",
        r.ok
          ? `${fmtTime(r.ms)} in total: ${fmtTime(r.memo)} to memorise, ${fmtTime(r.exec)} and ${r.m} moves to solve` + (r.un ? `, with ${r.un} undo${r.un > 1 ? "s" : ""}.` : ".")
          : `${15 - r.left} of 15 tiles were home.`,
      );
      chainLine();
      this.setControls(this.btn("Next scramble", "Space", () => this.space(), "btn--primary"), this.btn("Same again", "R", () => this.again()));
    }
    this.sideSolve();
  }

  afterSolveMove() {
    if (this.phase === "memo") {
      this.memoMs = this.stopClock();
      this.phase = "solve";
    }
    if (!this.raf) this.startClock(performance.now());
    this.movesEl.textContent = String(this.count);
    if (E.isSolved(this.board)) return this.solveEnd(true);
    // a link is finished when the empty spot is home and the board is one whole link away from the last finished one
    const last = this.done[this.done.length - 1];
    this.loose++;
    if (this.board[N * N - 1] === 0) {
      if (same(this.board, last)) this.loose = 0;
      else if (LINKS.some((m) => same(this.board, run(last, m)))) {
        this.done.push(this.board.slice());
        this.loose = 0;
      }
    }
    if (this.at < this.chain.length && same(this.board, this.stops[this.at + 1])) {
      this.at++;
      this.paintSolve();
    } else if (this.count === 1 || this.loose <= 1) this.paintSolve();
  }

  /**
   * Undo: back to where the number you are on started. Pressed again right away, it takes back
   * the number before that. The clock keeps running and the moves you made stay counted.
   */
  solveUndo() {
    if (this.stage !== "solve" || this.phase !== "solve") return;
    const d = this.done;
    if (!this.loose) {
      if (d.length < 2) {
        audio.bump();
        return toast("Nothing to undo yet");
      }
      d.pop();
    }
    this.board = d[d.length - 1].slice();
    this.loose = 0;
    this.undos++;
    this.view.set(this.board, N, { instant: true });
    const i = this.stops.findIndex((b) => same(b, this.board));
    if (i >= 0) this.at = i;
    audio.thunk();
    toast(d.length > 1 ? `Undone. ${d.length - 1} number${d.length > 2 ? "s" : ""} of your list ${d.length > 2 ? "are" : "is"} done, you are on number ${d.length}.` : "Undone. You are back at the scramble, on the first number of your list.");
    this.paintSolve();
  }

  solvePeek() {
    if (this.phase !== "solve" || this.peeking || this.opt.see === "open") return;
    this.peeks++;
    this.peeking = true;
    this.paintSolve();
    this.timer = setTimeout(() => {
      this.peeking = false;
      if (this.phase === "solve") this.paintSolve();
    }, 1500);
  }

  solveEnd(ok) {
    const exec = this.count ? this.stopClock() : 0;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.raf = 0;
    this.peeking = false;
    const o = this.opt;
    let left = 0;
    for (let i = 0; i < 15; i++) if (this.board[i] !== i + 1) left++;
    const real = ok && o.see === "dark" && !o.help && !this.peeks;
    this.result = { ok, real, ms: this.memoMs + exec, memo: this.memoMs, exec, m: this.count, left, un: this.undos };
    this.phase = "done";
    this.at = ok ? this.chain.length : this.at;
    this.clockEl.textContent = ((this.memoMs + exec) / 1000).toFixed(2);
    this.store.addRep("blindch:solve", {
      d: Date.now(),
      ok: ok ? 1 : 0,
      ms: this.memoMs + exec,
      memo: this.memoMs,
      exec,
      m: this.count,
      pk: this.peeks,
      un: this.undos,
      see: o.see,
      help: o.help ? 1 : 0,
      len: o.len,
      n: this.chain.length,
      left,
    });
    this.paintSolve();
    if (ok) {
      this.view.inkWave();
      audio.thunk();
    } else audio.fail();
  }

  sideSolve() {
    const c = this.c;
    const o = this.opt || c;
    clear(this.side);
    const help = h("input", { type: "checkbox", checked: !!c.help });
    help.addEventListener("change", () => this.set("help", help.checked));
    this.side.append(
      h(
        "section",
        { class: "train-card" },
        h("h2", { class: "sub-title sub-title--small" }, "How blind"),
        seg(SEE, c.see, (v) => this.set("see", v), "What you see while solving"),
        h("label", { class: "switch-row", style: { justifyContent: "start", gap: "10px", cursor: "pointer" } }, help, "Keep the chain and the moves on screen"),
        h(
          "p",
          { class: "hint-text" },
          "Start with the numbers shown and the chain on screen, so you see what each link does. Then hide the numbers, then drop the chain. Board covered with no chain is the real thing.",
        ),
        h(
          "p",
          { class: "hint-text" },
          "Lost in the middle of a number? Undo (Z) puts the board back to where that number started, and tells you which number of your list you are on. Press it again to take back the number before.",
        ),
      ),
    );
    const all = this.store.reps("blindch:solve");
    const reps = all.filter((r) => r.see === o.see && !!r.help === !!o.help && (r.len || 0) === o.len);
    const tl = tally(reps);
    const real = all.filter((r) => r.ok && r.see === "dark" && !r.help && !r.pk && !r.len).length;
    const card = h(
      "section",
      { class: "train-card" },
      h("h2", { class: "sub-title sub-title--small" }, "Records"),
      h(
        "p",
        { class: "hint-text" },
        `${SEE.find((x) => x.value === o.see).label}, chain ${o.help ? "on screen" : "from memory"}, ${o.len ? o.len + " links" : "full scrambles"}. Real blindfold solves of a full scramble so far: ${real}.`,
      ),
    );
    if (!tl.n) card.append(h("p", { class: "muted" }, "No attempts yet with these settings."));
    else {
      const okReps = reps.filter((r) => r.ok).slice(-5);
      card.append(
        h(
          "div",
          { class: "train-figs" },
          fig("Best", fmtTime(tl.best), null, tl.best != null ? "is-key" : null),
          fig("Last 5", fmtTime(tl.last5), "solved ones"),
          fig("Solved", Math.round((tl.ok / tl.n) * 100) + "%", `${tl.ok} of ${tl.n}`),
        ),
        h(
          "div",
          { class: "train-figs" },
          fig("Streak", String(tl.streak), "solved in a row"),
          fig("Memo", fmtTime(okReps.length ? mean(okReps.map((r) => r.memo)) : null), "last 5"),
          fig("Solve", fmtTime(okReps.length ? mean(okReps.map((r) => r.exec)) : null), "last 5"),
        ),
      );
    }
    this.side.append(card);
  }
}
