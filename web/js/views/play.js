import { BoardView } from "../board-view.js";
import { Game } from "../game.js";
import { MOD_KEYS, encodeMoves, encodeTimes } from "../store.js";
import {
  summarize,
  fmtTime,
  fmtNum,
  fmtPct,
  rarity,
  difficultyWord,
  pctFine,
} from "../stats.js";
import * as audio from "../audio.js";
import { MODS, VIEW_MODS, timeLimit, budgetFor } from "../mods.js";
import { setSpeedMode, setPractice, setCoach } from "../speed.js";
import { submit as submitGlobal } from "../global.js";
import { h, clear, seg, toast, copyText, todayKey, relDate } from "../ui.js";
import { gradeOne } from "../grader.js";
import { deepOf, fmtMs } from "../deep.js";
import { pulse } from "../motion.js";
import { syncSoon } from "../sync.js";
import { Coach, COACH_TARGETS, COACH_LEVELS, coachAvailable } from "../coach.js";
import { planFor, stageIndex, splitsOf, averageSplits, METHODS } from "../steps.js";

const LIVE = {
  tps: "Tiles/sec",
  mspm: "ms/move",
  gap: "Last gap",
};

const E = window.FifteenEngine;
const D = window.FifteenData;

// arrow -> blank direction, for each control style
const KEYMAP = {
  tile: {
    ArrowLeft: 3,
    ArrowRight: 2,
    ArrowUp: 1,
    ArrowDown: 0,
    a: 3,
    d: 2,
    w: 1,
    s: 0,
  },
  blank: {
    ArrowLeft: 2,
    ArrowRight: 3,
    ArrowUp: 0,
    ArrowDown: 1,
    a: 2,
    d: 3,
    w: 0,
    s: 1,
  },
};

