// Live coach: watches every move of a game and says, at once, when one did not help and what
// to do instead. Two yardsticks:
//   method : the shortest way to finish the step you are on (tile by tile, pairs at line ends)
//   engine : the shortest solution of the whole board (3x3 and 4x4)
import { planFor, stepIndex, lineFor, routeOf, blankPath, describeRoute, TILE_WORD } from "./steps.js";

const E = window.FifteenEngine;

export const COACH_TARGETS = [
  { value: "method", label: "My method", title: "Judges each move against the shortest way to finish the step you are on" },
  { value: "engine", label: "Shortest solve", title: "Judges each move against the shortest solution of the whole board (3×3 and 4×4)" },
];
export const COACH_LEVELS = [
  { value: "mistakes", label: "Only mistakes", title: "Stays quiet until a move does not help" },
  { value: "guide", label: "Always guide", title: "Always shows the route and the next tile" },
];

export function coachAvailable(N, target) {
  return target === "engine" ? N <= 4 : N <= 5;
}

const tileAt = (board, N, dir) => {
  const n = E.neighbor(board.indexOf(0), dir, N);
  return n < 0 ? null : board[n];
};
const say = (board, N, dir) => `${tileAt(board, N, dir)} ${TILE_WORD[dir]}`;
const list = (xs) => (xs.length < 2 ? String(xs[0]) : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

export class Coach {
  constructor({ N, target = "method", method = "rows", engine = null, onChange = null }) {
    this.N = N;
    this.target = coachAvailable(N, target) ? target : "method";
    this.plan = planFor(N, method);
    this.engine = engine;
    this.onChange = onChange;
    this.tally = { moves: 0, wasted: 0, mistakes: 0, good: 0, side: 0, wrong: 0, broke: 0 };
    this.done = []; // finished steps: { name, stageName, moves, line }
    this.log = []; // every flagged move: { at, type, cost, text }
    this.verdict = null;
    this.pending = false;
    this.ticket = 0;
  }

  /** Call once with the starting board, and again after a take-back. */
  start(board, { keepTally = false } = {}) {
    this.board = board.slice();
    if (!keepTally) {
      this.tally = { moves: 0, wasted: 0, mistakes: 0, good: 0, side: 0, wrong: 0, broke: 0 };
      this.done = [];
      this.log = [];
    }
    this.verdict = null;
    this.ticket++;
    if (this.target === "method") {
      this.step = stepIndex(board, this.plan);
      this.line = lineFor(board, this.plan, this.step) || [];
      this.stepStartLine = this.line.length;
      this.stepMoves = 0;
    } else {
      this.line = null;
      this.known = null; // { at: move number, d: distance }
      this.ask(board, 0);
    }
    this.emit();
  }

  emit() {
    if (this.onChange) this.onChange(this);
  }

  /** After a move. `dir` is the blank direction that was played, `before` the board before it. */
  move(board, dir, before) {
    this.tally.moves++;
    if (this.target === "method") this.judgeMethod(board, dir, before);
    else this.judgeEngine(board, dir, before);
    this.board = board.slice();
    this.emit();
  }

  /** The last move was taken back: it no longer counts against the solve. */
  takeBack(board) {
    const t = this.tally;
    const last = this.log[this.log.length - 1];
    if (last && last.at === t.moves && !last.undone) {
      t.wasted -= last.cost;
      last.undone = true;
    }
    t.moves = Math.max(0, t.moves - 1);
    this.board = board.slice();
    this.ticket++;
    if (this.target === "method") {
      this.step = stepIndex(board, this.plan);
      this.line = lineFor(board, this.plan, this.step) || [];
      this.stepMoves = Math.max(0, this.stepMoves - 1);
    } else {
      this.line = null;
      this.known = null;
      this.pendingMove = null;
      this.ask(board, t.moves);
    }
    this.verdict = { type: "back", cost: 0, text: "Taken back. Try the other way." };
    this.emit();
  }

  flag(type, cost, text, better) {
    const t = this.tally;
    t.wasted += cost;
    t.mistakes++;
    t[type]++;
    this.verdict = { type, cost, text, better };
    this.log.push({ at: t.moves, type, cost, text });
  }

  /* ---------- method yardstick ---------- */

  judgeMethod(board, dir, before) {
    const plan = this.plan;
    const prevStep = this.step;
    const prevLine = this.line || [];
    const prevLeft = prevLine.length;
    const step = stepIndex(board, plan);
    const line = lineFor(board, plan, step) || [];
    this.stepMoves++;
    const played = say(before, this.N, dir);
    const betterDir = prevLine.length ? prevLine[0] : null;
    const better = betterDir != null && betterDir !== dir ? say(before, this.N, betterDir) : null;

    if (step > prevStep) {
      // one or more steps finished with this move
      const s = plan.steps[prevStep];
      this.done.push({ name: s.name, stageName: s.stageName, moves: this.stepMoves, line: this.stepStartLine });
      this.tally.good++;
      const over = this.stepMoves - this.stepStartLine;
      this.verdict = {
        type: "done",
        cost: 0,
        text:
          step >= plan.steps.length
            ? "Solved."
            : `${s.name}: done in ${this.stepMoves}` + (over > 0 ? `, ${over} over the line.` : ", on the line."),
      };
      this.stepMoves = 0;
      this.stepStartLine = line.length;
    } else if (step < prevStep) {
      const s = plan.steps[step];
      const out = s.tiles.filter((t) => board[t - 1] !== t);
      this.flag(
        "broke",
        2,
        `${played} pulled ${list(out)} out of place. Put ${out.length > 1 ? "them" : "it"} back before going on.`,
        better,
      );
      // the step being rebuilt gets a fresh count
      this.stepMoves = 0;
      this.stepStartLine = line.length;
    } else {
      const delta = line.length - prevLeft;
      if (delta < 0) {
        this.tally.good++;
        this.verdict = { type: "good", cost: 0, text: "" };
      } else {
        const s = plan.steps[step];
        const targets = (s.tiles.length > 1 ? "tiles " : "tile ") + list(s.tiles);
        if (delta > 0)
          this.flag("wrong", 2, `Wrong way. Sliding ${played} put ${targets} further from home.`, better);
        else this.flag("side", 1, `No progress. Sliding ${played} did not bring ${targets} closer.`, better);
      }
    }
    this.step = step;
    this.line = line;
  }

  /* ---------- engine yardstick ---------- */

  judgeEngine(board, dir, before) {
    const at = this.tally.moves;
    // following the known line needs no search
    if (this.line && this.lineAt === at - 1 && this.line[0] === dir) {
      this.line = this.line.slice(1);
      this.lineAt = at;
      this.known = { at, d: this.line.length };
      this.tally.good++;
      this.verdict = { type: E.isSolved(board) ? "done" : "good", cost: 0, text: E.isSolved(board) ? "Solved." : "" };
      return;
    }
    const prevLine = this.line && this.lineAt === at - 1 ? this.line : null;
    this.pendingMove = {
      played: say(before, this.N, dir),
      better: prevLine && prevLine.length ? say(before, this.N, prevLine[0]) : null,
    };
    this.line = null;
    this.ask(board, at);
  }

  ask(board, at) {
    if (!this.engine) return;
    if (E.isSolved(board)) {
      this.line = [];
      this.lineAt = at;
      this.known = { at, d: 0 };
      this.pending = false;
      return;
    }
    const ticket = ++this.ticket;
    this.pending = true;
    this.engine
      .run("solve", { board: board.slice(), N: this.N, timeLimit: 6000 }, { lane: "coach", replace: true })
      .then((res) => {
        if (ticket !== this.ticket) return;
        this.pending = false;
        if (!res || !res.optimal) {
          // too deep to prove in time: keep the line as a suggestion, judge nothing
          this.line = res ? res.moves : null;
          this.lineAt = at;
          this.known = null;
          this.pendingMove = null;
          this.emit();
          return;
        }
        const d = res.moves.length;
        if (this.known && at > this.known.at) {
          const span = at - this.known.at;
          const cost = span + (d - this.known.d); // moves that did not shorten the solution
          if (cost > 0) {
            const pm = this.pendingMove;
            const what = span === 1 && pm ? `${pm.played} moved away from the shortest solve.` : `The last ${span} moves gave back ${cost}.`;
            this.flag("wrong", cost, `Wrong way. ${what}`, span === 1 && pm ? pm.better : null);
          } else {
            this.tally.good += span;
            this.verdict = { type: "good", cost: 0, text: "" };
          }
        }
        this.line = res.moves;
        this.lineAt = at;
        this.known = { at, d };
        this.pendingMove = null;
        this.emit();
      })
      .catch(() => {
        if (ticket === this.ticket) this.pending = false;
      });
  }

  /* ---------- what the board and the panel show ---------- */

  /** Moves still needed on the current yardstick, or null while the engine is thinking. */
  left() {
    return this.line ? this.line.length : null;
  }

  currentStep() {
    if (this.target !== "method") return null;
    return this.plan.steps[this.step] || null;
  }

  nextMove() {
    if (!this.line || !this.line.length) return null;
    const dir = this.line[0];
    const tile = tileAt(this.board, this.N, dir);
    return tile == null ? null : { dir, tile, text: `${tile} ${TILE_WORD[dir]}` };
  }

  /** Routes to draw: each target tile's way home (method) or the gap's next moves (engine). */
  guide() {
    if (!this.line || !this.line.length) return null;
    const N = this.N;
    if (this.target === "method") {
      const s = this.currentStep();
      if (!s) return null;
      const routes = s.tiles
        .map((t) => ({ tile: t, cells: routeOf(this.board, N, this.line, t), kind: "tile" }))
        .filter((r) => r.cells.length > 1);
      return { routes, homes: s.tiles.filter((t) => this.board[t - 1] !== t).map((t) => t - 1), targets: s.tiles, next: this.nextMove() };
    }
    return {
      routes: [{ cells: blankPath(this.board, N, this.line, 6), kind: "blank" }],
      homes: [],
      targets: [],
      next: this.nextMove(),
    };
  }

  /** One sentence on how the target gets home from here. */
  routeText() {
    const g = this.guide();
    if (!g) return "";
    if (this.target === "method") {
      const parts = g.routes.map((r) => `${r.tile} goes ${describeRoute(r.cells, this.N)}`);
      return parts.length ? "Route: " + parts.join(", ") + "." : "";
    }
    const seq = this.line.slice(0, 5);
    const b = this.board.slice();
    const words = [];
    for (const m of seq) {
      words.push(say(b, this.N, m));
      E.applyMove(b, this.N, m);
    }
    return "Line: " + words.join(", ") + (this.line.length > seq.length ? ", ..." : ".");
  }

  /** What gets stored with the solve. */
  summary() {
    const t = this.tally;
    return {
      target: this.target,
      method: this.plan.id,
      moves: t.moves,
      wasted: t.wasted,
      mistakes: t.mistakes,
      wrong: t.wrong,
      side: t.side,
      broke: t.broke,
      steps: this.done.map((s) => ({ n: s.name, g: s.stageName, m: s.moves, l: s.line })),
    };
  }
}
