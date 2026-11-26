// App shell: router, theme, keyboard, shared events.
import { store } from "./store.js";
import { applyTheme } from "./themes.js";
import * as audio from "./audio.js";
import * as engine from "./engine-client.js";
import { h, openDialog, isTyping } from "./ui.js";
import { applyMotion } from "./motion.js";
import { accountDialog, accountLabel, initAccounts } from "./account.js";
import { syncSoon } from "./sync.js";
import { gradeAll } from "./grader.js";
import { PlayView } from "./views/play.js";
import { LabView } from "./views/lab.js";
import { ProofsView } from "./views/proofs.js";
import { StatsView } from "./views/stats.js";
import { LeadersView } from "./views/leaders.js";
import { SettingsView } from "./views/settings.js";
import { TrainView } from "./views/train.js";
import { SolvesView } from "./views/solves.js";
import { BlindView } from "./views/blind.js";
import { VersusView } from "./views/versus.js";

const app = {
  views: {},
  current: null,
  go(name, params) {
    location.hash = name + (params ? "/" + params : "");
  },
};
window.fifteen = app;

function syncLook() {
  const s = store.settings;
  applyTheme(s.theme, s.numeralFace);
  applyMotion(s);
  audio.configure(s.sound && !(s.speedMode && s.speedSound === false), s.volume, s.soundPack, s.homePing);
  document.documentElement.classList.toggle("speed-mode", !!s.speedMode);
  document.documentElement.classList.toggle("speed-focus", !!s.speedMode && s.speedFocus !== false);
  document.documentElement.classList.toggle("pic", s.backdrop !== false);
}

// The bar keeps five places in sight. The rest sit under "More", which takes the name of the page you are on
// when it is one of its own.
function initMore() {
  const more = document.querySelector(".drawer-more");
  if (!more) return;
  const btn = more.querySelector(".drawer-more-btn");
  const shut = () => {
    more.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", () => {
    const open = more.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!more.contains(e.target)) shut();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && more.classList.contains("is-open")) {
      shut();
      btn.focus();
    }
  });
  more.addEventListener("focusout", (e) => {
    if (!more.contains(e.relatedTarget)) shut();
  });
}
function syncMore() {
  const more = document.querySelector(".drawer-more");
  if (!more) return;
  const btn = more.querySelector(".drawer-more-btn");
  const here = more.querySelector('a[aria-current="page"]');
  more.classList.toggle("has-current", !!here);
  // a link picked by keyboard hands its focus to the button before the list closes under it
  if (more.querySelector(".drawer-menu").contains(document.activeElement)) btn.focus();
  more.classList.remove("is-open");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = here ? here.textContent : "More";
  btn.setAttribute("aria-label", here ? `More sections, now on ${here.textContent}` : "More sections");
}

// The desktop window has no frame: the bar drags it and carries its three buttons (see desktop/preload.js).
function initWindow() {
  const w = window.fifteenWindow;
  if (!w) return;
  const root = document.documentElement;
  root.classList.add("desktop");
  w.onState((st) => root.classList.toggle("is-max", !!(st && (st.maximized || st.fullscreen))));
  for (const b of document.querySelectorAll(".winbtns button"))
    b.addEventListener("click", (e) => {
      const act = w[b.dataset.win];
      if (act) act();
      // a mouse click should not leave a focus ring behind. a key press keeps its place
      if (e.detail > 0) b.blur();
    });
}

function renderChip() {
  const chip = document.querySelector(".player-chip");
  const p = store.profile();
  chip.replaceChildren(
    h(
      "span",
      { class: "initial" },
      (p.name || "?").trim()[0]?.toUpperCase() || "?",
    ),
    h("span", { class: "name" }, p.name, h("small", null, accountLabel(p))),
  );
}

