import { THEMES, FACES, COLORINGS, resolveTheme } from "../themes.js";
import { BoardView } from "../board-view.js";
import { h, clear, seg, toast, downloadFile, confirmAction } from "../ui.js";
import * as audio from "../audio.js";
import { setSpeedMode, setPractice, setCoach } from "../speed.js";
import { SLIDES, LANDS, SOLVES, SCRAMBLES, SPEED_PRESETS } from "../motion.js";
import { accountLabel } from "../account.js";
import { cloudConfigured } from "../cloud.js";
import { METHODS } from "../steps.js";
import { COACH_TARGETS, COACH_LEVELS } from "../coach.js";

const E = window.FifteenEngine;
const VERSION = "5.6.1";

/* The page shows the handful of choices most people make. Everything else sits behind a "more" line
   in the group it belongs to, so nothing is lost and nothing has to be read to get started. */
export class SettingsView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.open = new Set();
  }

  show() {
    this.render();
  }
  hide() {
    clearInterval(this.demoTimer);
  }
  onStore(e) {
    if (!this.root.hidden && (e.type === "profile" || e.type === "all"))
      this.render();
  }

  render() {
    const s = this.store.settings;
    const set = (k) => (v) => {
      this.store.set(k, v);
      this.render();
    };
    clearInterval(this.demoTimer);
    // the page is rebuilt after every change, so it is put back where the reader was
    const main = document.getElementById("main");
    const top = main ? main.scrollTop : 0;
    clear(this.root);

    // a "more" line remembers whether it was open, because the page redraws after every change
    const more = (id, label, ...kids) => {
      const d = h(
        "details",
        { class: "more" },
        h("summary", null, label),
        h("div", { class: "more-body" }, ...kids),
      );
      d.open = this.open.has(id);
      d.addEventListener("toggle", () => {
        if (d.open === this.open.has(id)) return;
        if (d.open) this.open.add(id);
        else this.open.delete(id);
        // the moving preview board only exists while its drawer is open
        if (id === "feel") this.render();
      });
      return d;
    };

    this.root.append(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", { class: "section-title" }, "Settings"),
          h("p", null, "Saved on this computer."),
        ),
      ),
    );

    /* ---------- look ---------- */

    const swatch = (id, t, name, note) =>
      h(
        "button",
        {
          type: "button",
          class: "theme-swatch",
          title: note,
          "aria-pressed": String(s.theme === id),
          style: {
            "--sw-paper": t.paper,
            "--sw-ink": t.ink,
            "--sw-chase": t.chase,
            "--sw-block": t.block,
            "--sw-num": t.numeral,
          },
          onclick: () => set("theme")(id),
        },
        h("div", { class: "mini" }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => h("i", null, n)), h("i")),
        h("strong", null, name),
      );
    this.root.append(
      group(
        "Look",
        row(
          "Theme",
          h(
            "div",
            { class: "theme-grid" },
            ...Object.entries(THEMES).map(([id, t]) => swatch(id, t, t.name, t.note)),
            swatch("auto", resolveTheme("auto"), "Auto", "Light by day, dark by night, following Windows"),
          ),
          null,
          true,
        ),
        row(
          "Tile digits",
          h(
            "div",
            { class: "face-grid" },
            ...Object.entries(FACES).map(([id, f]) =>
              h(
                "button",
                {
                  type: "button",
                  class: "face-option",
                  title: f.note,
                  "aria-pressed": String(s.numeralFace === id),
                  onclick: () => set("numeralFace")(id),
                },
                h(
                  "span",
                  {
                    class: "sample",
                    style: {
                      fontFamily: f.family,
                      fontWeight: f.weight || 400,
                      fontStretch: f.stretch || "100%",
                    },
                  },
                  "15",
                ),
                h("small", null, f.name),
              ),
            ),
          ),
          null,
          true,
        ),
        row(
          "Tile colours",
          seg(
            Object.entries(COLORINGS).map(([id, c]) => ({ value: id, label: c.name, title: c.note })),
            s.coloring,
            set("coloring"),
            "Tile colours",
          ),
          COLORINGS[s.coloring].note + ".",
        ),
        toggle("Night picture behind the board", s.backdrop !== false, set("backdrop")),
      ),
    );

    /* ---------- feel: movement and sound ---------- */

    const vol = h("input", {
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: s.volume,
      "aria-label": "Volume",
      disabled: !s.sound,
    });
    vol.addEventListener("change", () => this.store.set("volume", Number(vol.value)));
    const sample = (pack) => {
      audio.configure(true, s.volume, pack, s.homePing);
      audio.preview();
      audio.configure(s.sound, s.volume, pack, s.homePing);
    };

    let feelMore = [];
    if (this.open.has("feel")) {
      // a board that keeps moving, so every choice shows at once
      const demoWrap = h("div", { class: "mini-board motion-demo" });
      const demo = new BoardView(demoWrap, { small: true, label: "Movement preview" });
      demo.setColoring(s.coloring);
      this.startDemo(demo);
      const anim = h("input", {
        type: "range",
        min: 0,
        max: 400,
        step: 5,
        value: s.animMs,
        "aria-label": "Slide length in milliseconds",
      });
      const animLabel = h("span", { class: "muted tnum" }, s.animMs ? s.animMs + " ms" : "instant");
      anim.addEventListener("input", () => {
        animLabel.textContent = anim.value === "0" ? "instant" : anim.value + " ms";
        this.store.set("animMs", Number(anim.value));
      });
      anim.addEventListener("change", () => this.render());
      const stagger = h("input", {
        type: "range",
        min: 0,
        max: 80,
        step: 5,
        value: s.slideStagger,
        "aria-label": "Delay between tiles when a whole row slides",
      });
      const staggerLabel = h("span", { class: "muted tnum" }, s.slideStagger ? s.slideStagger + " ms apart" : "all together");
      stagger.addEventListener("input", () => {
        staggerLabel.textContent = stagger.value === "0" ? "all together" : stagger.value + " ms apart";
        this.store.set("slideStagger", Number(stagger.value));
      });
      const style = SLIDES.find((x) => x.value === s.slideStyle) || SLIDES[0];
      feelMore = [
        h(
          "div",
          { class: "motion-grid" },
          h(
            "div",
            { class: "more-body" },
            row("Exact slide time", h("div", { class: "row" }, anim, animLabel)),
            row("Slide style", seg(SLIDES, s.slideStyle, set("slideStyle"), "Slide style"), style.note + "."),
            row("A whole row slides", h("div", { class: "row" }, stagger, staggerLabel)),
            row("When a tile lands", seg(LANDS, s.landEffect, set("landEffect"), "Landing effect")),
            row("When you solve it", seg(SOLVES, s.solveEffect, set("solveEffect"), "Solve effect")),
            row("A new scramble", seg(SCRAMBLES, s.scrambleEffect, set("scrambleEffect"), "Scramble entrance")),
          ),
          h(
            "div",
            { class: "stack motion-side", style: { "--gap": "8px" } },
            demoWrap,
            h(
              "div",
              { class: "row row--tight" },
              h("button", { class: "btn btn--small", type: "button", onclick: () => this.demoSolve(demo) }, "Solve"),
              h("button", { class: "btn btn--small", type: "button", onclick: () => this.demoDeal(demo) }, "Deal"),
            ),
          ),
        ),
        row(
          "Less movement",
          seg(
            [
              { value: "system", label: "Follow Windows" },
              { value: "full", label: "Always animate" },
              { value: "reduced", label: "Keep it still" },
            ],
            s.motionPref,
            set("motionPref"),
            "Less movement",
          ),
        ),
        toggle("Tiles dip when pressed", s.pressFeedback, set("pressFeedback")),
        toggle("Move count ticks on every move", s.timerPulse, set("timerPulse")),
        toggle("Pages fade in", s.viewFade, set("viewFade")),
        row(
          "Sound set",
          seg(
            Object.entries(audio.PACKS).map(([value, p]) => ({ value, label: p.name, title: p.note })),
            s.soundPack || "wood",
            (v) => {
              set("soundPack")(v);
              sample(v);
            },
            "Sound set",
          ),
        ),
        toggle("Ping when a tile reaches its home", s.homePing, set("homePing")),
        h(
          "div",
          null,
          h("button", { type: "button", class: "btn btn--small", onclick: () => sample(s.soundPack) }, "Play a sample"),
        ),
      ];
    }
    this.root.append(
      group(
        "Feel",
        row(
          "Slide speed",
          seg(SPEED_PRESETS, s.animMs, set("animMs"), "Slide speed"),
          SPEED_PRESETS.some((x) => x.value === s.animMs)
            ? "Slides never hold up your next move. Fast solvers usually pick instant."
            : `Yours is ${s.animMs} ms, set by hand under more.`,
        ),
        row(
          "Sound",
          h(
            "div",
            { class: "row" },
            seg(
              [
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ],
              !!s.sound,
              set("sound"),
              "Sound",
            ),
            vol,
          ),
        ),
        more("feel", "More movement and sound", ...feelMore),
      ),
    );

    /* ---------- controls ---------- */

    this.root.append(
      group(
        "Controls",
        row(
          "Arrow keys move",
          seg(
            [
              { value: "tile", label: "The tile" },
              { value: "blank", label: "The gap" },
            ],
            s.arrowMode,
            set("arrowMode"),
            "Arrow keys move",
          ),
        ),
        row(
          "Mouse",
          seg(
            [
              { value: "click", label: "Click to slide" },
              { value: "hover", label: "Hover to slide" },
            ],
            s.mouseMode,
            set("mouseMode"),
            "Mouse",
          ),
        ),
        toggle("W A S D work like the arrow keys", s.wasd, set("wasd")),
        h(
          "div",
          null,
          h("button", { class: "btn btn--small", type: "button", onclick: () => this.ctx.app.showKeys() }, "Keyboard shortcuts"),
        ),
        more(
          "controls",
          "More",
          toggle("Show the timer while solving", s.showTimer, set("showTimer")),
          row(
            "Beside the move count",
            seg(
              [
                { value: "tps", label: "Tiles per second" },
                { value: "mspm", label: "Time per move" },
                { value: "gap", label: "Last gap" },
              ],
              s.liveStat,
              set("liveStat"),
              "Beside the move count",
            ),
          ),
        ),
      ),
    );

    /* ---------- modes ---------- */

    this.root.append(
      group(
        "Modes",
        toggle(
          "Speedrun",
          s.speedMode,
          (v) => {
            setSpeedMode(this.store, v);
            this.render();
          },
          "Just the board, the clock and your splits. F on the board.",
        ),
        toggle(
          "Practice",
          s.practiceOn,
          (v) => {
            setPractice(this.store, v);
            this.render();
          },
          "Solves are saved but stay out of your stats. T on the board.",
        ),
        toggle(
          "Coach",
          s.coachOn,
          (v) => {
            setCoach(this.store, v);
            this.render();
          },
          "Points out moves that don't help, in practice. C on the board.",
        ),
        more(
          "modes",
          "Speedrun and coach options",
          row(
            "Speedrun: next scramble",
            seg(
              [
                { value: 0, label: "On Space" },
                { value: 400, label: "After 0.4 s" },
                { value: 800, label: "After 0.8 s" },
                { value: 1500, label: "After 1.5 s" },
              ],
              s.speedAutoNext || 0,
              set("speedAutoNext"),
              "Next scramble in speedrun",
            ),
          ),
          toggle("Speedrun: show splits against my average", s.speedSplits !== false, set("speedSplits")),
          toggle("Speedrun: hide the top bar", s.speedFocus !== false, set("speedFocus")),
          toggle("Speedrun: keep sound on", s.speedSound !== false, set("speedSound")),
          row("Coach compares me to", seg(COACH_TARGETS, s.coachTarget, set("coachTarget"), "Coach compares me to")),
          row(
            "How I solve",
            seg(METHODS, s.coachMethod, set("coachMethod"), "How I solve"),
            "Also sets the stages in splits, Train and Stats.",
          ),
          row("Coach shows the way", seg(COACH_LEVELS, s.coachLevel, set("coachLevel"), "Coach shows the way")),
          toggle("Coach takes bad moves back for me", s.coachAutoBack, set("coachAutoBack")),
          toggle(
            "Compare every 3×3 and 4×4 solve to the shortest one",
            s.autoGrade,
            set("autoGrade"),
            "Runs quietly after each solve. It fills in the efficiency numbers.",
          ),
        ),
      ),
    );

    /* ---------- you ---------- */

    const me = this.store.profile();
    const mine = this.store.solves({ profileId: me.id }).length;
    const total = this.store.state.solves.length;
    const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        this.store.importJSON(await f.text());
        toast("Backup restored");
      } catch (e) {
        toast(e.message || "That file could not be read.");
      }
    });
    this.root.append(
      group(
        "You",
        row(
          "Player",
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "account-card" },
              h("strong", null, me.name),
              h("small", null, `${accountLabel(me)} · ${mine} solve${mine === 1 ? "" : "s"}`),
            ),
            h(
              "button",
              { class: "btn", type: "button", onclick: () => this.ctx.app.account() },
              me.handle ? "Manage account" : "Create account or sign in",
            ),
            this.store.profiles().length > 1 || me.handle
              ? h("button", { class: "btn btn--ghost", type: "button", onclick: () => this.ctx.app.account() }, "Switch player")
              : null,
          ),
          me.handle
            ? null
            : "You are playing as a guest. An account puts a password on your solves" +
                (cloudConfigured() ? ", backs them up online and puts you on the Everyone board." : "."),
        ),
        row(
          "Backup",
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () =>
                  downloadFile(
                    `fifteen-press-backup-${new Date().toISOString().slice(0, 10)}.json`,
                    this.store.exportJSON(),
                  ),
              },
              "Save a backup",
            ),
            h("button", { class: "btn btn--ghost", type: "button", onclick: () => file.click() }, "Restore one"),
            file,
          ),
          `${total} solve${total === 1 ? "" : "s"} on this computer.`,
        ),
        more(
          "you",
          "Start over",
          h(
            "div",
            null,
            h(
              "button",
              {
                class: "btn btn--ghost btn--danger",
                type: "button",
                onclick: () => {
                  confirmAction("Erase every player, solve and setting on this device?", "Erase everything", () => {
                    this.store.reset();
                    toast("Everything erased");
                  });
                },
              },
              "Erase everything",
            ),
          ),
        ),
      ),
    );

    /* ---------- about ---------- */

    this.root.append(
      group(
        "About",
        h("p", { class: "about-line" }, `Fifteen Press ${VERSION}`),
        more(
          "about",
          "How it works",
          h(
            "div",
            { class: "about-text" },
            h(
              "p",
              null,
              "The 4×4 solver finds the shortest possible solution, usually in a few milliseconds (IDA* over additive 6-6-3 pattern databases with a mirrored lookup). 3×3 uses a complete table of all 181,440 positions. Larger boards are solved row by row down to a 4×4 core, which is then solved optimally.",
            ),
            h(
              "p",
              null,
              "Position counts by solution length come from OEIS A089484 (4×4, from Korf and Schultze's 2005 complete search) and A089473 (3×3).",
            ),
            h(
              "p",
              null,
              "Type: Maple Mono, Fraunces, Ultra, Rozha One, Big Shoulders Display and Archivo, all under the SIL Open Font License.",
            ),
          ),
        ),
      ),
    );
    if (main) main.scrollTop = top;
  }

  /* ---------- the movement preview ---------- */

  startDemo(pv) {
    const N = 4;
    this.demoBoard = E.scrambleFromSeed("motion", N);
    pv.set(this.demoBoard, N, { instant: true });
    let last = -1,
      step = 0;
    const tick = () => {
      if (this.root.hidden || !pv.root.isConnected) {
        clearInterval(this.demoTimer);
        return;
      }
      if (this.demoHold > Date.now()) return;
      const board = this.demoBoard;
      step++;
      const blank = board.indexOf(0);
      const dirs = [0, 1, 2, 3].filter((d) => d !== E.INV[last] && E.neighbor(blank, d, N) >= 0);
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      // every fourth step slides a whole row, to show the stagger
      const count = step % 4 === 0 ? 3 : 1;
      for (let i = 0; i < count; i++) {
        if (E.neighbor(board.indexOf(0), d, N) < 0) break;
        E.applyMove(board, N, d);
        pv.set(board, N);
      }
      last = d;
    };
    clearInterval(this.demoTimer);
    this.demoHold = 0;
    this.demoTimer = setInterval(tick, Math.max(460, this.store.settings.animMs * 1.6 + 300));
  }

  demoSolve(pv) {
    const N = 4;
    const solved = Array.from({ length: N * N }, (_, i) => (i + 1) % (N * N));
    this.demoHold = Date.now() + 2200;
    pv.clearProofed();
    pv.set(solved, N, { instant: true });
    pv.inkWave();
    setTimeout(() => {
      if (!pv.root.isConnected) return;
      pv.clearProofed();
      this.demoBoard = E.scrambleFromSeed("motion" + Date.now(), N);
      pv.set(this.demoBoard, N, { instant: true });
      pv.enter();
    }, 1900);
  }

  demoDeal(pv) {
    this.demoHold = Date.now() + 900;
    pv.clearProofed();
    this.demoBoard = E.scrambleFromSeed("motion" + Date.now(), 4);
    pv.set(this.demoBoard, 4, { instant: true });
    pv.enter();
  }
}

/* a named block of rows */
function group(title, ...rows) {
  return h(
    "section",
    { class: "settings-group" },
    h("header", null, h("h2", { class: "sub-title" }, title)),
    h("div", { class: "controls-col" }, ...rows),
  );
}

/* a label, its control and at most one plain line of help. wide rows put the label on top */
function row(label, control, hint, wide) {
  return h(
    "div",
    { class: "set-row" + (wide ? " set-row--wide" : "") },
    h("span", { class: "set-label" }, label),
    h("div", { class: "set-control" }, control, hint ? h("p", { class: "hint-text" }, hint) : null),
  );
}

function toggle(label, value, onChange, hint) {
  const cb = h("input", { type: "checkbox", checked: !!value });
  cb.addEventListener("change", () => onChange(cb.checked));
  return h(
    "label",
    { class: "switch-row" },
    cb,
    h("span", { class: "switch-text" }, label, hint ? h("small", null, hint) : null),
  );
}