export class PlayView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.engine = ctx.engine;
    this.game = null;
    this.solution = null; // cached optimal path from the current position
    this.raf = 0;
    this.autoplaying = false;
    this.lastSolve = null;
    this.build();
  }

  get s() {
    return this.store.settings;
  }

  build() {
    clear(this.root);
    this.setupRow = h("div", { class: "setup-row" });
    this.timeEl = h("div", { class: "figure timer is-ready" }, "0.00");
    this.movesEl = h("div", { class: "figure" }, "0");
    this.tpsEl = h("div", { class: "figure" }, "0.0");
    this.seedLine = h("div", { class: "seed-line" });
    this.liveEl = h("div", { class: "live-distance", hidden: true });
    this.ticket = h(
      "div",
      { class: "ticket" },
      h(
        "div",
        { class: "stat" },
        h("div", { class: "label" }, "Time"),
        this.timeEl,
      ),
      h(
        "div",
        { class: "stat" },
        h("div", { class: "label" }, "Moves"),
        this.movesEl,
      ),
      h(
        "div",
        { class: "stat stat-tps" },
        (this.liveLabel = h("div", { class: "label" }, LIVE[this.s.liveStat] || LIVE.tps)),
        this.tpsEl,
      ),
      h("div", { class: "ticket-meta" }, this.seedLine, this.liveEl),
    );
    this.boardWrap = h("div", { class: "board-wrap" });
    this.view = new BoardView(this.boardWrap, {
      interactive: true,
      onCell: (cell, e) => this.onPointerCell(cell, e),
      onHover: (cell) => {
        if (this.s.mouseMode === "hover") this.moveCell(cell);
      },
      label: "Puzzle board. Use the arrow keys to slide tiles.",
    });
    this.cover = h("div", { class: "cover", hidden: true });
    this.setCover("Paused", "Press P or click to resume");
    this.cover.addEventListener("click", () => this.togglePause());
    this.view.root.appendChild(this.cover);
    this.bindSwipe();

    this.controls = h("div", { class: "controls" });
    this.introLine = h(
      "p",
      { class: "hint-text" },
      "Arrow keys slide the tiles. Click or tap a tile to slide a whole row. Press ",
      h("kbd", null, "?"),
      " for every shortcut.",
    );
    this.side = h("aside", { class: "side", "aria-label": "This sitting" });
    this.records = h("aside", { class: "records", "aria-label": "Your records" });
    this.coachCard = h("section", { class: "coach-card", "aria-live": "polite" });
    this.coach = null;

    this.root.append(
      h(
        "div",
        { class: "play" },
        this.records,
        h(
          "div",
          { class: "play-main" },
          this.setupRow,
          this.ticket,
          h(
            "div",
            { class: "play-notes" },
            (this.practiceEl = h(
              "p",
              {
                class: "practice-bar",
                hidden: true,
                title: "This solve is saved but does not count toward your averages, records or stats.",
              },
              h("strong", null, "Practice"),
              " · not counted in your stats",
            )),
            (this.modsEl = h("p", { class: "mods-on", hidden: true })),
          ),
          this.boardWrap,
          (this.speedEl = h("p", { class: "speed-line tnum" })),
          (this.splitEl = h("div", { class: "splits", hidden: true })),
          this.controls,
          this.store.state.seenIntro ? null : this.introLine,
        ),
        this.side,
      ),
    );
    this.renderSetup();
    this.renderControls();
    this.view.setColoring(this.s.coloring);
  }

  renderSetup() {
    const sizes = [3, 4, 5, 6, 7];
    if (this.s.modBigBoards) sizes.push(8, 9, 10);
    const N = this.game ? this.game.N : this.s.size;
    const mode = this.game ? this.game.mode : "random";
    clear(this.setupRow).append(
      seg(
        sizes.map((n) => ({ value: n, label: n + "×" + n })),
        N,
        (n) => {
          this.store.set("size", n);
          this.newGame({ N: n, mode: mode === "daily" ? "daily" : "random" });
        },
        "Board size",
      ),
      seg(
        [
          {
            value: "random",
            label: "Random",
            title: "A fresh random-state scramble",
          },
          {
            value: "daily",
            label: "Daily",
            title: "Same scramble for everyone today",
          },
          { value: "seed", label: "Seed", title: "Type a seed to play" },
        ],
        mode === "custom" ? "seed" : mode,
        (m) => {
          if (m === "seed") this.askSeed();
          else this.newGame({ N: this.game.N, mode: m });
        },
        "Scramble type",
      ),
    );
    const on = MODS.filter((m) => !m.free && this.s[m.key]);
    if (this.modsEl) {
      clear(this.modsEl);
      this.modsEl.hidden = !on.length;
      if (on.length)
        this.modsEl.append(
          "Mods: " + on.map((m) => m.name).join(", ") + " · ",
          h("a", { href: "#lab" }, "change"),
        );
    }
  }

  renderControls() {
    const g = this.game;
    const solved = g && (g.status === "solved" || g.status === "failed");
    clear(this.controls).append(
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onclick: () =>
            this.newGame({
              N: this.game.N,
              mode:
                this.game.mode === "daily"
                  ? "random"
                  : this.game.mode === "seed" || this.game.mode === "custom"
                    ? "random"
                    : this.game.mode,
            }),
        },
        "New scramble",
        h("kbd", null, "Space"),
      ),
      h(
        "button",
        { class: "btn", type: "button", title: "Restart this scramble (R)", onclick: () => this.restart() },
        "Restart",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          title: "Pause (P)",
          disabled: !g || (g.status !== "running" && g.status !== "paused"),
          onclick: () => this.togglePause(),
        },
        g && g.status === "paused" ? "Resume" : "Pause",
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn btn--speed",
          type: "button",
          title: "Speedrun mode (F): bare board, instant slides, live splits, nothing else on screen",
          "aria-pressed": String(!!this.s.speedMode),
          onclick: () => setSpeedMode(this.store, !this.s.speedMode),
        },
        this.s.speedMode ? "Leave speedrun" : "Speedrun",
      ),
      h(
        "button",
        {
          class: "btn btn--coach btn--practice",
          type: "button",
          title: "Practice mode (T): solves here are saved but never count toward your averages, records or stats",
          "aria-pressed": String(!!this.s.practiceOn),
          onclick: () => this.togglePractice(),
        },
        "Practice",
      ),
      h(
        "button",
        {
          class: "btn btn--coach",
          type: "button",
          title: "Coach (C): flags every move that does not help and shows the better one",
          "aria-pressed": String(!!this.s.coachOn),
          onclick: () => this.toggleCoach(),
        },
        "Coach",
      ),
      this.s.modUndo || this.s.coachOn || this.s.practiceOn
        ? h(
            "button",
            {
              class: "btn btn--ghost",
              type: "button",
              title: "Undo (Z)",
              disabled: !g || g.status !== "running",
              onclick: () => this.undo(),
            },
            "Undo",
          )
        : null,
      h(
        "button",
        {
          class: "btn btn--ghost",
          type: "button",
          title: "Show the next optimal move (H)",
          disabled: solved,
          onclick: () => this.hint(),
        },
        "Hint",
      ),
      h(
        "button",
        {
          class: "btn btn--ghost",
          type: "button",
          disabled: solved || this.autoplaying,
          onclick: () => this.autoSolve(),
        },
        "Solve it",
      ),
    );
  }

  /* ---------- game lifecycle ---------- */

  newGame({
    N = this.s.size,
    mode = "random",
    seed = null,
    board = null,
    label = "",
    marathon = false,
  } = {}) {
    if (!marathon) this.marathon = null;
    clearTimeout(this.autoNextTimer);
    this.countAbandoned();
    this.stopLoop();
    this.autoplaying = false;
    if (mode === "daily" && !board) seed = "DAILY-" + todayKey();
    if (!board) {
      if (!seed) seed = E.randomSeed(8);
      board = E.scrambleFromSeed(seed, N);
    }
    if (this.game && this.game.status === "paused") this.view.setHidden(false);
    this.game = new Game({ N, board, seed, mode, label });
    this.game.dealtAt = performance.now();
    this.game.src = { key: 0, pointer: 0, swipe: 0 };
    this.game.practice = !!this.s.practiceOn && !this.s.speedMode;
    this.game.modded = this.game.practice || MOD_KEYS.some((k) => this.s[k]);
    this.game.on((type, data) => this.onGameEvent(type, data));
    this.solution = null;
    this.view.clearProofed();
    this.view.markHint(null);
    this.view.setGuide(null);
    this.view.fast = !!this.s.speedMode;
    this.view.set(this.game.board, N, { instant: true });
    this.setupCoach();
    this.setupSplits();
    this.renderPractice();
    this.view.enter();
    this.view.setHeat(this.s.modHeatmap);
    this.applyViewMods();
    this.view.setRunning(false);
    this.cover.hidden = true;
    this.cover.classList.remove("cover--over");
    this.view.setHidden(false);
    this.updateFigures();
    this.renderSetup();
    this.renderControls();
    this.renderSeedLine();
    this.renderSide();
    this.fetchOptimal();
    if (this.s.modGhostHint) this.hint({ silent: true });
  }

  // a game left behind with moves on it counts as given up
  countAbandoned() {
    const g = this.game;
    if (!g || g.counted || !g.moves.length) return;
    if (g.status === "running" || g.status === "paused" || (g.status === "solved" && g.autoSolved)) {
      g.counted = true;
      this.store.bump(g.N, "abandoned");
    }
  }

  restart() {
    if (!this.game) return;
    const { N, start, seed, mode, label } = this.game;
    this.newGame({ N, board: start, seed, mode, label });
  }

  fetchOptimal() {
    const g = this.game;
    // a finished game still waiting on its optimal keeps its lane; the new game takes the other
    const prev = this.optGame;
    const busy = prev && prev !== g && prev.solveId && prev.optimal == null;
    const prevLane = (prev && prev.optLane) || "opt";
    g.optLane = busy ? (prevLane === "opt" ? "opt-b" : "opt") : prevLane;
    this.optGame = g;
    this.optimalPromise = this.engine
      .run(
        "distance",
        { board: g.start, N: g.N, timeLimit: 20000 },
        { lane: g.optLane, replace: true },
      )
      .then((r) => {
        if (this.game !== g && !g.solveId) return r;
        g.optimal = r.exact ? r.d : null;
        if (r.exact) (g.dists || (g.dists = {}))[0] = r.d;
        g.optimalExact = r.exact;
        g.optimalLowerBound = r.lowerBound ? r.d : null;
        if (r.moves && this.game === g && g.moves.length === 0)
          this.solution = { from: 0, moves: r.moves };
        if (g.solveId && r.exact) {
          this.store.updateSolve(g.solveId, {
            optimal: r.d,
            optimalExact: true,
          });
          if (this.lastSolve && this.lastSolve.id === g.solveId) {
            this.lastSolve.optimal = r.d;
            this.renderSide();
          }
        }
        if (this.game === g) {
          this.renderSeedLine();
          this.updateLive();
        }
        return r;
      })
      .catch((e) => {
        if (!e.cancelled) console.warn(e);
        return null;
      });
  }

  askSeed() {
    const input = h("input", {
      type: "text",
      placeholder: "Any word or code",
      maxlength: 40,
      "aria-label": "Seed",
    });
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      this.newGame({ N: this.game.N, mode: "seed", seed: v });
      wrap.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
      if (e.key === "Escape") wrap.remove();
    });
    const wrap = h(
      "div",
      { class: "row", style: { width: "100%" } },
      input,
      h(
        "button",
        { class: "btn btn--primary btn--small", type: "button", onclick: go },
        "Play seed",
      ),
    );
    this.setupRow.appendChild(wrap);
    input.focus();
  }

  /* ---------- input ---------- */

  onKey(e) {
    const g = this.game;
    if (!g) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = KEYMAP[this.s.arrowMode] || KEYMAP.tile;
    if (key in map && (key.startsWith("Arrow") || this.s.wasd)) {
      e.preventDefault();
      if (this.autoplaying) return;
      if (g.status === "paused") return;
      if (g.status === "solved") return;
      if (!g.move(map[key])) audio.bump();
      return;
    }
    if (key === " ") {
      e.preventDefault();
      this.newGame({ N: g.N, mode: "random" });
      return;
    }
    if (key === "f") {
      e.preventDefault();
      setSpeedMode(this.store, !this.s.speedMode);
      return;
    }
    if (key === "t" && !this.s.speedMode) {
      e.preventDefault();
      this.togglePractice();
      return;
    }
    if (key === "c" && !this.s.speedMode) {
      e.preventDefault();
      this.toggleCoach();
      return;
    }
    if (key === "r") {
      e.preventDefault();
      this.restart();
      return;
    }
    if (key === "p" || key === "Escape") {
      e.preventDefault();
      if (!this.autoplaying) this.togglePause();
      return;
    }
    if (key === "h") {
      e.preventDefault();
      this.hint();
      return;
    }
    const free = this.coach || (this.game && this.game.practice);
    if ((key === "z" && (this.s.modUndo || free)) || (key === "Backspace" && free)) {
      e.preventDefault();
      this.undo();
    }
  }

  onPointerCell(cell, e) {
    if (e.pointerType === "touch" || e.pointerType === "pen") return; // handled as tap or swipe
    if (this.s.mouseMode === "hover") return;
    this.moveCell(cell);
  }

  moveCell(cell) {
    const g = this.game;
    if (
      !g ||
      this.autoplaying ||
      g.status === "solved" ||
      g.status === "paused"
    )
      return;
    if (!g.moveCell(cell)) audio.bump();
  }

  bindSwipe() {
    let start = null;
    const bed = this.view.bed;
    bed.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      start = { x: e.clientX, y: e.clientY, cell: this.view.cellFromEvent(e) };
    });
    bed.addEventListener("pointerup", (e) => {
      if (!start || e.pointerType === "mouse") return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      const dist = Math.hypot(dx, dy);
      const g = this.game;
      if (
        dist > 22 &&
        g &&
        g.status !== "solved" &&
        g.status !== "paused" &&
        !this.autoplaying
      ) {
        // swipe direction = tile direction, so the blank goes the other way
        const dir =
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 3) : dy > 0 ? 0 : 1;
        if (!g.move(dir, { source: "swipe" })) audio.bump();
      } else if (start.cell != null) this.moveCell(start.cell);
      start = null;
    });
    bed.addEventListener("pointercancel", () => {
      start = null;
    });
  }

  togglePause() {
    const g = this.game;
    if (!g || (g.status !== "running" && g.status !== "paused")) return;
    g.togglePause();
  }

  undo() {
    if (this.game && this.game.undo()) {
      this.view.set(this.game.board, this.game.N);
      if (this.coach) this.coach.takeBack(this.game.board);
      this.afterMove();
    }
  }

  /* ---------- coach ---------- */

  toggleCoach() {
    if (this.s.speedMode) return;
    const was = !!this.s.practiceOn;
    setCoach(this.store, !this.s.coachOn);
    toast(
      this.s.coachOn
        ? was
          ? "Coach on."
          : "Coach on. Practice mode is on with it, so nothing here counts."
        : "Coach off. Still in practice mode.",
    );
  }

  /* ---------- practice mode ---------- */

  togglePractice() {
    if (this.s.speedMode) return;
    setPractice(this.store, !this.s.practiceOn);
    toast(
      this.s.practiceOn
        ? "Practice mode on. Solves here do not count toward your averages, records or stats."
        : "Practice mode off. Solves count again.",
    );
  }

  // Bring the current game in line with the switch. A game played in practice stays practice.
  syncPractice() {
    const g = this.game;
    const live = g && (g.status === "ready" || g.status === "running" || g.status === "paused");
    if (live) {
      if (this.s.practiceOn && !this.s.speedMode) {
        g.practice = true;
        g.modded = true;
      } else if (g.practice && g.moves.length === 0) {
        g.practice = false;
        g.modded = !!g.coached || MOD_KEYS.some((k) => this.s[k]);
      }
    }
    this.renderPractice();
  }

  renderPractice() {
    const g = this.game;
    const on = !!g && !!g.practice && !this.s.speedMode;
    this.practiceEl.hidden = !on;
    this.root.classList.toggle("is-practice", on);
  }

  // (Re)attach the coach to the current game. A game the coach has watched is flagged for good.
  setupCoach() {
    const g = this.game;
    this.coach = null;
    clearTimeout(this.backTimer);
    this.backTimer = 0;
    if (!g) return;
    const on = this.s.coachOn && !this.s.speedMode;
    const live = g.status === "ready" || g.status === "running" || g.status === "paused";
    if (on && live && coachAvailable(g.N, this.s.coachTarget)) {
      g.coached = true;
      g.modded = true;
      this.coach = new Coach({
        N: g.N,
        target: this.s.coachTarget,
        method: this.s.coachMethod,
        engine: this.engine,
        onChange: () => this.renderCoach(),
      });
      this.coach.start(g.board);
    } else {
      if (g.coached && g.moves.length === 0 && live) {
        g.coached = false;
        g.modded = !!g.practice || MOD_KEYS.some((k) => this.s[k]);
      }
      this.view.setGuide(null);
      this.renderCoach();
    }
  }

  renderCoach() {
    const g = this.game;
    const c = this.coach;
    const card = this.coachCard;
    if (!this.s.coachOn || this.s.speedMode || !g) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const setting = (key) => (v) => this.store.set(key, v);
    const head = h(
      "div",
      { class: "coach-top" },
      h("h2", null, "Coach"),
      seg(COACH_TARGETS, this.s.coachTarget, setting("coachTarget"), "What the coach compares you with"),
      seg(COACH_LEVELS, this.s.coachLevel, setting("coachLevel"), "How much the coach shows"),
    );
    if (!c) {
      const over = g.status === "solved" || g.status === "failed";
      clear(card).append(
        head,
        h(
          "p",
          { class: "muted" },
          over
            ? "Press Space for the next scramble."
            : this.s.coachTarget === "engine"
              ? "Shortest solve coaching covers 3×3 and 4×4. Switch to My method for this board."
              : "The coach covers boards up to 5×5.",
        ),
      );
      this.view.setGuide(null);
      return;
    }
    const v = c.verdict;
    const bad = v && (v.type === "wrong" || v.type === "side" || v.type === "broke");
    const showHelp = this.s.coachLevel === "guide" || bad || (v && v.type === "back");
    const step = c.currentStep();
    const left = c.left();
    const next = c.nextMove();
    const t = c.tally;
    // the board: route and next tile
    if (g.status === "solved" || g.status === "failed") this.view.setGuide(null);
    else if (showHelp) this.view.setGuide(c.guide(), { bad });
    else this.view.setGuide(null);

    const where =
      c.target === "method"
        ? step
          ? [
              h("div", { class: "label" }, `Step ${c.step + 1} of ${c.plan.steps.length} · ${step.stageName}`),
              h("div", { class: "coach-step" }, step.name),
            ]
          : [h("div", { class: "coach-step" }, "Solved")]
        : [h("div", { class: "label" }, "Shortest solve"), h("div", { class: "coach-step" }, "Every move should bring the whole board closer")];
    const figures = h(
      "div",
      { class: "coach-figs" },
      h(
        "div",
        null,
        h("div", { class: "label" }, c.target === "method" ? "Left in this step" : "Left to solved"),
        h("div", { class: "figure" }, left == null ? "…" : left),
      ),
      h("div", null, h("div", { class: "label" }, "Moves"), h("div", { class: "figure" }, t.moves)),
      h("div", null, h("div", { class: "label" }, "Not needed"), h("div", { class: "figure" + (t.wasted ? " is-bad" : "") }, t.wasted)),
      h("div", null, h("div", { class: "label" }, "Flags"), h("div", { class: "figure" }, t.mistakes)),
    );
    let box = null;
    if (v && v.text)
      box = h(
        "div",
        { class: "coach-verdict coach-verdict--" + v.type },
        h("p", null, h("b", null, v.cost ? `+${v.cost} ` : ""), v.text),
        bad && v.better ? h("p", null, "Better was ", h("b", null, v.better), ".") : null,
        bad && next ? h("p", null, "From here: ", h("b", null, next.text), ". ", c.routeText()) : null,
      );
    else if (c.pending) box = h("div", { class: "coach-verdict" }, h("p", { class: "muted" }, "Checking that move…"));
    const help =
      !bad && showHelp && next
        ? h("p", { class: "coach-next" }, "Next: ", h("b", null, next.text), ". ", c.routeText())
        : null;
    const recent = c.done.slice(-4).reverse();
    clear(card).append(
      head,
      ...where,
      figures,
      box,
      help,
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          { class: "btn btn--small", type: "button", disabled: g.status !== "running" || !g.moves.length, onclick: () => this.undo() },
          "Take it back",
          h("kbd", null, "Z"),
        ),
        h(
          "label",
          { class: "row row--tight coach-auto" },
          (() => {
            const box2 = h("input", { type: "checkbox", checked: !!this.s.coachAutoBack });
            box2.addEventListener("change", () => this.store.set("coachAutoBack", box2.checked));
            return box2;
          })(),
          "Take bad moves back for me",
        ),
      ),
      recent.length
        ? h(
            "table",
            { class: "ledger coach-ledger" },
            h("thead", null, h("tr", null, h("th", null, "Step"), h("th", { class: "tnum" }, "You"), h("th", { class: "tnum" }, "Line"), h("th", { class: "tnum" }, "Over"))),
            h(
              "tbody",
              null,
              ...recent.map((d) =>
                h(
                  "tr",
                  null,
                  h("td", null, d.name),
                  h("td", { class: "tnum" }, d.moves),
                  h("td", { class: "tnum" }, d.line),
                  h("td", { class: "tnum" }, d.moves - d.line > 0 ? "+" + (d.moves - d.line) : "0"),
                ),
              ),
            ),
          )
        : null,
      h(
        "p",
        { class: "hint-text" },
        c.target === "method"
          ? `Yardstick: the shortest way to finish each step of ${c.plan.name.toLowerCase()} without moving what is already placed. Change the order in Settings.`
          : "Yardstick: the shortest solution of the whole board from where you are.",
      ),
    );
    // a move that did not help goes straight back when asked to
    if (bad && this.s.coachAutoBack && g.status === "running" && !this.backTimer) {
      this.backTimer = setTimeout(() => {
        this.backTimer = 0;
        if (this.game === g && this.coach === c && g.status === "running") this.undo();
      }, 420);
    }
  }

  /* ---------- splits (speedrun mode) ---------- */

  setupSplits() {
    const g = this.game;
    if (!g || !this.s.speedMode || !this.s.speedSplits) {
      if (g) g.split = null;
      this.splitEl.hidden = true;
      return;
    }
    const plan = planFor(g.N, this.s.coachMethod);
    const mine = this.store
      .solves({ profileId: this.store.state.activeProfile, N: g.N, clean: true })
      .filter((s) => s.mode !== "custom")
      .slice(-50);
    g.split = { plan, k: stageIndex(g.board, plan), at: [], avg: averageSplits(mine, plan), final: false };
    this.renderSplits();
  }

  renderSplits() {
    const g = this.game;
    const sp = g && g.split;
    if (!sp) {
      this.splitEl.hidden = true;
      return;
    }
    this.splitEl.hidden = false;
    const avg = sp.avg ? sp.avg.at : null;
    const short = (name) => name.replace(" and ", "+").replace("Last three", "Last 3").replace("Last block", "Last 3").replace("Column", "Col");
    clear(this.splitEl).append(
      ...sp.plan.stages.map((st, i) => {
        const t = sp.at[i];
        const d = t != null && avg ? t - avg[i] : null;
        return h(
          "div",
          { class: "split" + (t != null ? " is-done" : i === sp.k ? " is-now" : "") },
          h("span", { class: "split-name" }, short(st.name)),
          h("span", { class: "split-time tnum" }, t != null ? fmtTime(t) : avg ? fmtTime(avg[i]) : "-"),
          h(
            "span",
            { class: "split-delta tnum" + (d == null ? "" : d <= 0 ? " is-ahead" : " is-behind") },
            d == null ? "" : (d <= 0 ? "-" : "+") + fmtTime(Math.abs(d)),
          ),
        );
      }),
    );
  }

  // a stage that just locked gets its time; runs on every move, so it stays tiny
  checkSplit() {
    const g = this.game;
    const sp = g.split;
    const k = stageIndex(g.board, sp.plan);
    if (k <= sp.k) return;
    const ms = g.elapsed();
    while (sp.k < k && sp.k < sp.plan.stages.length) sp.at[sp.k++] = ms;
    this.renderSplits();
  }

  /* ---------- engine helpers ---------- */

  async hint({ silent = false } = {}) {
    const g = this.game;
    if (!g || g.status === "solved" || g.status === "failed") return;
    let path =
      this.solution && this.solution.from === g.moves.length
        ? this.solution.moves
        : null;
    if (!path) {
      const at = g.moves.length;
      try {
        const res = await this.engine.run(
          "solve",
          { board: g.board.slice(), N: g.N, timeLimit: 5000 },
          { lane: "hint", replace: true },
        );
        if (this.game !== g || g.moves.length !== at || g.status === "solved")
          return;
        path = res.moves;
        this.solution = { from: at, moves: path };
      } catch (e) {
        if (!e.cancelled)
          toast("The engine could not find a hint for this position.");
        return;
      }
    }
    if (!path.length) return;
    const n = E.neighbor(g.blank(), path[0], g.N);
    if (n < 0) return;
    this.view.markHint(g.board[n]);
    if (!silent) {
      g.hints++;
      audio.chime();
    }
  }

  async autoSolve() {
    const g = this.game;
    if (!g || g.status === "solved" || g.status === "failed" || this.autoplaying)
      return;
    this.autoplaying = true;
    this.renderControls();
    let res;
    try {
      res = await this.engine.run(
        "solve",
        { board: g.board.slice(), N: g.N, timeLimit: 8000 },
        { lane: "hint", replace: true },
      );
    } catch (e) {
      this.autoplaying = false;
      this.renderControls();
      return;
    }
    if (this.game !== g) return;
    g.autoSolved = true;
    if (g.status === "paused") g.resume();
    const step = Math.max(28, Math.min(110, 4200 / res.moves.length));
    toast(
      res.optimal
        ? `Optimal finish: ${res.moves.length} moves`
        : `Finishing in ${res.moves.length} moves (staged solver)`,
    );
    for (const m of res.moves) {
      if (this.game !== g || !this.autoplaying) return;
      if (!g.move(m, { source: "engine" })) break;
      await new Promise((r) => setTimeout(r, step));
    }
    this.autoplaying = false;
    this.renderControls();
  }

  updateLive() {
    const g = this.game;
    if (!this.s.modLiveDistance || !g) {
      this.liveEl.hidden = true;
      return;
    }
    this.liveEl.hidden = false;
    if (g.status === "solved" || g.status === "failed") {
      this.liveEl.textContent = g.status === "solved" ? "Solved" : "Run over";
      return;
    }
    const pos = g.board.slice();
    const at = g.moves.length;
    if (g.N > 4) {
      this.liveEl.textContent = `Estimate to solved: ${E.heuristic(pos, g.N)}+`;
      return;
    }
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.engine
        .run(
          "distance",
          { board: pos, N: g.N, timeLimit: 3000 },
          { lane: "live", replace: true },
        )
        .then((r) => {
          if (this.game !== g || g.moves.length !== at) return;
          this.liveEl.textContent = r.exact
            ? `Optimal from here: ${r.d}`
            : `Optimal from here: ${r.d} or more`;
        })
        .catch(() => {});
    }, 40);
  }

  /* ---------- events ---------- */

  onGameEvent(type, data) {
    const g = this.game;
    if (type === "move") {
      this.view.set(g.board, g.N);
      if (data.source in g.src) g.src[data.source]++;
      if (g.split && g.status === "running") this.checkSplit();
      if (this.coach && data.source !== "engine") {
        const before = g.board.slice();
        before[data.from] = data.tile;
        before[data.to] = 0;
        this.coach.move(g.board, data.dir, before);
      }
      if (this.s.timerPulse) pulse(this.movesEl);
      audio.tock({
        tile: data.tile,
        col: data.to % g.N,
        N: g.N,
        home: data.to === data.tile - 1,
      });
      this.afterMove(data);
    } else if (type === "start") {
      // looking time: from the scramble landing to the first move (the clock is not running)
      const look = performance.now() - g.dealtAt;
      g.inspect = look < 10 * 60 * 1000 ? Math.round(look) : null;
      this.store.bump(g.N, "started");
      this.view.setRunning(true);
      this.startLoop();
      this.renderControls();
      if (!this.store.state.seenIntro) {
        this.store.markIntroSeen();
        this.introLine.remove();
      }
    } else if (type === "pause") {
      this.setCover("Paused", "Press P or click to resume");
      this.view.setHidden(true);
      this.cover.hidden = false;
      this.renderControls();
    } else if (type === "resume") {
      this.view.setHidden(false);
      this.cover.hidden = true;
      this.renderControls();
      if (g.pendingFail) g.fail(g.pendingFail);
    } else if (type === "solved") {
      this.view.setRunning(false);
      this.onSolved();
    } else if (type === "failed") {
      this.onFailed(data.reason);
    }
  }

  afterMove(data) {
    const g = this.game;
    this.updateFigures();
    if (this.s.modHeatmap) this.view.setHeat(true);
    // keep a cached optimal path if the player followed it
    if (
      this.solution &&
      data &&
      this.solution.moves[0] === data.dir &&
      this.solution.from === g.moves.length - 1
    ) {
      this.solution = {
        from: g.moves.length,
        moves: this.solution.moves.slice(1),
      };
    } else if (this.solution && this.solution.from !== g.moves.length) {
      this.solution = null;
    }
    if (!this.coach) this.view.markHint(null);
    if (this.s.modBudget && g.status === "running") {
      const limit = budgetFor(g.N, g.optimal);
      if (limit != null && g.moves.length > limit)
        g.fail(
          `Over budget: ${limit} moves allowed, the engine needed ${g.optimal}.`,
        );
    }
    if (this.s.modNoWrong && g.N <= 4 && g.status === "running")
      this.checkWrongWay(g);
    if (this.s.modGhostHint && g.status === "running")
      this.hint({ silent: true });
    this.updateLive();
  }

  startLoop() {
    const tick = () => {
      this.updateFigures();
      const st = this.game && this.game.status;
      if (st === "solved" || st === "failed") return;
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  setCover(title, sub) {
    this.cover.replaceChildren(title, h("small", null, sub));
  }

  applyViewMods() {
    this.view.setMods(
      Object.fromEntries(
        Object.entries(VIEW_MODS).map(([k, cls]) => [cls, this.s[k]]),
      ),
    );
  }

  // Sudden death: each position's exact distance must never rise. Results can land in any order,
  // so every new distance is checked against both neighbours.
  checkWrongWay(g) {
    const d = g.dists || (g.dists = {});
    const ask = (k, board) =>
      this.engine
        .run("distance", { board, N: g.N, timeLimit: 3000 }, { lane: "sudden" })
        .then((r) => {
          if (!r || !r.exact) return;
          d[k] = r.d;
          for (const j of [k, k + 1]) {
            if (d[j] == null || d[j - 1] == null || d[j] <= d[j - 1]) continue;
            const msg = `Move ${j} went the wrong way: ${d[j - 1]} moves from solved before it, ${d[j]} after.`;
            if (this.game !== g) return;
            if (g.status === "running") g.fail(msg);
            else if (g.status === "paused") g.pendingFail = msg;
            return;
          }
        })
        .catch(() => {});
    const k = g.moves.length;
    if (k === 1 && d[0] == null) ask(0, g.start.slice());
    ask(k, g.board.slice());
  }

  onFailed(reason) {
    if (this.game && !this.game.counted) {
      this.game.counted = true;
      this.store.bump(this.game.N, "failed");
    }
    this.stopLoop();
    this.updateFigures();
    this.view.setRunning(false);
    this.view.markHint(null);
    audio.fail();
    this.marathon = null;
    this.setCover("Run over", reason + " Space for a new scramble, R to retry.");
    this.cover.classList.add("cover--over");
    this.cover.hidden = false;
    this.renderControls();
  }

  // Marathon: five in a row, the next scramble starts as soon as one is solved.
  marathonStep(solve) {
    if (!this.s.modMarathon) {
      this.marathon = null;
      return;
    }
    let m = this.marathon;
    if (!m || m.N !== solve.N) m = this.marathon = { N: solve.N, n: 0, total: 0, moves: 0 };
    m.n++;
    m.total += solve.duration;
    m.moves += solve.moveCount;
    if (m.n < 5) {
      toast(`Marathon ${m.n} of 5 · ${fmtTime(m.total)} s so far`);
      setTimeout(() => {
        if (this.game && this.game.solveId === solve.id && this.s.modMarathon)
          this.newGame({ N: solve.N, marathon: true });
      }, 900);
    } else {
      toast(
        `Marathon done: 5 solves in ${fmtTime(m.total)} s, ${m.moves} moves`,
      );
      this.marathon = null;
    }
  }

  stopLoop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  updateFigures() {
    const g = this.game;
    if (!g) return;
    const ms = g.elapsed();
    if (
      this.s.modTimeAttack &&
      (g.status === "running" || g.status === "ready" || g.status === "paused")
    ) {
      const left = timeLimit(g.N) - ms;
      if (left <= 0 && g.status === "running") {
        g.fail(`Time's up: ${fmtTime(timeLimit(g.N))} s on ${g.N}×${g.N}.`);
        return;
      }
      this.timeEl.textContent = fmtTime(Math.max(0, left));
      this.timeEl.className = "figure timer is-countdown";
      this.movesEl.textContent = g.moves.length;
      this.tpsEl.textContent = this.liveFigure(g, ms);
      return;
    }
    this.timeEl.textContent =
      this.s.showTimer || g.status === "solved" ? fmtTime(ms) : "··";
    this.timeEl.className =
      "figure timer is-" + (g.status === "paused" ? "running" : g.status);
    this.movesEl.textContent = g.moves.length;
    this.tpsEl.textContent = this.liveFigure(g, ms);
  }

  // the third figure on the ticket is a setting: speed, time per move, or the last gap
  liveFigure(g, ms) {
    const n = g.moves.length;
    const kind = this.s.liveStat;
    if (kind === "mspm") return n ? String(Math.round(ms / n)) : "0";
    if (kind === "gap") {
      if (n < 2) return "0";
      return String(Math.round(g.times[n - 1] - g.times[n - 2]));
    }
    return ms > 0 ? (n / (ms / 1000)).toFixed(1) : "0.0";
  }

  renderSeedLine() {
    const g = this.game;
    const parts = [];
    const modeName = {
      random: "",
      daily: "Daily " + todayKey(),
      seed: "Seed",
      custom: "Custom board",
    }[g.mode];
    if (modeName) parts.push(h("span", null, modeName + (g.seed && g.mode !== "daily" ? " " : "")));
    if (g.seed && g.mode !== "daily" && g.mode !== "custom") {
      parts.push(
        h(
          "button",
          {
            type: "button",
            title: "Copy a link to this scramble",
            onclick: () => this.copySeed(),
          },
          g.seed,
        ),
      );
    }
    if (g.optimal != null) {
      const r = rarity(g.N, g.optimal);
      const word = difficultyWord(r);
      // where this scramble sits among every position of the size
      let where = "";
      if (r.harderThan != null) {
        const harder = 1 - r.pAtMost; // positions that need more moves
        where =
          r.harderThan >= harder
            ? ` · harder than ${pctFine(r.harderThan)}`
            : ` · easier than ${pctFine(harder)}`;
      }
      parts.push(
        h(
          "span",
          {
            class: "muted",
            title:
              r.harderThan != null
                ? `Needs ${g.optimal} moves. ${pctFine(r.harderThan)} of all positions need fewer, ${pctFine(1 - r.pAtMost)} need more.`
                : null,
          },
          `  ${word ? word : "scramble"}${where}`,
        ),
      );
    }
    clear(this.seedLine).append(...parts);
  }

  copySeed() {
    const g = this.game;
    const token = /^[A-Za-z0-9]+$/.test(g.seed) ? ` (or add #seed-${g.N}-${g.seed} to the game's link)` : "";
    const text = `Fifteen Press ${g.N}x${g.N} seed: ${g.seed}${token}`;
    copyText(text).then((ok) => toast(ok ? "Seed copied. Paste it to a friend." : "Could not copy. The seed is " + g.seed));
  }

  onSolved() {
    const g = this.game;
    this.stopLoop();
    this.updateFigures();
    this.view.markHint(null);
    this.view.inkWave();
    audio.thunk();
    this.renderControls();
    if (g.autoSolved) {
      this.countAbandoned();
      this.lastSolve = null;
      this.renderSide({ engineSolved: true });
      return;
    }
    const prior = this.store.solves({
      profileId: this.store.state.activeProfile,
      N: g.N,
      clean: true,
    });
    const priorSum = summarize(prior);
    const solve = {
      id:
        "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      profileId: this.store.state.activeProfile,
      N: g.N,
      mode: g.mode,
      seed: g.seed,
      label: g.label,
      start: g.start.slice(),
      moves: encodeMoves(g.moves),
      times: encodeTimes(g.times),
      duration: Math.round(g.elapsed()),
      moveCount: g.moves.length,
      optimal: g.optimal,
      optimalExact: g.optimalExact,
      date: Date.now(),
      daily: g.mode === "daily" ? String(g.seed).slice(6) : null,
      assisted: g.hints > 0,
      hints: g.hints,
      undos: g.undos,
      modded: g.modded || g.undos > 0,
      coached: !!g.coached,
      practice: !!g.practice,
      coach: this.coach ? this.coach.summary() : null,
      inspect: g.inspect ?? null,
      input: Object.entries(g.src || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "key",
    };
    g.solveId = solve.id;
    g.counted = true;
    this.store.bump(g.N, "solved");
    this.store.addSolve(solve);
    // hand-built boards and instant finishes stay out of records
    const clean =
      !solve.assisted &&
      !solve.modded &&
      solve.mode !== "custom" &&
      solve.duration >= 200 &&
      solve.moveCount > 0;
    if (!clean && !solve.assisted && !solve.modded) {
      solve.modded = true;
      this.store.updateSolve(solve.id, { modded: true });
    }
    solve.pbTime =
      clean && prior.length > 0 && solve.duration < priorSum.bestTime;
    solve.pbMoves =
      clean && prior.length > 0 && solve.moveCount < priorSum.bestMoves;
    solve.first = clean && prior.length === 0;
    this.lastSolve = solve;
    this.store.updateSolve(solve.id, {
      pbTime: solve.pbTime,
      pbMoves: solve.pbMoves,
      first: solve.first,
    });
    if (g.split) {
      // exact splits now that the solve is whole
      const exact = splitsOf(solve, g.split.plan);
      if (exact) g.split.at = exact.slice();
      g.split.k = g.split.plan.stages.length;
      this.renderSplits();
    }
    if (this.coach) {
      this.view.setGuide(null);
      this.lastCoach = this.coach.summary();
    }
    this.renderSide();
    if (this.s.speedMode && this.s.speedAutoNext > 0) {
      clearTimeout(this.autoNextTimer);
      this.autoNextTimer = setTimeout(() => {
        if (this.game === g && this.s.speedMode && !this.root.hidden) this.newGame({ N: g.N });
      }, this.s.speedAutoNext);
    }
    const who = this.store.profile();
    if (clean)
      submitGlobal(solve, (who && who.name) || "Player").catch(() => {});
    if (this.s.autoGrade && solve.N <= 4) gradeOne(solve.id);
    syncSoon(2000);
    this.marathonStep(solve);
  }

  /* ---------- side panel ---------- */

  renderSide({ engineSolved = false } = {}) {
    const g = this.game;
    if (this.speedEl && g) {
      const all = this.store.solves({
        profileId: this.store.state.activeProfile,
        N: g.N,
        clean: true,
      });
      this.speedEl.textContent = speedLine(summarize(all));
    }
    const items = [];
    if (engineSolved) {
      items.push(
        h(
          "div",
          { class: "proof-card" },
          h("h2", null, "Engine ", h("span", null, "finish")),
          h(
            "p",
            { class: "verdict", style: { marginTop: "12px" } },
            "The engine finished this one, so it stays out of your stats. Press Space for a fresh scramble.",
          ),
          h(
            "div",
            { class: "actions" },
            h(
              "button",
              {
                class: "btn btn--primary",
                type: "button",
                onclick: () => this.newGame({ N: g.N }),
              },
              "Next scramble",
              h("kbd", null, "Space"),
            ),
          ),
        ),
      );
    } else if (this.lastSolve && g && g.solveId === this.lastSolve.id) {
      items.push(this.proofCard(this.lastSolve));
    }
    items.push(this.sessionPanel());
    const solves = g
      ? this.store.solves({ profileId: this.store.state.activeProfile, N: g.N, clean: true })
      : [];
    clear(this.side).append(this.helloBlock(solves), this.coachCard, ...items);
    this.renderCoach();
    this.renderRecords(solves);
  }

  // Top right, as on Command Centre: one line of welcome by the hour, then what the count stands at.
  helloBlock(solves) {
    const N = this.game ? this.game.N : this.s.size;
    const today = new Date().setHours(0, 0, 0, 0);
    const todayCount = solves.filter((s) => s.date >= today).length;
    const line = !solves.length
      ? `No ${N}×${N} solves yet. Space deals a scramble, and the clock starts on your first move.`
      : `${solves.length} solve${solves.length === 1 ? "" : "s"} on ${N}×${N}, ${todayCount || "none"} today.`;
    return h("div", { class: "hello" }, h("h1", null, greeting()), h("p", null, line));
  }

  // Left of the board, held to the bottom: the best single, current against best for the averages,
  // and the five quickest solves. All of it for the board size on the table.
  renderRecords(solves) {
    const best = solves.length ? solves.reduce((a, b) => (b.duration < a.duration ? b : a)) : null;
    clear(this.records).append(
      best
        ? h(
            "div",
            { class: "rec-block" },
            h(
              "div",
              { class: "best" },
              h("div", { class: "label" }, "Best single"),
              h("div", { class: "figure tnum" }, fmtTime(best.duration)),
              h("div", { class: "sub" }, `${best.moveCount} moves, ${relDate(best.date)}`),
            ),
            averagesTable(summarize(solves), { short: true }),
            fastestList(solves, (id) => this.ctx.app.go("proofs", id)),
          )
        : null,
    );
  }

  proofCard(s) {
    s = this.store.getSolve(s.id) || s;
    const deep = deepOf(s);
    const tps = s.duration ? s.moveCount / (s.duration / 1000) : 0;
    const eff = s.optimal ? s.optimal / s.moveCount : null;
    let verdict;
    if (s.practice && !s.coached)
      verdict = "Practice solve. It is saved on the Solves page but does not count toward your averages, records or stats.";
    else if (s.coached)
      verdict = s.coach
        ? `Coached solve: ${s.coach.wasted} move${s.coach.wasted === 1 ? "" : "s"} not needed across ${s.coach.mistakes} flag${s.coach.mistakes === 1 ? "" : "s"}. It does not count toward your averages or records.`
        : "Coached solve. It does not count toward your averages or records.";
    else if (s.assisted)
      verdict = `Solved with ${s.hints} hint${s.hints === 1 ? "" : "s"}. Hinted solves stay off the leaderboard.`;
    else if (s.modded)
      verdict =
        "Mods were on, so this solve is kept apart from your clean stats.";
    else if (s.first)
      verdict = `Your first ${s.N}×${s.N} solve. Every one from here gets compared to it.`;
    else if (s.pbTime) verdict = "New personal best time.";
    else if (s.pbMoves) verdict = "New personal best for fewest moves.";
    else if (eff != null && eff >= 0.8)
      verdict = "Very close to the engine's line.";
    else verdict = "Read the proof to see where the moves went.";
    return h(
      "div",
      { class: "proof-card", "aria-live": "polite" },
      h("h2", null, "Proof ", h("span", null, "pulled")),
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          null,
          h("div", { class: "label" }, "Time"),
          h(
            "div",
            { class: "figure" },
            fmtTime(s.duration),
            s.pbTime ? h("span", { class: "pb-flag" }, "PB") : null,
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Moves"),
          h(
            "div",
            { class: "figure" },
            s.moveCount,
            s.pbMoves ? h("span", { class: "pb-flag" }, "PB") : null,
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Optimal"),
          h(
            "div",
            { class: "figure" },
            s.optimal != null ? s.optimal : s.N <= 4 ? "…" : "n/a",
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Efficiency"),
          h(
            "div",
            { class: "figure" },
            eff != null ? Math.round(eff * 100) : "-",
            eff != null ? h("small", null, "%") : null,
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Tiles/sec"),
          h("div", { class: "figure" }, tps.toFixed(1)),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Wasted"),
          h(
            "div",
            { class: "figure" },
            s.optimal != null ? s.moveCount - s.optimal : "-",
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Per move"),
          h("div", { class: "figure" }, deep.msPerMove != null ? Math.round(deep.msPerMove) : "-", h("small", null, "ms")),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Longest stop"),
          h("div", { class: "figure figure--text" }, fmtMs(deep.gapMax)),
        ),
        h(
          "div",
          null,
          h("div", { class: "label" }, "Accuracy"),
          h(
            "div",
            { class: "figure" },
            deep.accuracy != null ? Math.round(deep.accuracy * 100) : s.N <= 4 ? "…" : "n/a",
            deep.accuracy != null ? h("small", null, "%") : null,
          ),
        ),
      ),
      h("p", { class: "verdict" }, verdict),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onclick: () => this.newGame({ N: s.N }),
          },
          "Next",
          h("kbd", null, "Space"),
        ),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => this.ctx.app.go("proofs", s.id),
          },
          "Read the full proof",
        ),
      ),
    );
  }

  sessionPanel() {
    const N = this.game ? this.game.N : this.s.size;
    const solves = this.store.solves({
      profileId: this.store.state.activeProfile,
      N,
      clean: true,
    });
    const sum = summarize(solves);
    const recent = this.store
      .solves({ profileId: this.store.state.activeProfile, N })
      .slice(-7)
      .reverse();
    return h(
      "section",
      { class: "session" },
      h("h3", { class: "label" }, "Last solves"),
      recent.length
        ? h(
            "ol",
            { class: "recent", reversed: true },
            ...recent.map((s, i) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    onclick: () => this.ctx.app.go("proofs", s.id),
                    "aria-label": `Open proof for ${fmtTime(s.duration)} solve`,
                  },
                  h(
                    "span",
                    { class: "n" },
                    this.store.solves({
                      profileId: this.store.state.activeProfile,
                      N,
                    }).length - i,
                  ),
                  h("span", { class: "t" }, fmtTime(s.duration)),
                  h("span", { class: "m" }, s.moveCount + " moves"),
                  h(
                    "span",
                    { class: "e" },
                    s.coached
                      ? "coach"
                      : s.practice
                        ? "practice"
                        : s.assisted
                      ? "hint"
                      : s.modded
                        ? "mod"
                        : s.optimal
                          ? Math.round((s.optimal / s.moveCount) * 100) + "%"
                          : "",
                  ),
                ),
              ),
            ),
          )
        : h(
            "p",
            { class: "muted", style: { fontSize: "14px" } },
            "Solve one and it lands here. Times only count from your first move.",
          ),
    );
  }

  factBlock() {
    const facts = D.FACTS;
    const i = Math.floor(Date.now() / 86400000) % facts.length;
    return h(
      "div",
      { class: "fact" },
      h("span", { class: "label" }, "Puzzle fact"),
      facts[i],
    );
  }

  /* ---------- view lifecycle ---------- */

  show(param) {
    if (param && param.startsWith("s/")) {
      const [, n, ...rest] = param.split("/");
      const N = Math.max(3, Math.min(10, parseInt(n, 10) || 4));
      let seed = "";
      try {
        seed = decodeURIComponent(rest.join("/"));
      } catch (e) {}
      if (seed) {
        this.newGame({ N, mode: "seed", seed });
        history.replaceState(null, "", "#play");
        return;
      }
    }
    if (param && param.startsWith("b/")) {
      // board handed over from the lab: b/N/1,2,3,...
      const [, n, list] = param.split("/");
      const N = parseInt(n, 10);
      const board = (list || "").split(",").map(Number);
      const valid =
        N >= 3 &&
        N <= 10 &&
        board.length === N * N &&
        board.every((v) => Number.isInteger(v) && v >= 0 && v < N * N) &&
        new Set(board).size === N * N;
      if (valid && E.isSolvable(board, N)) {
        this.newGame({ N, mode: "custom", board });
        history.replaceState(null, "", "#play");
        return;
      }
    }
    if (!this.game) this.newGame({ N: this.s.size });
    else this.renderSide();
  }

  hide() {
    if (this.game && this.game.status === "running") this.game.pause();
    this.autoplaying = false;
  }

  onStore(e) {
    if (e.type === "settings") {
      if (e.key === "coloring") this.view.setColoring(this.s.coloring);
      if (MOD_KEYS.includes(e.key) || e.key === "modBigBoards") {
        if (this.game && MOD_KEYS.some((k) => this.s[k]))
          this.game.modded = true;
        this.renderSetup();
        this.renderControls();
        this.view.setHeat(this.s.modHeatmap);
        this.applyViewMods();
        this.updateLive();
      }
      if (e.key === "showTimer") this.updateFigures();
      if (e.key === "liveStat") {
        this.liveLabel.textContent = LIVE[this.s.liveStat] || LIVE.tps;
        this.updateFigures();
      }
      if (e.key === "speedMode") {
        this.renderControls();
        this.syncPractice();
        this.view.fast = !!this.s.speedMode;
        if (this.game) {
          this.setupCoach();
          this.setupSplits();
        }
      }
      if (e.key === "speedSplits" && this.game) this.setupSplits();
      if (e.key === "practiceOn") {
        this.renderControls();
        this.syncPractice();
      }
      if (["coachOn", "coachTarget", "coachMethod"].includes(e.key)) {
        this.renderControls();
        if (this.game) this.setupCoach();
      }
      if (e.key === "coachLevel" || e.key === "coachAutoBack") this.renderCoach();
    }
    if (e.type === "profile" || e.type === "all" || e.type === "solves" || e.type === "graded") {
      if (!this.root.hidden) this.renderSide();
    }
  }
}

