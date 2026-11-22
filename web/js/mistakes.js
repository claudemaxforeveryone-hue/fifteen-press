// Lichess-style grading for a slide puzzle. A move is wrong-way when the exact distance to solved
// goes up. Every wrong-way move costs two (one out, one back), so a run of them is graded by length.
import { BoardView } from "./board-view.js";
import { fmtTime } from "./stats.js";
import { h } from "./ui.js";

const E = window.FifteenEngine;
const TILE_WORD = ["down", "up", "right", "left"]; // tile direction for each blank direction

export const GRADES = {
  inaccuracy: { name: "Inaccuracy", sym: "?!" },
  mistake: { name: "Mistake", sym: "?" },
  blunder: { name: "Blunder", sym: "??" },
};
const gradeFor = (k) =>
  k >= 4 ? "blunder" : k >= 2 ? "mistake" : "inaccuracy";

/** Groups wrong-way moves into episodes and grades each. Needs exact distances. */
export function gradeMistakes(r, solve) {
  const graded = r.verdict.filter((v) => v !== "unknown").length;
  if (!r.d || r.estimate || graded < r.M * 0.6) return null;
  const gaps = r.gaps.slice(1).sort((a, b) => a - b);
  const pace = gaps.length ? Math.max(60, gaps[gaps.length >> 1]) : 150;
  const episodes = [];
  for (let i = 0; i < r.M; i++) {
    if (r.verdict[i] !== "bad") continue;
    let j = i;
    while (j + 1 < r.M && r.verdict[j + 1] === "bad") j++;
    const k = j - i + 1;
    const grade = gradeFor(k);
    episodes.push({
      at: i, // position index before the first wrong-way move
      k,
      cost: 2 * k,
      ms: 2 * k * pace,
      grade,
      think: r.gaps[i] || 0,
    });
    i = j;
  }
  const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const e of episodes) counts[e.grade]++;
  const accuracy = r.good + r.bad ? r.good / (r.good + r.bad) : null;
  return {
    episodes,
    counts,
    accuracy,
    pace,
    wasted: episodes.reduce((a, e) => a + e.cost, 0),
    worst: episodes
      .slice()
      .sort((a, b) => b.cost - a.cost || a.at - b.at)
      .slice(0, 6),
  };
}

export function summaryLine(g) {
  const part = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [
    g.accuracy != null ? `Accuracy ${Math.round(g.accuracy * 100)}%` : null,
    part(g.counts.inaccuracy, "inaccuracy").replace(
      "inaccuracys",
      "inaccuracies",
    ),
    part(g.counts.mistake, "mistake"),
    part(g.counts.blunder, "blunder"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Cards for the costliest episodes. `engine` finds the better move; `jump(i)` moves the replay there.
 */
export function mistakeCards(g, { solve, positions, engine, coloring, jump }) {
  const N = solve.N;
  if (!g.worst.length)
    return h(
      "p",
      { class: "muted" },
      "No wrong-way moves at all. Nothing to train here.",
    );
  const list = h("div", { class: "mistakes" });
  const queue = [];
  for (const e of g.worst) {
    const pos = positions[e.at];
    const blank = pos.indexOf(0);
    const played = solve.movesArr[e.at];
    const playedTile = pos[E.neighbor(blank, played, N)];
    const boardWrap = h("div", { class: "mistake-board" });
    const bv = new BoardView(boardWrap, {
      small: true,
      label: "Position before the mistake",
    });
    bv.setColoring(coloring);
    bv.set(pos, N, { instant: true });
    bv.markCells(new Map([[playedTile, "mark-bad"]]));
    const better = h("p", { class: "muted" }, "Finding the better move…");
    const info = GRADES[e.grade];
    list.append(
      h(
        "article",
        { class: "mistake mistake--" + e.grade },
        boardWrap,
        h(
          "div",
          { class: "mistake-text" },
          h(
            "div",
            { class: "mistake-head" },
            h("span", { class: "grade-badge" }, info.sym),
            h("strong", null, info.name),
            h("span", { class: "muted tnum" }, `move ${e.at + 1}`),
          ),
          h(
            "p",
            null,
            `You slid ${playedTile} ${TILE_WORD[played]}` +
              (e.k > 1
                ? ` and kept going the wrong way for ${e.k} moves`
                : "") +
              `. That cost ${e.cost} moves, about ${fmtTime(e.ms)} s at your pace.` +
              (e.think > 900
                ? ` You also stopped ${fmtTime(e.think)} s before it.`
                : ""),
          ),
          better,
          h(
            "div",
            { class: "actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn--small",
                onclick: () => jump(e.at),
              },
              "Jump to it",
            ),
            h(
              "a",
              {
                class: "btn btn--small",
                href: `#play/b/${N}/${pos.join(",")}`,
                title:
                  "Opens this exact position on the play board (tagged as custom)",
              },
              "Practise this position",
            ),
          ),
        ),
      ),
    );
    queue.push(async () => {
      try {
        const res = await engine.run(
          "solve",
          { board: pos.slice(), N, timeLimit: 3000 },
          { lane: "mistakes" },
        );
        const best = res.moves[0];
        const bestTile = pos[E.neighbor(blank, best, N)];
        bv.markCells(
          new Map([
            [playedTile, "mark-bad"],
            [bestTile, "mark-good"],
          ]),
        );
        better.className = "";
        better.replaceChildren(
          "Better: slide ",
          h("b", null, String(bestTile)),
          ` ${TILE_WORD[best]}. From here the engine finishes in ${res.moves.length}` +
            (res.optimal ? " moves, optimally." : " moves."),
        );
      } catch (err) {
        if (!err.cancelled)
          better.textContent = "The engine could not check this one.";
      }
    });
  }
  // one at a time so the hint lane stays free
  (async () => {
    for (const job of queue) await job();
  })();
  return list;
}
