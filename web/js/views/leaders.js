import { summarize, fmtTime, tps } from "../stats.js";
import { fetchAll, getGlobal } from "../global.js";
import { h, clear, seg, todayKey, relDate } from "../ui.js";
import { cloud, cloudConfigured, errorText } from "../cloud.js";
import { rolling } from "../deep.js";

const CATS = [
  { value: "time", label: "Fastest" },
  { value: "moves", label: "Fewest moves" },
  { value: "ao5", label: "Best ao5" },
  { value: "ao12", label: "Best ao12" },
  { value: "tps", label: "Best TPS" },
  { value: "daily", label: "Today's daily" },
  { value: "count", label: "Most solves" },
];

export class LeadersView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.scope = "local";
    this.N = 4;
    this.cat = "time";
    this.globalRows = null;
    this.globalAvailable = null;
    // the desktop app has its own accounts and board; the web version uses its host's store
    this.cloud = cloudConfigured();
    this.cloudRows = null;
    if (this.cloud) this.globalAvailable = true;
    else
      getGlobal().then((g) => {
        this.globalAvailable = !!g;
        if (!this.root.hidden) this.render();
      });
  }

  show() {
    this.render();
    if (this.scope === "global") this.loadGlobal();
  }

  onStore(e) {
    if (!this.root.hidden && e.type !== "settings") this.render();
  }

  async loadGlobal() {
    if (this.cloud) return this.loadCloud();
    this.globalRows = "loading";
    this.render();
    try {
      this.globalRows = await fetchAll();
    } catch (e) {
      this.globalRows = {
        error: e.message || "The shared board did not answer.",
      };
    }
    this.render();
  }

  async loadCloud() {
    const key = this.N + ":" + this.cat;
    this.cloudKey = key;
    this.cloudRows = "loading";
    this.render();
    let out;
    try {
      const res = await cloud.leaderboard(this.N, this.cat, todayKey());
      out = res.rows || [];
    } catch (e) {
      out = { error: errorText(e), code: e.code };
    }
    if (this.cloudKey !== key) return;
    this.cloudRows = out;
    this.render();
  }

  render() {
    clear(this.root);
    const cats =
      this.scope === "global" && !this.cloud
        ? CATS.filter((c) => ["time", "moves", "daily"].includes(c.value))
        : CATS;
    if (!cats.some((c) => c.value === this.cat)) this.cat = "time";
    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, "Leaderboards"),
          h(
            "p",
            null,
            "Clean solves only: no hints, no mods. The daily scramble is the same for everyone on the same date.",
          ),
        ),
      ),
      h(
        "div",
        { class: "filters" },
        seg(
          [
            { value: "local", label: "This device" },
            { value: "global", label: "Everyone" },
          ],
          this.scope,
          (v) => {
            this.scope = v;
            if (v === "global") this.loadGlobal();
            else this.render();
          },
          "Scope",
        ),
        seg(
          [3, 4, 5, 6, 7].map((n) => ({ value: n, label: n + "×" + n })),
          this.N,
          (n) => {
            this.N = n;
            if (this.scope === "global" && this.cloud) this.loadCloud();
            else this.render();
          },
          "Board size",
        ),
        seg(
          cats,
          this.cat,
          (c) => {
            this.cat = c;
            if (this.scope === "global" && this.cloud) this.loadCloud();
            else this.render();
          },
          "Category",
        ),
      ),
    );
    this.root.append(
      this.scope === "local" ? this.localTable() : this.globalTable(),
    );
  }

  localTable() {
    const N = this.N,
      cat = this.cat;
    const rows = [];
    for (const p of this.store.profiles()) {
      let list = this.store.solves({ profileId: p.id, N, clean: true });
      if (cat === "daily") list = list.filter((s) => s.daily === todayKey());
      if (!list.length) continue;
      const sum = summarize(list);
      let value, detail, sort, solve;
      if (cat === "time" || cat === "daily") {
        solve = list.reduce((a, b) => (b.duration < a.duration ? b : a));
        value = fmtTime(solve.duration);
        sort = solve.duration;
        detail = `${solve.moveCount} moves, ${relDate(solve.date)}`;
      } else if (cat === "moves") {
        solve = list.reduce((a, b) =>
          b.moveCount < a.moveCount ||
          (b.moveCount === a.moveCount && b.duration < a.duration)
            ? b
            : a,
        );
        value = solve.moveCount;
        sort = solve.moveCount;
        detail = `${fmtTime(solve.duration)}s${solve.optimal ? `, optimal was ${solve.optimal}` : ""}`;
      } else if (cat === "ao5") {
        if (sum.ao5.best == null) continue;
        value = fmtTime(sum.ao5.best);
        sort = sum.ao5.best;
        detail = `current ${fmtTime(sum.ao5.current)}`;
      } else if (cat === "ao12") {
        const r = rolling(list.map((x) => x.duration), 12);
        if (r.best == null) continue;
        value = fmtTime(r.best);
        sort = r.best;
        detail = `current ${fmtTime(r.current)}`;
      } else if (cat === "count") {
        value = list.length;
        sort = -list.length;
        detail = `best ${fmtTime(sum.bestTime)}`;
      } else if (cat === "tps") {
        solve = list.reduce((a, b) => (tps(b) > tps(a) ? b : a));
        value = tps(solve).toFixed(2);
        sort = -tps(solve);
        detail = `${solve.moveCount} moves in ${fmtTime(solve.duration)}s`;
      }
      rows.push({
        name: p.name,
        value,
        detail,
        sort,
        me: p.id === this.store.state.activeProfile,
        solve,
        count: list.length,
      });
    }
    rows.sort((a, b) => a.sort - b.sort);
    if (!rows.length) {
      return h(
        "div",
        { class: "empty panel" },
        h("strong", null, "No entries yet"),
        cat === "daily"
          ? "Nobody on this device has solved today's daily at this size."
          : `No clean ${N}×${N} solves on this device yet.`,
        h(
          "div",
          { style: { marginTop: "16px" } },
          h("a", { class: "btn btn--primary", href: "#play" }, "Go play"),
        ),
      );
    }
    return h(
      "section",
      { class: "stack" },
      this.table(rows, (r) => r.solve && this.ctx.app.go("proofs", r.solve.id)),
      h(
        "p",
        { class: "hint-text" },
        "Add more players from the name button at the top right. Each keeps a separate record.",
      ),
    );
  }

  cloudTable() {
    const rowsIn = this.cloudRows;
    if (!rowsIn || rowsIn === "loading") return h("p", { class: "muted" }, "Loading the Everyone board.");
    const me = this.store.profile();
    const mine = me && me.cloud ? me.cloud.handle : null;
    const refresh = h(
      "div",
      { class: "row" },
      h("button", { class: "btn btn--ghost", type: "button", onclick: () => this.loadCloud() }, "Refresh"),
      mine
        ? null
        : h(
            "button",
            { class: "btn", type: "button", onclick: () => this.ctx.app.account() },
            me && me.handle ? "Go online to post here" : "Create an account to post here",
          ),
    );
    if (rowsIn.error)
      return h(
        "div",
        { class: "empty panel" },
        h("strong", null, rowsIn.code === "offline" ? "No connection" : "Board not available"),
        rowsIn.error,
        h("div", { style: { marginTop: "16px" } }, refresh),
      );
    const cat = this.cat;
    const rows = rowsIn.map((r) => {
      const base = { name: r.name, handle: r.handle, me: !!mine && r.handle === mine };
      if (cat === "ao5" || cat === "ao12") return { ...base, value: fmtTime(r.value), detail: "" };
      if (cat === "count") return { ...base, value: r.value, detail: "clean solves" };
      if (cat === "moves")
        return { ...base, value: r.moves, detail: `${fmtTime(r.time)}s${r.optimal ? `, optimal was ${r.optimal}` : ""}` };
      if (cat === "tps")
        return { ...base, value: ((r.moves * 1000) / Math.max(1, r.time)).toFixed(2), detail: `${r.moves} moves in ${fmtTime(r.time)}s` };
      return { ...base, value: fmtTime(r.time), detail: `${r.moves} moves${r.at ? ", " + relDate(r.at) : ""}` };
    });
    if (!rows.length)
      return h(
        "div",
        { class: "empty panel" },
        h("strong", null, "Empty board"),
        cat === "daily"
          ? "Nobody has solved today's daily at this size yet."
          : "Nobody has posted here yet. A clean solve from a signed-in account posts automatically.",
        h("div", { style: { marginTop: "16px" } }, refresh),
      );
    return h(
      "section",
      { class: "stack" },
      this.table(rows),
      h("p", { class: "hint-text" }, "One row per account: its best clean solve in this category."),
      refresh,
    );
  }

  globalTable() {
    if (this.cloud) return this.cloudTable();
    if (this.globalAvailable === false) {
      return h(
        "div",
        { class: "empty panel" },
        h("strong", null, "Shared board unavailable here"),
        "The everyone board lives in the web version, where solves from all signed-in players are pooled. This copy keeps its records on this device.",
      );
    }
    if (this.globalRows === "loading" || this.globalAvailable == null)
      return h("p", { class: "muted" }, "Loading the shared board.");
    if (!this.globalRows)
      return h("p", { class: "muted" }, "Loading the shared board.");
    if (this.globalRows.error)
      return h(
        "p",
        { class: "muted" },
        "Could not load the shared board: " + this.globalRows.error,
      );
    const N = String(this.N),
      cat = this.cat;
    const rows = [];
    for (const r of this.globalRows) {
      let e;
      if (cat === "time") e = r.best[N];
      else if (cat === "moves") e = r.fewest[N];
      else e = r.daily[todayKey() + "_" + N];
      if (!e) continue;
      rows.push({
        name: r.name,
        me: r.me,
        value: cat === "moves" ? e.moves : fmtTime(e.time),
        sort: cat === "moves" ? e.moves * 1e7 + e.time : e.time,
        detail:
          cat === "moves"
            ? `${fmtTime(e.time)}s${e.optimal ? `, optimal was ${e.optimal}` : ""}`
            : `${e.moves} moves${e.at ? ", " + relDate(e.at) : ""}`,
      });
    }
    rows.sort((a, b) => a.sort - b.sort);
    if (!rows.length)
      return h(
        "div",
        { class: "empty panel" },
        h("strong", null, "Empty board"),
        "Nobody has posted here yet. A clean solve on Play posts automatically.",
      );
    return h(
      "section",
      { class: "stack" },
      this.table(rows.slice(0, 100)),
      h(
        "div",
        null,
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onclick: () => this.loadGlobal(),
          },
          "Refresh",
        ),
      ),
    );
  }

  table(rows, onClick) {
    return h(
      "div",
      { style: { overflowX: "auto" } },
      h(
        "table",
        { class: "ledger" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "Rank"),
            h("th", null, "Player"),
            h(
              "th",
              { class: "tnum" },
              CATS.find((c) => c.value === this.cat).label,
            ),
            h("th", null, ""),
          ),
        ),
        h(
          "tbody",
          null,
          ...rows.map((r, i) =>
            h(
              "tr",
              {
                class:
                  (r.me ? "is-me " : "") +
                  (onClick && r.solve ? "is-link" : ""),
                onclick: onClick ? () => onClick(r) : null,
              },
              h("td", { class: "rank" }, i + 1),
              h(
                "td",
                null,
                r.name,
                r.handle ? h("span", { class: "muted" }, " @" + r.handle) : null,
                r.me ? h("span", { class: "muted" }, " (you)") : null,
              ),
              h(
                "td",
                { class: "tnum" },
                h(
                  "strong",
                  { style: { font: "800 22px/1 var(--figures)" } },
                  r.value,
                ),
              ),
              h(
                "td",
                { class: "muted", style: { fontSize: "13px" } },
                r.detail,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
