// Renders a board as a chase of type blocks. Used for the main game, previews and replays.
import { tileInk } from "./themes.js";
import { motion, replay } from "./motion.js";

export class BoardView {
  constructor(
    container,
    {
      interactive = false,
      onCell = null,
      onHover = null,
      small = false,
      label = "Puzzle board",
    } = {},
  ) {
    this.root = document.createElement("div");
    this.root.className = "chase" + (small ? " chase--small" : "");
    this.bed = document.createElement("div");
    this.bed.className = "bed";
    this.bed.setAttribute("role", "grid");
    this.bed.setAttribute("aria-label", label);
    this.root.appendChild(this.bed);
    container.appendChild(this.root);
    this.N = 0;
    this.tiles = new Map(); // tile number -> element
    this.board = null;
    this.coloring = "single";
    this.interactive = interactive;
    this.onCell = onCell;
    this.onHover = onHover;
    this.fast = false; // speedrun: touch only the tiles that moved
    this.guide = null;
    if (interactive) {
      this.bed.addEventListener("pointerdown", (e) => {
        const cell = this.cellFromEvent(e);
        if (cell != null && this.onCell) {
          e.preventDefault();
          this.onCell(cell, e);
        }
      });
      this.bed.addEventListener("pointerover", (e) => {
        if (!this.onHover || e.pointerType !== "mouse") return;
        const cell = this.cellFromEvent(e);
        if (cell != null) this.onHover(cell, e);
      });
    }
  }

  cellFromEvent(e) {
    const el = e.target.closest(".tile");
    if (!el || !this.board) return null;
    const t = Number(el.dataset.t);
    return this.board.indexOf(t);
  }

  setColoring(c) {
    this.coloring = c;
    this.root.dataset.coloring = c;
    if (this.board) this.paint();
  }

  build(N) {
    this.N = N;
    this.bed.innerHTML = "";
    this.guide = null;
    this.tiles.clear();
    this.bed.style.setProperty("--n", N);
    this.root.dataset.n = N;
    for (let t = 1; t < N * N; t++) {
      const el = document.createElement("div");
      el.className = "tile";
      el.dataset.t = t;
      el.setAttribute("role", "gridcell");
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = t;
      num.dataset.n = t;
      el.appendChild(num);
      this.bed.appendChild(el);
      this.tiles.set(t, el);
    }
    this.hole = document.createElement("div");
    this.hole.className = "hole";
    this.hole.setAttribute("aria-hidden", "true");
    this.bed.appendChild(this.hole);
  }

  set(board, N, { instant = false } = {}) {
    if (N !== this.N) {
      this.build(N);
      instant = true;
    }
    const prev = this.board;
    if (instant) this.root.classList.add("no-anim");
    this.board = board.slice();
    if (this.fast && !instant && prev && prev.length === board.length) {
      this.paintMoved(prev);
      return;
    }
    if (!instant && prev && prev.length === board.length) this.animateMoved(prev);
    this.paint();
    if (instant) {
      void this.root.offsetWidth;
      this.root.classList.remove("no-anim");
    }
  }

  // Per-move effects: stagger inside a multi-tile slide, the landing effect, and the
  // styles that jump instead of travelling.
  animateMoved(prev) {
    if (motion.reduced) return;
    const now = performance.now();
    // several single moves in the same instant are one row slide
    this.burst = now - (this.burstAt || 0) < 8 ? (this.burst || 0) + 1 : 0;
    this.burstAt = now;
    const delay = motion.stagger && motion.ms ? this.burst * motion.stagger : 0;
    for (let cell = 0; cell < this.board.length; cell++) {
      const t = this.board[cell];
      if (!t || prev[cell] === t) continue;
      const el = this.tiles.get(t);
      if (!el) continue;
      el.style.setProperty("--slide-delay", delay + "ms");
      if (motion.jump) replay(el, "mv");
      if (motion.land !== "none") replay(el, "land");
    }
  }

