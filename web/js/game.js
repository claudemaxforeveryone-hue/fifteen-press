// One game: board, move log, timer. Knows nothing about the DOM.
const E = window.FifteenEngine;

export class Game {
  constructor({ N, board, seed = null, mode = "random", label = "", goal = null }) {
    this.N = N;
    this.start = board.slice();
    this.board = board.slice();
    this.seed = seed;
    this.mode = mode; // 'random' | 'daily' | 'seed' | 'custom'
    this.label = label;
    this.goal = goal; // drills end on their own condition; a normal game ends when solved
    this.moves = [];
    this.times = [];
    this.status = "ready"; // ready | running | paused | solved | failed
    this.t0 = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.finishedAt = 0;
    this.hints = 0;
    this.autoSolved = false;
    this.undos = 0;
    this.modded = false;
    this.optimal = null; // optimal length of the start position, filled in by the engine
    this.optimalExact = false;
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners) fn(type, data);
  }

  elapsed() {
    if (this.status === "ready") return 0;
    if (this.status === "solved" || this.status === "failed")
      return this.finishedAt - this.t0 - this.pausedTotal;
    if (this.status === "paused")
      return this.pausedAt - this.t0 - this.pausedTotal;
    return performance.now() - this.t0 - this.pausedTotal;
  }

  blank() {
    return this.board.indexOf(0);
  }

  canMove(dir) {
    return (
      this.status !== "solved" &&
      this.status !== "failed" &&
      this.status !== "paused" &&
      E.neighbor(this.blank(), dir, this.N) >= 0
    );
  }

  // dir = direction the blank travels
  move(dir, { source = "key" } = {}) {
    if (!this.canMove(dir)) return false;
    const t = performance.now();
    if (this.status === "ready") {
      this.status = "running";
      this.t0 = t;
      this.emit("start");
    }
    const b = this.blank();
    const n = E.neighbor(b, dir, this.N);
    const tile = this.board[n];
    this.board[b] = tile;
    this.board[n] = 0;
    this.moves.push(dir);
    this.times.push(t - this.t0 - this.pausedTotal);
    this.emit("move", { dir, tile, from: n, to: b, source });
    if (this.goal ? this.goal(this.board) : E.isSolved(this.board)) {
      this.status = "solved";
      this.finishedAt = t;
      this.emit("solved");
    }
    return true;
  }

  // Slide every tile between `cell` and the blank (same row or column). Returns moves made.
  moveCell(cell) {
    const N = this.N;
    const b = this.blank();
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
    if (dir < 0) return 0;
    let made = 0;
    for (let i = 0; i < count; i++)
      if (this.move(dir, { source: "pointer" })) made++;
    return made;
  }

  undo() {
    if (!this.moves.length || this.status !== "running") return false;
    const dir = this.moves.pop();
    this.times.pop();
    E.applyMove(this.board, this.N, E.INV[dir]);
    this.undos++;
    this.modded = true;
    this.emit("undo");
    return true;
  }

  // a rule mod ended the run
  fail(reason) {
    if (this.status !== "running") return;
    this.status = "failed";
    this.finishedAt = performance.now();
    this.failReason = reason;
    this.emit("failed", { reason });
  }

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    this.pausedAt = performance.now();
    this.emit("pause");
  }

  resume() {
    if (this.status !== "paused") return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.status = "running";
    this.emit("resume");
  }

  togglePause() {
    if (this.status === "paused") this.resume();
    else this.pause();
  }

  // Positions from start to now (for analysis)
  positions() {
    const out = [this.start.slice()];
    const b = this.start.slice();
    for (const m of this.moves) {
      E.applyMove(b, this.N, m);
      out.push(b.slice());
    }
    return out;
  }
}

export function positionsFrom(start, N, moves) {
  const out = [start.slice()];
  const b = start.slice();
  for (const m of moves) {
    E.applyMove(b, N, m);
    out.push(b.slice());
  }
  return out;
}