export { fmtNum, fmtPct, relDate };

// One line of welcome over the records, by the hour. Same parts of the day as the Command Centre clock.
function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return "it's late.";
  if (hr < 11) return "good morning.";
  if (hr < 17) return "good afternoon.";
  if (hr < 22) return "good evening.";
  return "good night.";
}

// The five quickest clean solves of this size, on the Play page so they are always in view.
function fastestList(solves, open) {
  if (solves.length < 2) return null;
  const top = solves
    .slice()
    .sort((a, b) => a.duration - b.duration)
    .slice(0, 5);
  return h(
    "div",
    { class: "fastest-mini" },
    h("div", { class: "fastest-mini-head" }, h("span", { class: "label" }, "Fastest"), h("a", { href: "#solves/fastest" }, "all")),
    ...top.map((s, i) =>
      h(
        "button",
        { type: "button", class: "fastest-mini-row", title: "Open the proof", onclick: () => open(s.id) },
        h("span", { class: "n" }, i + 1),
        h("span", { class: "t tnum" }, fmtTime(s.duration)),
        h("span", { class: "m" }, s.moveCount + " moves"),
        h("span", { class: "d" }, relDate(s.date)),
      ),
    ),
  );
}

// csTimer-style: current and best for the single, mo3 and the trimmed averages.
// short: the four averages only. The single sits above the table as the big figure, and the last
// solve is in the list on the right.
function averagesTable(sum, { short = false } = {}) {
  const rows = [
    ["Single", sum.last, sum.bestTime],
    ["Mo3", sum.mo3.current, sum.mo3.best],
    ["Ao5", sum.ao5.current, sum.ao5.best],
    ["Ao12", sum.ao12.current, sum.ao12.best],
    ["Ao50", sum.ao50.current, sum.ao50.best],
    ["Ao100", sum.ao100.current, sum.ao100.best],
  ].slice(short ? 2 : 0);
  return h(
    "table",
    { class: "avg-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, short ? "Average" : ""),
        h("th", { class: "tnum" }, "Now"),
        h("th", { class: "tnum" }, "Best"),
      ),
    ),
    h(
      "tbody",
      null,
      ...rows.map(([label, cur, best]) =>
        h(
          "tr",
          { class: cur != null && best != null && cur <= best ? "is-pb" : null },
          h("th", { scope: "row" }, label),
          h("td", { class: "tnum" }, fmtTime(cur)),
          h("td", { class: "tnum" }, fmtTime(best)),
        ),
      ),
    ),
  );
}

export function speedLine(sum) {
  const bits = [
    ["mo3", sum.mo3.current],
    ["ao5", sum.ao5.current],
    ["ao12", sum.ao12.current],
    ["best", sum.bestTime],
  ].filter(([, v]) => v != null);
  return bits.map(([k, v]) => `${k} ${fmtTime(v)}`).join("   ");
}