  // A fresh scramble arriving on the bed.
  enter() {
    if (motion.scramble === "none" || motion.reduced || !this.board) return;
    const N = this.N;
    for (let cell = 0; cell < this.board.length; cell++) {
      const t = this.board[cell];
      if (!t) continue;
      const el = this.tiles.get(t);
      const r = Math.floor(cell / N),
        c = cell % N;
      const order =
        motion.scramble === "scatter" ? Math.random() * N * 1.6 : motion.scramble === "drop" ? c + (N - 1 - r) * 0.6 : r + c;
      el.style.setProperty("--enter-delay", Math.round(order * (150 / N)) + "ms");
      el.style.setProperty("--enter-turn", (Math.random() * 40 - 20).toFixed(1) + "deg");
      replay(el, "enter");
    }
  }

  paint() {
    const N = this.N;
    for (let cell = 0; cell < this.board.length; cell++) {
      const t = this.board[cell];
      if (!t) {
        this.hole.style.setProperty("--r", Math.floor(cell / N));
        this.hole.style.setProperty("--c", cell % N);
        continue;
      }
      const el = this.tiles.get(t);
      el.style.setProperty("--r", Math.floor(cell / N));
      el.style.setProperty("--c", cell % N);
      const { ink, face } = tileInk(this.coloring, t, cell, N);
      el.style.setProperty("--tile-ink", ink);
      if (face) el.style.setProperty("--tile-face", face);
      else el.style.removeProperty("--tile-face");
      el.classList.toggle("is-home", cell === t - 1);
      const g = t - 1;
      const dist =
        Math.abs(Math.floor(g / N) - Math.floor(cell / N)) +
        Math.abs((g % N) - (cell % N));
      el.firstChild.dataset.dist = dist;
      const bl = this.board.indexOf(0);
      el.classList.toggle(
        "is-near",
        Math.abs(Math.floor(bl / N) - Math.floor(cell / N)) +
          Math.abs((bl % N) - (cell % N)) ===
          1,
      );
      el.setAttribute(
        "aria-label",
        `${t}, row ${Math.floor(cell / N) + 1} column ${(cell % N) + 1}`,
      );
    }
  }

  // Speedrun paint: a move changes two cells, so only those are written.
  paintMoved(prev) {
    const N = this.N;
    for (let cell = 0; cell < this.board.length; cell++) {
      const t = this.board[cell];
      if (prev[cell] === t) continue;
      const r = Math.floor(cell / N),
        c = cell % N;
      if (!t) {
        this.hole.style.setProperty("--r", r);
        this.hole.style.setProperty("--c", c);
        continue;
      }
      const el = this.tiles.get(t);
      el.style.setProperty("--r", r);
      el.style.setProperty("--c", c);
      const { ink, face } = tileInk(this.coloring, t, cell, N);
      el.style.setProperty("--tile-ink", ink);
      if (face) el.style.setProperty("--tile-face", face);
      else el.style.removeProperty("--tile-face");
      el.classList.toggle("is-home", cell === t - 1);
    }
  }