function route() {
  // Share token: #seed-4-ABCD1234 (plain characters only, so it survives being pasted after any link)
  const share = /^#seed-(\d+)-([A-Za-z0-9]+)$/.exec(location.hash);
  if (share) { location.hash = "play/s/" + share[1] + "/" + share[2]; return; }
  const [name, ...rest] = (location.hash.slice(1) || "play").split("/");
  const target = app.views[name] ? name : "play";
  for (const sec of document.querySelectorAll(".view"))
    sec.hidden = sec.dataset.view !== target;
  for (const a of document.querySelectorAll(".drawers a")) {
    if (a.dataset.view === target) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  syncMore();
  if (app.current && app.current !== app.views[target]) {
    app.current.hide && app.current.hide();
    // the page scrolls inside <main>, so a new section starts at its top
    document.getElementById("main").scrollTop = 0;
  }
  app.current = app.views[target];
  app.current.show(rest.join("/"));
  document.title =
    target === "play"
      ? "Fifteen Press"
      : `${target === "versus" ? "1v1" : target[0].toUpperCase() + target.slice(1)} · Fifteen Press`;
}

function showKeys() {
  openDialog((body, close) => {
    body.append(
      h("h2", null, "Keys"),
      h(
        "div",
        { class: "keys-table" },
        h("span", null, h("kbd", null, "← ↑ → ↓"), " ", h("kbd", null, "WASD")),
        h("span", null, "Slide a tile (direction set in Settings)"),
        h("kbd", null, "Space"),
        h("span", null, "New scramble"),
        h("kbd", null, "R"),
        h("span", null, "Restart the same scramble"),
        h("kbd", null, "P"),
        h("span", null, "Pause or resume"),
        h("kbd", null, "H"),
        h("span", null, "Hint: show the next optimal move"),
        h("kbd", null, "T"),
        h("span", null, "Practice mode on or off (solves do not count)"),
        h("kbd", null, "C"),
        h("span", null, "Coach on or off (turns practice mode on)"),
        h("kbd", null, "Z"),
        h("span", null, "Take a move back (coach on, or the undo mod)"),
        h("kbd", null, "F"),
        h("span", null, "Speedrun mode on or off"),
        h("kbd", null, "Esc"),
        h("span", null, "Leave a drill"),
        h("kbd", null, "1 to 9"),
        h("span", null, "Switch section"),
        h("kbd", null, "?"),
        h("span", null, "This list"),
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "btn btn--primary", type: "button", onclick: close },
          "Got it",
        ),
      ),
    );
  });
}

function boot() {
  initWindow();
  syncLook();
  renderChip();
  initMore();
  const ctx = { app, store, engine };
  app.views.play = new PlayView(document.getElementById("view-play"), ctx);
  app.views.lab = new LabView(document.getElementById("view-lab"), ctx);
  app.views.proofs = new ProofsView(
    document.getElementById("view-proofs"),
    ctx,
  );
  app.views.stats = new StatsView(document.getElementById("view-stats"), ctx);
  app.views.leaders = new LeadersView(
    document.getElementById("view-leaders"),
    ctx,
  );
  app.views.train = new TrainView(document.getElementById("view-train"), ctx);
  app.views.solves = new SolvesView(document.getElementById("view-solves"), ctx);
  app.views.blind = new BlindView(document.getElementById("view-blind"), ctx);
  app.views.versus = new VersusView(document.getElementById("view-versus"), ctx);
  app.views.settings = new SettingsView(
    document.getElementById("view-settings"),
    ctx,
  );

  store.onChange((e) => {
    if (e.type === "settings" || e.type === "all") syncLook();
    if (e.type === "profile" || e.type === "all") {
      renderChip();
      // nobody plays behind the sign-in screen
      if (store.state.locked && app.current && app.current.hide) app.current.hide();
    }
    if (e.type === "graded" || e.type === "solves") syncSoon(2500);
    for (const v of Object.values(app.views)) v.onStore && v.onStore(e);
  });
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (store.settings.theme === "auto") syncLook();
    });
  // An embedding host can switch light/dark through <html data-theme>
  new MutationObserver(() => {
    if (store.settings.theme === "auto") syncLook();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  document
    .querySelector(".player-chip")
    .addEventListener("click", () => accountDialog());
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", syncLook);
  window.addEventListener("hashchange", route);
  window.addEventListener("keydown", (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.getElementById("dialog").open) return;
    if (e.key === "?") {
      e.preventDefault();
      showKeys();
      return;
    }
    const idx = "123456789".indexOf(e.key);
    if (idx >= 0) {
      e.preventDefault();
      app.go(["play", "blind", "train", "solves", "stats", "proofs", "lab", "leaders", "settings"][idx]);
      return;
    }
    if (app.current && app.current.onKey) app.current.onKey(e);
  });

  // share links: #play/seed/4/ABCD1234
  route();
  engine.warm();
  app.showKeys = showKeys;
  app.account = accountDialog;
  initAccounts({ onChange: renderChip });
  // grade the back catalogue quietly once the engine is warm
  setTimeout(() => {
    if (store.settings.autoGrade && !store.state.locked) gradeAll(store.state.activeProfile);
  }, 4000);
}

boot();
