import { BoardView } from "../board-view.js";
import { colourWords, cap } from "../themes.js";
import { positionsFrom } from "../game.js";
import { decodeMoves, decodeTimes } from "../store.js";
import { analyze } from "../analysis.js";
import { readMethod, coach, coachPanel } from "../method.js";
import { gradeMistakes, mistakeCards, summaryLine, GRADES } from "../mistakes.js";
import { lineChart, barChart, legend } from "../charts.js";
import { fmtTime, fmtPct, rarity, difficultyWord } from "../stats.js";
import {
  h,
  clear,
  seg,
  toast,
  copyText,
  downloadFile,
  relDate,
  confirmAction,
} from "../ui.js";

const E = window.FifteenEngine;
const TILE_WORD = ["down", "up", "right", "left"]; // tile direction for each blank direction

// report sections that start shut
const FOLDED = ["every move", "your method", "learn from your mistakes", "pause before each move", "the engine's line"];

export class ProofsView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.engine = ctx.engine;
    this.selected = null;
    this.sizeFilter = "all";
    this.replay = null;
  }

  show(param) {
    if (param) this.selected = param;
    this.render();
  }

  hide() {
    this.stopPlayback();
  }

  onStore(e) {
    if (this.root.hidden) return;
    if (e.type === "solves" || e.type === "profile" || e.type === "all")
      this.render();
  }

  solves() {
    const all = this.store.solves({
      profileId: this.store.state.activeProfile,
    });
    return (
      this.sizeFilter === "all"
        ? all
        : all.filter((s) => s.N === this.sizeFilter)
    )
      .slice()
      .reverse();
  }

  render() {
    this.stopPlayback();
    const list = this.solves();
    clear(this.root);
    if (
      !this.store.solves({ profileId: this.store.state.activeProfile }).length
    ) {
      this.root.append(
        h(
          "div",
          { class: "page-head" },
          h(
            "div",
            null,
            h("h1", { class: "section-title" }, "Proofs"),
            h(
              "p",
              null,
              "Every solve you finish gets a proof: a replay, a move-by-move grade against the optimal engine, and where the time went.",
            ),
          ),
        ),
        h(
          "div",
          { class: "empty panel" },
          h("strong", null, "No proofs yet"),
          "Finish a scramble on the Play tab and it shows up here.",
          h(
            "div",
            { style: { marginTop: "16px" } },
            h("a", { class: "btn btn--primary", href: "#play" }, "Go play"),
          ),
        ),
      );
      return;
    }
    if (!this.selected || !this.store.getSolve(this.selected))
      this.selected = list[0] && list[0].id;
    const sizes = [
      ...new Set(
        this.store
          .solves({ profileId: this.store.state.activeProfile })
          .map((s) => s.N),
      ),
    ].sort();
    const listEl = h(
      "nav",
      { class: "proof-list", "aria-label": "Solves" },
      sizes.length > 1
        ? h(
            "div",
            { style: { marginBottom: "10px" } },
            seg(
              [
                { value: "all", label: "All" },
                ...sizes.map((n) => ({ value: n, label: n + "×" + n })),
              ],
              this.sizeFilter,
              (v) => {
                this.sizeFilter = v;
                this.render();
              },
              "Filter by size",
            ),
          )
        : null,
      ...list.map((s) =>
        h(
          "button",
          {
            type: "button",
            "aria-current": String(s.id === this.selected),
            onclick: () => {
              this.selected = s.id;
              history.replaceState(null, "", "#proofs/" + s.id);
              this.render();
            },
          },
          h("span", { class: "t" }, fmtTime(s.duration)),
          h("span", { class: "m" }, s.moveCount + " moves"),
          h(
            "span",
            { class: "meta" },
            `${s.N}×${s.N}  ${relDate(s.date)}${s.assisted ? "  hinted" : ""}${s.modded ? "  modded" : ""}${s.mode === "daily" ? "  daily" : ""}`,
          ),
        ),
      ),
    );
    this.sheet = h("article", { class: "proof-sheet" });
    this.root.append(h("div", { class: "proofs" }, listEl, this.sheet));
    const solve = this.store.getSolve(this.selected);
    if (solve) this.renderSheet(solve);
  }

  renderSheet(solve) {
    const moves = decodeMoves(solve.moves);
    const times = decodeTimes(solve.times);
    const full = { ...solve, movesArr: moves, timesArr: times };
    const stored = solve.dist
      ? {
          d: solve.dist.split(",").map((x) => (x === "" ? null : Number(x))),
          exact: solve.distExact
            ? null
            : (solve.distMask || "").split("").map((c) => c === "1"),
          estimate: !!solve.distEstimate,
        }
      : null;
    if (stored && !stored.exact) stored.exact = stored.d.map(() => true);
    this.renderReport(full, stored);
    if (!stored) this.runAnalysis(full);
  }

  async runAnalysis(solve) {
    const positions = positionsFrom(solve.start, solve.N, solve.movesArr);
    const bar = h("i");
    const status = h(
      "p",
      { class: "hint-text" },
      "Grading every position against the optimal engine…",
    );
    const box = h(
      "div",
      { class: "stack", style: { "--gap": "8px" } },
      status,
      h("div", { class: "progress" }, bar),
    );
    this.progressSlot.replaceChildren(box);
    try {
      const res = await this.engine.run(
        "analyze",
        { boards: positions, N: solve.N },
        {
          lane: "analysis",
          replace: true,
          onProgress: (p) => {
            bar.style.transform = `scaleX(${p.done / p.total})`;
            status.textContent = `Grading position ${p.done} of ${p.total}`;
          },
        },
      );
      if (this.selected !== solve.id) return;
      const allExact = res.exact.every(Boolean);
      const patch = {
        dist: res.d.map((x) => (x == null ? "" : x)).join(","),
        distExact: allExact,
        distMask: allExact
          ? null
          : res.exact.map((x) => (x ? "1" : "0")).join(""),
        distEstimate: !!res.estimate,
      };
      if (!res.estimate && res.exact[0] && solve.optimal == null) {
        patch.optimal = res.d[0];
        patch.optimalExact = true;
      }
      this.store.updateSolve(solve.id, patch);
      this.renderSheet(this.store.getSolve(solve.id));
    } catch (e) {
      if (e.cancelled) return;
      status.textContent = "Analysis stopped: " + e.message;
    }
  }

  renderReport(solve, dist) {
    const r = analyze(solve, dist);
    const N = solve.N;
    const sheet = clear(this.sheet);
    const eff = r.efficiency;
    const rar = r.optimal != null ? rarity(N, r.optimal) : null;
    const flags = [];
    if (solve.mode === "daily")
      flags.push(h("span", { class: "tag tag--spot" }, "Daily " + solve.daily));
    if (solve.seed && solve.mode !== "daily")
      flags.push(h("span", { class: "tag" }, "Seed " + solve.seed));
    if (solve.assisted)
      flags.push(
        h(
          "span",
          { class: "tag" },
          solve.hints + " hint" + (solve.hints === 1 ? "" : "s"),
        ),
      );
    if (solve.modded) flags.push(h("span", { class: "tag" }, "Modded"));

    sheet.append(
      h(
        "header",
        {
          class: "row",
          style: { justifyContent: "space-between", alignItems: "end" },
        },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, `${N}×${N} solve`),
          h(
            "p",
            { class: "muted", style: { marginTop: "6px" } },
            new Date(solve.date).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          ),
        ),
        h("div", { class: "flags" }, ...flags),
      ),
      h(
        "div",
        { class: "specimen" },
        fig("Time", fmtTime(solve.duration)),
        fig("Moves", r.M),
        fig(
          "Optimal",
          r.optimal != null ? r.optimal : N > 4 ? "n/a" : "…",
          rar && rar.harderThan != null
            ? `harder than ${fmtPct(rar.harderThan, 0)} of scrambles`
            : null,
        ),
        fig(
          "Efficiency",
          eff != null ? Math.round(eff * 100) + "%" : "-",
          eff != null ? `${r.M - r.optimal} moves over` : null,
        ),
        fig("Tiles/sec", r.tps != null ? r.tps.toFixed(2) : "-"),
        fig(
          "Wrong-way moves",
          dist && !r.estimate ? r.bad : "-",
          dist && !r.estimate ? `${r.good} moved closer` : null,
        ),
      ),
    );
    this.progressSlot = h("div");
    sheet.append(this.progressSlot);

    // replay + ribbon
    const replayBoard = h("div", {
      class: "mini-board",
      style: { width: "100%" },
    });
    const bv = new BoardView(replayBoard, {
      small: true,
      label: "Replay board",
    });
    bv.setColoring(this.store.settings.coloring);
    const slider = h("input", {
      type: "range",
      min: 0,
      max: r.M,
      value: r.M,
      step: 1,
      "aria-label": "Replay position",
    });
    const caption = h("p", { class: "hint-text" });
    const strip = h("div", { class: "move-strip", "aria-label": "Moves" });
    const stripButtons = solve.movesArr.map((m, i) => {
      const b = h(
        "button",
        {
          type: "button",
          class: r.verdict[i],
          title: `Move ${i + 1}: ${E.TILE_CHARS[m]}${r.verdict[i] === "bad" ? " (away from the goal)" : r.verdict[i] === "good" ? " (closer)" : ""}`,
        },
        E.TILE_CHARS[m],
      );
      b.addEventListener("click", () => setIndex(i + 1));
      strip.appendChild(b);
      return b;
    });
    // Lichess-style tags on the move strip
    const grades = gradeMistakes(r, solve);
    if (grades)
      for (const e of grades.episodes) {
        const b = stripButtons[e.at];
        b.dataset.sym = GRADES[e.grade].sym;
        b.classList.add("is-" + e.grade);
        b.title = `${GRADES[e.grade].name}: ${b.title}`;
      }
    const playBtn = h(
      "button",
      { class: "btn btn--small", type: "button" },
      "Play",
    );
    let speed = 1;
    let ribbon = null;
    const setIndex = (k) => {
      k = Math.max(0, Math.min(r.M, k));
      slider.value = k;
      bv.set(r.positions[k], N, {
        instant: !this.replay || !this.replay.playing,
      });
      const marks = new Map();
      if (k > 0) {
        const m = solve.movesArr[k - 1];
        const blankAfter = r.positions[k].indexOf(0);
        const movedCell = E.neighbor(blankAfter, E.INV[m], N);
        const tile = r.positions[k][movedCell];
        if (r.verdict[k - 1] === "good") marks.set(tile, "mark-good");
        if (r.verdict[k - 1] === "bad") marks.set(tile, "mark-bad");
      }
      bv.markCells(marks);
      stripButtons.forEach((b, i) =>
        b.setAttribute("aria-current", String(i === k - 1)),
      );
      const t = k === 0 ? 0 : solve.timesArr[k - 1];
      const dd =
        r.d && r.d[k] != null
          ? ` · ${r.estimate ? "estimated " : ""}${r.d[k]} from solved`
          : "";
      caption.textContent =
        k === 0
          ? "Start position" + dd
          : `Move ${k} of ${r.M} at ${fmtTime(t)}s${dd}`;
      if (ribbon) ribbon.setCursor(k);
      this.replay.k = k;
    };
    this.replay = { k: r.M, playing: false, timer: 0 };
    const play = () => {
      if (this.replay.playing) {
        this.stopPlayback();
        playBtn.textContent = "Play";
        return;
      }
      if (this.replay.k >= r.M) setIndex(0);
      this.replay.playing = true;
      playBtn.textContent = "Pause";
      const step = () => {
        if (!this.replay.playing) return;
        const k = this.replay.k;
        if (k >= r.M) {
          this.stopPlayback();
          playBtn.textContent = "Play";
          return;
        }
        setIndex(k + 1);
        const real =
          k + 1 < r.M ? solve.timesArr[k + 1] - solve.timesArr[k] : 200;
        const wait =
          speed === 0 ? 120 : Math.max(16, Math.min(1500, real / speed));
        this.replay.timer = setTimeout(step, wait);
      };
      step();
    };
    playBtn.addEventListener("click", play);
    slider.addEventListener("input", () => {
      this.stopPlayback();
      playBtn.textContent = "Play";
      setIndex(Number(slider.value));
    });

    const chartEl = h("div");
    const ribbonBlock = h(
      "div",
      { class: "stack" },
      h(
        "h2",
        { class: "sub-title" },
        r.estimate ? "Distance to solved (estimate)" : "Distance to solved",
      ),
      h(
        "p",
        { class: "hint-text" },
        r.estimate
          ? "Boards larger than 4×4 are too big to grade exactly, so this uses Manhattan distance plus linear conflicts."
          : `Each point is the exact number of moves the engine would still need. A perfect solve runs straight down the ${colourWords().good} line.`,
      ),
      chartEl,
    );

    sheet.append(
      h(
        "section",
        { class: "replay" },
        h(
          "div",
          null,
          replayBoard,
          h(
            "div",
            { class: "replay-controls" },
            slider,
            h(
              "div",
              { class: "row row--tight" },
              h(
                "button",
                {
                  class: "btn btn--small",
                  type: "button",
                  onclick: () => {
                    this.stopPlayback();
                    playBtn.textContent = "Play";
                    setIndex(this.replay.k - 1);
                  },
                  "aria-label": "Previous move",
                },
                "Back",
              ),
              playBtn,
              h(
                "button",
                {
                  class: "btn btn--small",
                  type: "button",
                  onclick: () => {
                    this.stopPlayback();
                    playBtn.textContent = "Play";
                    setIndex(this.replay.k + 1);
                  },
                  "aria-label": "Next move",
                },
                "Step",
              ),
              seg(
                [
                  { value: 0.5, label: "½×" },
                  { value: 1, label: "1×" },
                  { value: 3, label: "3×" },
                  { value: 0, label: "Even" },
                ],
                1,
                (v) => {
                  speed = v;
                },
                "Replay speed",
              ),
            ),
            caption,
          ),
        ),
        ribbonBlock,
      ),
    );

    sheet.append(
      h(
        "section",
        { class: "stack", style: { "--gap": "10px" } },
        h("h2", { class: "sub-title" }, "Every move"),
        h(
          "p",
          { class: "hint-text" },
          dist && !r.estimate
            ? `Letters show which way the tile slid. ${cap(colourWords().good)} moved closer to solved, ${colourWords().bad} moved away. Click one to jump there.`
            : "Letters show which way the tile slid. Click one to jump there.",
        ),
        strip,
      ),
    );

    // draw the ribbon once the element is in the DOM (it needs a width)
    requestAnimationFrame(() => {
      if (!chartEl.isConnected) return;
      if (r.d) {
        const you = r.d.map((y, i) => ({ x: i, y }));
        const series = [
          { name: "Your solve", color: "var(--chart-a)", points: you },
        ];
        const items = [{ name: "Your solve", color: "var(--chart-a)" }];
        if (!r.estimate && r.optimal != null) {
          const line = [];
          for (let i = 0; i <= r.optimal; i++)
            line.push({ x: i, y: r.optimal - i });
          series.unshift({
            name: "Engine line",
            color: "var(--chart-b)",
            points: line,
            dash: true,
          });
          items.unshift({
            name: "Engine line (optimal)",
            color: "var(--chart-b)",
            dash: true,
          });
        }
        ribbon = lineChart(chartEl, series, {
          height: 260,
          xLabel: "move",
          yLabel: "moves left",
          xMin: 0,
          xMax: Math.max(r.M, r.optimal || 0),
          yMin: 0,
          title: "Distance to solved after each move",
          tipFor: (x) => {
            if (x > r.M) return `<b>Engine done</b> at move ${r.optimal}`;
            const v = r.verdict[x - 1];
            const what =
              x === 0
                ? "Start"
                : `Move ${x}: tile ${TILE_WORD[solve.movesArr[x - 1]]}`;
            const verdict =
              v === "good"
                ? "closer"
                : v === "bad"
                  ? "<b>away from solved</b>"
                  : "";
            return `<b>${what}</b><br>${r.d[x] != null ? r.d[x] + " moves left" : ""}${verdict ? "<br>" + verdict : ""}`;
          },
          onPick: (x) => {
            this.stopPlayback();
            playBtn.textContent = "Play";
            setIndex(Math.min(x, r.M));
          },
        });
        legend(chartEl, items);
        ribbon && ribbon.setCursor(r.M);
      } else {
        chartEl.replaceChildren(
          h(
            "p",
            { class: "chart-empty" },
            "The graph appears once grading finishes.",
          ),
        );
      }
    });
    setIndex(r.M);

    // insights and phases
    const insights = h(
      "ul",
      { class: "insights" },
      ...r.insights.map((x) => h("li", { class: x.tone }, x.text)),
    );
    const phaseRows = r.phases.map((p) =>
      h(
        "tr",
        null,
        h("td", null, p.name),
        h("td", { class: "tnum" }, p.moves),
        h("td", { class: "tnum" }, fmtTime(p.ms)),
        h("td", { class: "tnum" }, p.tps != null ? p.tps.toFixed(1) : "-"),
        h("td", { class: "tnum" }, dist && !r.estimate ? p.mistakes : "-"),
      ),
    );
    sheet.append(
      h(
        "section",
        { class: "cols" },
        h(
          "div",
          { class: "stack" },
          h("h2", { class: "sub-title" }, "Notes"),
          r.insights.length
            ? insights
            : h("p", { class: "muted" }, "Notes appear once grading finishes."),
        ),
        h(
          "div",
          { class: "stack" },
          h("h2", { class: "sub-title" }, "Where the time went"),
          h(
            "table",
            { class: "ledger" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Stage"),
                h("th", { class: "tnum" }, "Moves"),
                h("th", { class: "tnum" }, "Time"),
                h("th", { class: "tnum" }, "TPS"),
                h("th", { class: "tnum" }, "Wrong way"),
              ),
            ),
            h("tbody", null, ...phaseRows),
          ),
          h(
            "p",
            { class: "hint-text" },
            "A stage ends at the move after which its tiles never left home again.",
          ),
        ),
      ),
    );

    // replay one stage on the board above: the player's own moves, or the engine's from the same spot
    const watchStage = (k, which) => {
      const st = methodRead && methodRead.stages[k];
      if (!st) return;
      this.stopPlayback();
      playBtn.textContent = "Play";
      replayBoard.scrollIntoView({ behavior: "smooth", block: "center" });
      setIndex(st.from);
      this.replay.playing = true;
      if (which === "yours") {
        const step = () => {
          if (!this.replay.playing) return;
          if (this.replay.k >= st.to) return this.stopPlayback();
          setIndex(this.replay.k + 1);
          this.replay.timer = setTimeout(step, 150);
        };
        this.replay.timer = setTimeout(step, 450);
        return;
      }
      const b = r.positions[st.from].slice();
      const ms = st.engineMoves || [];
      let i = 0;
      bv.markCells(new Map());
      const step = () => {
        if (!this.replay.playing) return;
        if (i >= ms.length) {
          this.stopPlayback();
          caption.textContent = `The engine's way through ${st.name.toLowerCase()}: ${ms.length} moves, against your ${st.moves}.`;
          return;
        }
        E.applyMove(b, N, ms[i++]);
        bv.set(b, N);
        caption.textContent = `Engine, ${st.name.toLowerCase()}: move ${i} of ${ms.length}`;
        this.replay.timer = setTimeout(step, 150);
      };
      this.replay.timer = setTimeout(step, 450);
    };
    let methodRead = null;
    try {
      methodRead = readMethod(solve);
    } catch (e) {
      console.warn(e);
    }
    sheet.append(
      h(
        "section",
        { class: "stack" },
        h("h2", { class: "sub-title" }, "Your method"),
        (() => {
          try {
            return coachPanel(coach([methodRead]), {
              single: true,
              onStage: watchStage,
            });
          } catch (e) {
            console.warn(e);
            return h("p", { class: "muted" }, "The coach could not read this solve.");
          }
        })(),
      ),
    );

    sheet.append(
      h(
        "section",
        { class: "stack" },
        h("h2", { class: "sub-title" }, "Learn from your mistakes"),
        grades
          ? h("p", { class: "grade-summary tnum" }, summaryLine(grades))
          : null,
        grades
          ? h(
              "p",
              { class: "hint-text" },
              `A wrong-way move pushes you one further from solved and costs two moves to undo. One on its own is an inaccuracy, two or three in a row a mistake, four or more a blunder. ${cap(colourWords().bad)} marks your tile, ${colourWords().good} the engine's.`,
            )
          : null,
        grades
          ? mistakeCards(grades, {
              solve,
              positions: r.positions,
              engine: this.engine,
              coloring: this.store.settings.coloring,
              jump: (i) => {
                this.stopPlayback();
                playBtn.textContent = "Play";
                setIndex(i);
                replayBoard.scrollIntoView({ behavior: "smooth", block: "center" });
              },
            })
          : h(
              "p",
              { class: "muted" },
              solve.N > 4
                ? "Grading needs exact distances, which the engine gives on 3×3 and 4×4."
                : "Grading appears once the engine has finished checking every position.",
            ),
      ),
    );

    // think time per move
    const thinkEl = h("div");
    sheet.append(
      h(
        "section",
        { class: "stack" },
        h("h2", { class: "sub-title" }, "Pause before each move"),
        thinkEl,
      ),
    );
    requestAnimationFrame(() => {
      if (!thinkEl.isConnected) return;
      const bins = r.gaps.map((g, i) => ({
        x: i + 1,
        value: g / 1000,
        color: r.verdict[i] === "bad" ? "var(--chart-a)" : "var(--chart-b)",
      }));
      barChart(thinkEl, bins, {
        height: 170,
        yLabel: "seconds",
        xLabel: "move",
        tipFor: (b) =>
          `<b>Move ${b.x}</b><br>${b.value.toFixed(2)}s before it${r.verdict[b.x - 1] === "bad" ? "<br>moved away" : ""}`,
      });
      legend(
        thinkEl,
        dist && !r.estimate
          ? [
              { name: "Moved closer", color: "var(--chart-b)", dot: true },
              { name: "Moved away", color: "var(--chart-a)", dot: true },
            ]
          : [{ name: "Pause length", color: "var(--chart-b)", dot: true }],
      );
    });

    // engine line from the start
    const engineBox = h("div", { class: "stack", style: { "--gap": "10px" } });
    sheet.append(
      h(
        "section",
        { class: "stack" },
        h("h2", { class: "sub-title" }, "The engine's line"),
        engineBox,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                const b = solve.start.join(",");
                this.ctx.app.go("play", `b/${N}/${b}`);
              },
            },
            "Play this scramble again",
          ),
          h(
            "button",
            {
              class: "btn btn--ghost",
              type: "button",
              onclick: () =>
                copyText(exportText(solve, r)).then((ok) =>
                  toast(ok ? "Solve copied as text" : "Copy failed"),
                ),
            },
            "Copy as text",
          ),
          h(
            "button",
            {
              class: "btn btn--ghost",
              type: "button",
              onclick: () =>
                downloadFile(
                  `fifteen-${N}x${N}-${solve.id}.json`,
                  JSON.stringify(solve, null, 1),
                ),
            },
            "Download JSON",
          ),
          h(
            "button",
            {
              class: "btn btn--ghost btn--danger",
              type: "button",
              onclick: () => {
                confirmAction("Delete this solve? Its stats go with it.", "Delete solve", () => {
                  this.selected = null;
                  this.store.deleteSolve(solve.id);
                });
              },
            },
            "Delete",
          ),
        ),
      ),
    );
    this.engine
      .run(
        "solve",
        { board: solve.start, N, timeLimit: 15000 },
        { lane: "proof-line", replace: true },
      )
      .then((res) => {
        if (!engineBox.isConnected) return;
        engineBox.replaceChildren(
          h(
            "p",
            { class: "hint-text" },
            res.optimal
              ? `Shortest possible: ${res.moves.length} moves. Letters show the direction each tile slides.`
              : `A staged ${res.moves.length}-move solution (exact optimal search is out of reach at this size).`,
          ),
          h("p", { class: "moves-line" }, E.formatMoves(res.moves, true)),
          h(
            "div",
            null,
            h(
              "button",
              {
                class: "btn btn--small",
                type: "button",
                onclick: () => this.watchEngine(bv, solve, res.moves, caption),
              },
              "Watch it on the replay board",
            ),
          ),
        );
      })
      .catch(() =>
        engineBox.replaceChildren(
          h(
            "p",
            { class: "muted" },
            "The engine line is not available for this one.",
          ),
        ),
      );
    this.foldSections(sheet);
  }

  // Sections a reader opens when they want them. They stay laid out while shut, so their charts still measure.
  foldSections(sheet) {
    this.folds = this.folds || new Set();
    for (const sec of sheet.querySelectorAll(":scope > section")) {
      const title = sec.querySelector(":scope > h2.sub-title");
      if (!title) continue;
      const key = title.textContent.trim().toLowerCase();
      if (!FOLDED.some((f) => key.startsWith(f))) continue;
      const body = h("div", { class: "fold-body stack" });
      while (title.nextSibling) body.appendChild(title.nextSibling);
      const btn = h("button", { type: "button", class: "fold-btn" }, title.textContent);
      title.replaceChildren(btn);
      sec.classList.add("fold");
      sec.append(body);
      const sync = () => {
        const open = this.folds.has(key);
        sec.classList.toggle("is-open", open);
        btn.setAttribute("aria-expanded", String(open));
        body.inert = !open;
      };
      btn.addEventListener("click", () => {
        if (this.folds.has(key)) this.folds.delete(key);
        else this.folds.add(key);
        sync();
      });
      sync();
    }
    // the shut ones gather at the foot of the report, a short list of names
    for (const sec of sheet.querySelectorAll(":scope > section.fold")) sheet.appendChild(sec);
  }

  watchEngine(bv, solve, moves, caption) {
    this.stopPlayback();
    const pos = positionsFrom(solve.start, solve.N, moves);
    let k = 0;
    this.replay.playing = true;
    const step = () => {
      if (!this.replay.playing) return;
      bv.set(pos[k], solve.N);
      bv.markCells(null);
      caption.textContent = `Engine move ${k} of ${moves.length}`;
      if (k++ < moves.length) this.replay.timer = setTimeout(step, 140);
      else this.replay.playing = false;
    };
    bv.set(pos[0], solve.N, { instant: true });
    step();
  }

  stopPlayback() {
    if (this.replay) {
      this.replay.playing = false;
      clearTimeout(this.replay.timer);
    }
  }
}

function fig(label, value, sub) {
  return h(
    "div",
    null,
    h("div", { class: "label" }, label),
    h("div", { class: "figure" }, value),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

function exportText(solve, r) {
  return [
    `Fifteen Press, ${solve.N}x${solve.N}`,
    `Time ${fmtTime(solve.duration)}s, ${r.M} moves${r.optimal != null ? `, optimal ${r.optimal}` : ""}`,
    solve.seed ? `Seed ${solve.seed}` : `Start ${solve.start.join(" ")}`,
    `Moves ${E.formatMoves(solve.movesArr, true)}`,
  ].join("\n");
}

export { difficultyWord };