  // Coach overlay: the tiles being placed, where they belong, the route to take and the next
  // tile to slide. g = { routes:[{cells, kind}], homes:[cell], targets:[tile], next:{tile} } or null.
  setGuide(g, { bad = false } = {}) {
    for (const el of this.tiles.values()) el.classList.remove("is-target", "is-hint");
    if (!g) {
      if (this.guide) this.guide.replaceChildren();
      return;
    }
    const N = this.N;
    const NS = "http://www.w3.org/2000/svg";
    if (!this.guide) {
      this.guide = document.createElementNS(NS, "svg");
      this.guide.setAttribute("class", "guide");
      this.guide.setAttribute("aria-hidden", "true");
      this.bed.appendChild(this.guide);
    }
    this.guide.setAttribute("viewBox", `0 0 ${N} ${N}`);
    this.guide.classList.toggle("is-bad", !!bad);
    const parts = [];
    const mk = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      parts.push(el);
    };
    const x = (cell) => (cell % N) + 0.5,
      y = (cell) => Math.floor(cell / N) + 0.5;
    for (const cell of g.homes || [])
      mk("rect", { class: "guide-home", x: (cell % N) + 0.1, y: Math.floor(cell / N) + 0.1, width: 0.8, height: 0.8 });
    for (const r of g.routes || []) {
      if (!r.cells || r.cells.length < 2) continue;
      // a pale line underneath keeps the route readable on any tile colour
      mk("polyline", { class: "guide-halo", points: r.cells.map((c) => x(c) + "," + y(c)).join(" ") });
      mk("polyline", {
        class: "guide-route guide-route--" + r.kind,
        points: r.cells.map((c) => x(c) + "," + y(c)).join(" "),
      });
      const a = r.cells[r.cells.length - 2],
        b = r.cells[r.cells.length - 1];
      const dx = x(b) - x(a),
        dy = y(b) - y(a);
      const s = 0.17;
      // arrow head pointing along the last leg
      mk("polygon", {
        class: "guide-head guide-head--" + r.kind,
        points: [
          [x(b) + dx * s, y(b) + dy * s],
          [x(b) - dx * s - dy * s, y(b) - dy * s + dx * s],
          [x(b) - dx * s + dy * s, y(b) - dy * s - dx * s],
        ]
          .map((p) => p[0].toFixed(3) + "," + p[1].toFixed(3))
          .join(" "),
      });
      mk("circle", { class: "guide-dot guide-dot--" + r.kind, cx: x(r.cells[0]), cy: y(r.cells[0]), r: 0.07 });
    }
    this.guide.replaceChildren(...parts);
    for (const t of g.targets || []) this.tiles.get(t)?.classList.add("is-target");
    if (g.next) this.tiles.get(g.next.tile)?.classList.add("is-hint");
  }

  // The solve's signature moment. Which one plays is a setting (see motion.js).
  inkWave() {
    this.root.classList.add("is-proofed");
    for (const el of this.tiles.values()) el.classList.remove("land", "mv", "enter");
    if (motion.reduced || motion.solve === "none") return;
    const N = this.N;
    for (const [t, el] of this.tiles) {
      const r = Math.floor((t - 1) / N),
        c = (t - 1) % N;
      const delay =
        motion.solve === "sweep"
          ? (r + c) * (260 / N)
          : motion.solve === "burst"
            ? 0
            : motion.solve === "rise"
              ? (N - 1 - r) * (240 / N) + c * 12
              : (t - 1) * Math.min(28, 420 / (N * N));
      el.style.setProperty("--wave-delay", Math.round(delay) + "ms");
      replay(el, "wave");
    }
  }

  clearProofed() {
    this.root.classList.remove("is-proofed");
    for (const el of this.tiles.values()) el.classList.remove("wave", "land", "mv");
  }

  markHint(tile) {
    for (const el of this.tiles.values()) el.classList.remove("is-hint");
    if (tile) this.tiles.get(tile)?.classList.add("is-hint");
  }

  markCells(classes) {
    // classes: Map tile -> className, for replay highlighting
    for (const [t, el] of this.tiles) {
      el.classList.remove("mark-good", "mark-bad");
      const c = classes && classes.get(t);
      if (c) el.classList.add(c);
    }
  }

  // display mods: { className: on }
  setMods(classes) {
    for (const [c, on] of Object.entries(classes))
      this.root.classList.toggle(c, !!on);
  }

  setRunning(on) {
    this.root.classList.toggle("is-running", !!on);
  }

  setHeat(on) {
    this.root.classList.toggle("show-heat", !!on);
    if (!on || !this.board) return;
    const N = this.N;
    for (let cell = 0; cell < this.board.length; cell++) {
      const t = this.board[cell];
      if (!t) continue;
      const g = t - 1;
      const d =
        Math.abs(Math.floor(g / N) - Math.floor(cell / N)) +
        Math.abs((g % N) - (cell % N));
      this.tiles.get(t).style.setProperty("--heat", Math.min(1, d / (N + 1)));
      this.tiles.get(t).dataset.dist = d;
    }
  }

  setHidden(hidden) {
    this.root.classList.toggle("is-covered", hidden);
  }

  destroy() {
    this.root.remove();
  }
}
