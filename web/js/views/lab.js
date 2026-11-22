import { BoardView } from "../board-view.js";
import { positionsFrom } from "../game.js";
import { barChart, legend } from "../charts.js";
import {
  rarity,
  difficultyWord,
  distributionFor,
  fmtPct,
  fmtOdds,
  fmtBig,
  mean,
} from "../stats.js";
import { h, clear, seg, toast, copyText } from "../ui.js";
import { MODS, MOD_GROUPS } from "../mods.js";

const E = window.FifteenEngine;



export class LabView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.engine = ctx.engine;
    this.N = 4;
    this.seed = E.randomSeed(8);
    this.testResult = null;
    this.batch = null;
    this.hunt = null;
    this.built = false;
  }

  show() {
    if (!this.built) {
      this.build();
      this.built = true;
      this.test();
    } else this.renderMods();
  }

  hide() {
    this.stopAnim();
  }

  onStore(e) {
    if (
      e.type === "settings" &&
      this.built &&
      MODS.some((m) => m.key === e.key)
    )
      this.renderMods();
  }

  build() {
    clear(this.root);
    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, "Lab"),
          h(
            "p",
            null,
            "Test any seed against the full table of 10.46 trillion positions, hunt for brutal scrambles, build your own boards and switch on mods.",
          ),
        ),
      ),
    );

    // seed tester
    this.seedInput = h("input", {
      type: "text",
      value: this.seed,
      maxlength: 40,
      "aria-label": "Seed",
      style: { flex: "1", minWidth: "140px" },
    });
    this.seedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.test();
    });
    this.previewEl = h("div", { class: "mini-board" });
    this.preview = new BoardView(this.previewEl, {
      small: true,
      label: "Seed preview",
    });
    this.preview.setColoring(this.store.settings.coloring);
    this.testOut = h("div", { class: "stack" });
    this.distEl = h("div");

    const tester = h(
      "section",
      { class: "panel stack" },
      h("h2", { class: "sub-title" }, "Seed tester"),
      h(
        "div",
        { class: "row" },
        this.seedInput,
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onclick: () => this.test(),
          },
          "Test seed",
        ),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              this.seedInput.value = E.randomSeed(8);
              this.test();
            },
          },
          "Random",
        ),
      ),
      seg(
        [3, 4, 5, 6, 7].map((n) => ({ value: n, label: n + "×" + n })),
        this.N,
        (n) => {
          this.N = n;
          this.test();
          this.renderBatch();
          this.renderHunt();
        },
        "Board size",
      ),
      h(
        "div",
        { class: "row", style: { alignItems: "start", gap: "24px" } },
        this.previewEl,
        this.testOut,
      ),
    );

    const distBlock = h(
      "section",
      { class: "stack" },
      h("h2", { class: "sub-title" }, "How long every position takes"),
      h(
        "p",
        { class: "hint-text" },
        "Number of positions at each optimal solution length. 4×4 counts are from Korf and Schultze's complete breadth-first search (OEIS A089484). 3×3 counts are OEIS A089473, and the app's own full search of all 181,440 positions agrees.",
      ),
      this.distEl,
    );

    this.batchEl = h("section", { class: "panel stack" });
    this.huntEl = h("section", { class: "panel stack" });
    this.customEl = h("section", { class: "panel stack" });
    this.modsEl = h("section", { class: "panel stack" });

    this.root.append(
      h("div", { class: "cols-2-1" }, tester, this.modsEl),
      h("div", { style: { height: "28px" } }),
      distBlock,
      h("div", { style: { height: "28px" } }),
      h("div", { class: "cols" }, this.batchEl, this.huntEl),
      h("div", { style: { height: "24px" } }),
      this.customEl,
    );
    this.renderBatch();
    this.renderHunt();
    this.renderCustom();
    this.renderMods();
  }

  /* ---------- seed tester ---------- */

  async test() {
    this.stopAnim();
    const seed = this.seedInput.value.trim() || E.randomSeed(8);
    this.seedInput.value = seed;
    const N = this.N;
    const board = E.scrambleFromSeed(seed, N);
    this.preview.set(board, N, { instant: true });
    const token = (this.testToken = {});
    clear(this.testOut).append(
      h(
        "p",
        { class: "hint-text" },
        N <= 4
          ? "Searching for the optimal solution…"
          : "Building a staged solution…",
      ),
    );
    this.drawDistribution(null);
    let dist, sol;
    try {
      [dist, sol] = await Promise.all([
        this.engine.run(
          "distance",
          { board, N, timeLimit: 30000 },
          { lane: "lab", replace: true },
        ),
        N > 4
          ? this.engine.run(
              "solve",
              { board, N },
              { lane: "lab-solve", replace: true },
            )
          : null,
      ]);
    } catch (e) {
      if (!e.cancelled && this.testToken === token)
        clear(this.testOut).append(
          h("p", { class: "muted" }, "The engine stopped: " + e.message),
        );
      return;
    }
    if (this.testToken !== token) return;
    const L = dist.exact ? dist.d : null;
    const moves = dist.moves || (sol && sol.moves) || null;
    this.testResult = { seed, N, board, L, moves, exact: dist.exact };
    const r = rarity(N, L);
    const word = difficultyWord(r);
    const odds = h(
      "div",
      { class: "big-odds" },
      "1 in ",
      h("span", null, fmtBig(r.positions)),
    );
    const facts = h(
      "dl",
      { class: "facts-list" },
      h("dt", null, "Optimal solution"),
      h(
        "dd",
        null,
        L != null
          ? `${L} moves`
          : N > 4
            ? `${sol.moves.length} moves (staged, not proven optimal)`
            : `at least ${dist.d} moves`,
      ),
      r.harderThan != null
        ? [
            h("dt", null, "Difficulty"),
            h(
              "dd",
              null,
              `${word[0].toUpperCase() + word.slice(1)}. Harder than ${fmtPct(r.harderThan)} of positions`,
            ),
          ]
        : null,
      r.pLength != null
        ? [
            h("dt", null, "This exact length"),
            h(
              "dd",
              null,
              `${fmtPct(r.pLength)} of random scrambles (${fmtOdds(r.pLength)})`,
            ),
          ]
        : null,
      r.pAtLeast != null
        ? [
            h("dt", null, "This long or longer"),
            h("dd", null, `${fmtPct(r.pAtLeast)} (${fmtOdds(r.pAtLeast)})`),
          ]
        : null,
      r.mean != null
        ? [
            h("dt", null, "Average scramble"),
            h("dd", null, `${r.mean.toFixed(2)} moves`),
          ]
        : null,
      h("dt", null, "Parity"),
      h(
        "dd",
        null,
        E.permutationParity(board) ? "odd permutation" : "even permutation",
      ),
    );
    clear(this.testOut).append(
      h(
        "div",
        null,
        h("div", { class: "label" }, "Chance of dealing this exact position"),
        odds,
      ),
      facts,
      h(
        "div",
        { class: "row" },
        h(
          "a",
          {
            class: "btn btn--primary",
            href: `#play/s/${N}/${encodeURIComponent(seed)}`,
          },
          "Play this seed",
        ),
        moves
          ? h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => this.animate(board, N, moves),
              },
              "Show the solution",
            )
          : null,
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onclick: () => {
              copyText(`Fifteen Press ${N}x${N} seed: ${seed}`).then((ok) =>
                toast(ok ? "Seed copied" : "Copy failed. The seed is " + seed),
              );
            },
          },
          "Copy",
        ),
      ),
      moves
        ? h("p", { class: "moves-line" }, E.formatMoves(moves, true))
        : null,
    );
    this.drawDistribution(L);
  }

  animate(board, N, moves) {
    this.stopAnim();
    const pos = positionsFrom(board, N, moves);
    let k = 0;
    const step = () => {
      this.preview.set(pos[k], N);
      if (++k < pos.length)
        this.animTimer = setTimeout(
          step,
          Math.max(40, Math.min(180, 6000 / moves.length)),
        );
      else
        this.animTimer = setTimeout(
          () => this.preview.set(board, N, { instant: true }),
          1600,
        );
    };
    step();
  }

  stopAnim() {
    clearTimeout(this.animTimer);
  }

  drawDistribution(highlight) {
    const dist = distributionFor(this.N);
    if (!dist) {
      clear(this.distEl).append(
        h(
          "p",
          { class: "muted" },
          `Nobody has counted the ${this.N}×${this.N} positions by solution length. There are ${fmtBig(window.FifteenData.factorial(this.N * this.N) / 2)} of them.`,
        ),
      );
      return;
    }
    requestAnimationFrame(() => {
      const bins = dist.counts.map((c, x) => ({ x, value: c / dist.total }));
      barChart(this.distEl, bins, {
        height: 240,
        highlightX: highlight,
        yFmt: (v) => fmtPct(v, Math.round(v * 1000) % 10 ? 1 : 0),
        xLabel: "optimal moves",
        yLabel: "share of positions",
        color: "var(--chart-b)",
        tipFor: (b) =>
          `<b>${b.x} moves</b><br>${dist.counts[b.x] ? dist.counts[b.x].toLocaleString() : 0} positions<br>${fmtPct(b.value)}`,
      });
      if (highlight != null)
        legend(this.distEl, [
          { name: "All positions", color: "var(--chart-b)", dot: true },
          { name: "This seed", color: "var(--spot)", dot: true },
        ]);
    });
  }

  /* ---------- batch ---------- */

  renderBatch() {
    const el = clear(this.batchEl);
    const N = this.N;
    this.batchChart = h("div");
    this.batchStatus = h(
      "p",
      { class: "hint-text" },
      N <= 4
        ? `Solve a batch of random ${N}×${N} seeds optimally and compare the spread to the true distribution.`
        : "Batch testing needs exact solutions, so it runs on 3×3 and 4×4 only.",
    );
    this.batchBar = h("i");
    el.append(
      h("h2", { class: "sub-title" }, "Batch test"),
      this.batchStatus,
      N <= 4
        ? h(
            "div",
            { class: "row" },
            ...[10, 25, 100].map((n) =>
              h(
                "button",
                {
                  class: "btn" + (n === 25 ? " btn--primary" : ""),
                  type: "button",
                  onclick: () => this.runBatch(n),
                },
                n + " seeds",
              ),
            ),
            h(
              "button",
              {
                class: "btn btn--ghost",
                type: "button",
                onclick: () => this.stopBatch(),
              },
              "Stop",
            ),
          )
        : null,
      h("div", { class: "progress" }, this.batchBar),
      this.batchChart,
    );
  }

  async runBatch(count) {
    this.stopBatch();
    const N = this.N;
    const lanes = Math.max(
      1,
      Math.min(4, (navigator.hardwareConcurrency || 4) - 1),
    );
    const seeds = Array.from({ length: count }, () => E.randomSeed(8));
    const results = [];
    const run = (this.batch = { stopped: false });
    const t0 = performance.now();
    const chunks = Array.from({ length: lanes }, (_, i) =>
      seeds.filter((_, j) => j % lanes === i),
    );
    const update = () => {
      this.batchBar.style.transform = `scaleX(${results.length / count})`;
      const lens = results.map((r) => r.d);
      this.batchStatus.textContent =
        `${results.length} of ${count} solved` +
        (lens.length
          ? `. Mean ${mean(lens).toFixed(2)} moves, shortest ${Math.min(...lens)}, longest ${Math.max(...lens)}.`
          : "");
    };
    await Promise.all(
      chunks.map(
        (chunk, i) =>
          chunk.length &&
          this.engine
            .run(
              "batch",
              { seeds: chunk, N, timeLimit: 60000 },
              {
                lane: "batch" + i,
                replace: true,
                onProgress: (p) => {
                  if (run.stopped) return;
                  results.push(p.item);
                  update();
                },
              },
            )
            .catch(() => null),
      ),
    );
    if (run.stopped) return;
    const lens = results.map((r) => r.d);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const hardest = results.slice().sort((a, b) => b.d - a.d)[0];
    const theory = rarity(N, 0).mean;
    this.batchStatus.replaceChildren(
      `${results.length} seeds in ${secs}s. Mean ${mean(lens).toFixed(2)} moves against ${theory.toFixed(2)} in theory. Hardest: `,
      h(
        "button",
        {
          class: "btn btn--small",
          type: "button",
          onclick: () => {
            this.seedInput.value = hardest.seed;
            this.test();
            document.getElementById("main").scrollTo({ top: 0, behavior: "smooth" });
          },
        },
        `${hardest.seed} (${hardest.d})`,
      ),
    );
    const dist = distributionFor(N);
    const counts = new Map();
    for (const l of lens) counts.set(l, (counts.get(l) || 0) + 1);
    const lo = Math.max(0, Math.min(...lens) - 4),
      hi = Math.max(...lens) + 4;
    const bins = [];
    const overlay = [];
    for (let x = lo; x <= hi; x++) {
      bins.push({ x, value: counts.get(x) || 0 });
      overlay.push({
        x,
        y: ((dist.counts[x] || 0) / dist.total) * results.length,
      });
    }
    barChart(this.batchChart, bins, {
      height: 200,
      overlay,
      xMin: lo,
      xMax: hi,
      xLabel: "optimal moves",
      yLabel: "seeds",
      tipFor: (b) =>
        `<b>${b.x} moves</b><br>${b.value} of your seeds<br>${(((dist.counts[b.x] || 0) / dist.total) * results.length).toFixed(1)} expected`,
    });
    legend(this.batchChart, [
      { name: "Your batch", color: "var(--chart-a)", dot: true },
      { name: "Expected from the full table", color: "var(--chart-b)" },
    ]);
  }

  stopBatch() {
    if (this.batch) this.batch.stopped = true;
    for (let i = 0; i < 4; i++) this.engine.cancel("batch" + i);
  }

  /* ---------- hunt ---------- */

  renderHunt() {
    const el = clear(this.huntEl);
    const N = this.N;
    const dist = distributionFor(N);
    el.append(h("h2", { class: "sub-title" }, "Hard seed hunt"));
    if (!dist) {
      el.append(
        h(
          "p",
          { class: "hint-text" },
          "Hunting needs exact solutions, so it runs on 3×3 and 4×4 only.",
        ),
      );
      return;
    }
    const targets = N === 4 ? [58, 62, 64, 66] : [24, 26, 28, 30];
    this.huntTarget =
      this.huntTarget && targets.includes(this.huntTarget)
        ? this.huntTarget
        : targets[1];
    this.huntStatus = h("p", { class: "hint-text" });
    const odds = () => {
      const r = rarity(N, this.huntTarget);
      this.huntStatus.textContent = `${fmtPct(r.pAtLeast)} of scrambles need ${this.huntTarget} moves or more. Expect about ${Math.round(1 / r.pAtLeast).toLocaleString()} tries.`;
    };
    odds();
    this.huntOut = h("div", { class: "stack", style: { "--gap": "6px" } });
    el.append(
      h(
        "p",
        { class: "hint-text" },
        "Deal random seeds until one needs at least this many moves.",
      ),
      seg(
        targets.map((t) => ({ value: t, label: t + "+" })),
        this.huntTarget,
        (v) => {
          this.huntTarget = v;
          odds();
        },
        "Target length",
      ),
      this.huntStatus,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onclick: () => this.runHunt(),
          },
          "Start hunting",
        ),
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onclick: () => this.stopHunt(),
          },
          "Stop",
        ),
      ),
      this.huntOut,
    );
  }

  async runHunt() {
    this.stopHunt();
    const N = this.N,
      target = this.huntTarget;
    const hunt = (this.hunt = { stopped: false, tries: 0 });
    const lanes = Math.max(
      1,
      Math.min(4, (navigator.hardwareConcurrency || 4) - 1),
    );
    const t0 = performance.now();
    const line = h("p", { class: "hint-text" }, "Dealing…");
    clear(this.huntOut).append(line);
    const lane = async (i) => {
      while (!hunt.stopped) {
        const seeds = Array.from({ length: 6 }, () => E.randomSeed(8));
        let res;
        try {
          res = await this.engine.run(
            "batch",
            { seeds, N, timeLimit: 60000 },
            { lane: "hunt" + i, replace: false },
          );
        } catch (e) {
          return;
        }
        if (hunt.stopped) return;
        hunt.tries += res.length;
        const found = res
          .filter((r) => r.exact && r.d >= target)
          .sort((a, b) => b.d - a.d)[0];
        line.textContent = `${hunt.tries} seeds dealt in ${((performance.now() - t0) / 1000).toFixed(0)}s`;
        if (found) {
          hunt.stopped = true;
          for (let j = 0; j < 4; j++)
            if (j !== i) this.engine.cancel("hunt" + j);
          const r = rarity(N, found.d);
          this.huntOut.append(
            h(
              "div",
              { class: "row" },
              h("strong", null, `${found.seed} needs ${found.d} moves.`),
              h(
                "span",
                { class: "muted" },
                `Harder than ${fmtPct(r.harderThan)} of all positions.`,
              ),
              h(
                "a",
                {
                  class: "btn btn--primary btn--small",
                  href: `#play/s/${N}/${found.seed}`,
                },
                "Play it",
              ),
              h(
                "button",
                {
                  class: "btn btn--small",
                  type: "button",
                  onclick: () => {
                    this.seedInput.value = found.seed;
                    this.test();
                    document.getElementById("main").scrollTo({ top: 0, behavior: "smooth" });
                  },
                },
                "Test it",
              ),
            ),
          );
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
  }

  stopHunt() {
    if (this.hunt) this.hunt.stopped = true;
    for (let i = 0; i < 4; i++) this.engine.cancel("hunt" + i);
  }

  /* ---------- custom board ---------- */

  renderCustom() {
    const el = clear(this.customEl);
    const N = this.customN || 4;
    const inputs = [];
    const grid = h("div", {
      class: "custom-grid",
      style: {
        gridTemplateColumns: `repeat(${N}, 1fr)`,
        maxWidth: N * 62 + "px",
      },
    });
    const start =
      this.customBoard && this.customBoard.length === N * N
        ? this.customBoard
        : E.solvedBoard(N);
    for (let i = 0; i < N * N; i++) {
      const inp = h("input", {
        type: "text",
        inputmode: "numeric",
        value: start[i] || "",
        "aria-label": `Row ${Math.floor(i / N) + 1} column ${(i % N) + 1}`,
        maxlength: 3,
      });
      inputs.push(inp);
      grid.appendChild(inp);
    }
    const out = h("div", { class: "stack", style: { "--gap": "10px" } });
    const read = () => inputs.map((i) => parseInt(i.value, 10) || 0);
    const check = () => {
      const b = read();
      this.customBoard = b;
      const seen = new Set(b);
      if (seen.size !== N * N || b.some((v) => v < 0 || v >= N * N)) {
        out.replaceChildren(
          h(
            "p",
            { class: "muted" },
            `Use each number from 1 to ${N * N - 1} once, and leave one cell empty for the gap.`,
          ),
        );
        return null;
      }
      if (!E.isSolvable(b, N)) {
        out.replaceChildren(
          h(
            "p",
            null,
            h("strong", { class: "spot" }, "Unsolvable. "),
            "This board has the wrong parity, like Sam Loyd's famous 14-15 swap. Swap any two numbers to fix it.",
          ),
        );
        return null;
      }
      return b;
    };
    const solve = async () => {
      const b = check();
      if (!b) return;
      out.replaceChildren(h("p", { class: "hint-text" }, "Solving…"));
      try {
        const res = await this.engine.run(
          "solve",
          { board: b, N, timeLimit: 20000 },
          { lane: "custom", replace: true },
        );
        out.replaceChildren(
          h(
            "p",
            null,
            h(
              "strong",
              null,
              res.optimal
                ? `Optimal: ${res.moves.length} moves.`
                : `Solved in ${res.moves.length} moves (staged).`,
            ),
          ),
          h(
            "p",
            { class: "moves-line" },
            res.moves.length
              ? E.formatMoves(res.moves, true)
              : "Already solved.",
          ),
        );
      } catch (e) {
        if (!e.cancelled)
          out.replaceChildren(
            h("p", { class: "muted" }, "The engine stopped: " + e.message),
          );
      }
    };
    el.append(
      h("h2", { class: "sub-title" }, "Build a board"),
      h(
        "p",
        { class: "hint-text" },
        "Type a position from a real puzzle or a friend's challenge. Leave one cell empty for the gap.",
      ),
      seg(
        [3, 4, 5].map((n) => ({ value: n, label: n + "×" + n })),
        N,
        (n) => {
          this.customN = n;
          this.customBoard = null;
          this.renderCustom();
        },
        "Custom board size",
      ),
      grid,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onclick: () => {
              const b = check();
              if (b) this.ctx.app.go("play", `b/${N}/${b.join(",")}`);
            },
          },
          "Play it",
        ),
        h(
          "button",
          { class: "btn", type: "button", onclick: solve },
          "Solve it",
        ),
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onclick: () => {
              this.customBoard = E.scrambleFromSeed(E.randomSeed(6), N);
              this.renderCustom();
            },
          },
          "Fill randomly",
        ),
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onclick: () => {
              const b = E.solvedBoard(N);
              [b[N * N - 3], b[N * N - 2]] = [b[N * N - 2], b[N * N - 3]];
              this.customBoard = b;
              this.renderCustom();
              check();
            },
          },
          "Load the 14-15 swap",
        ),
      ),
      out,
    );
  }

  /* ---------- mods ---------- */

  renderMods() {
    const el = clear(this.modsEl);
    const s = this.store.settings;
    el.append(
      h("h2", { class: "sub-title" }, "Mods"),
      h(
        "p",
        { class: "hint-text" },
        "Solves played with a mod on are tagged and kept off the leaderboards.",
      ),
      ...MOD_GROUPS.map((grp) =>
        h(
          "div",
          { class: "mod-group" },
          h("h3", { class: "sub-title sub-title--small" }, grp.name),
          h(
            "div",
            { class: "mod-list" },
            ...grp.mods.map((m) => {
              const cb = h("input", { type: "checkbox", checked: !!s[m.key] });
              cb.addEventListener("change", () =>
                this.store.set(m.key, cb.checked),
              );
              return h(
                "label",
                null,
                cb,
                h("strong", null, m.name),
                h("span", null, m.text),
              );
            }),
          ),
        ),
      ),
    );
  }
}
