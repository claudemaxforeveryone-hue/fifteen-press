// Speedrun mode: one switch that sets the app up for the fastest solves it can give, and puts
// everything back after. Nothing animates, nothing else is on screen, only moved tiles repaint.
import { MOD_KEYS } from "./store.js";
import { resolveTheme } from "./themes.js";

const KEEP = [
  "theme",
  "numeralFace",
  "animMs",
  "coloring",
  "landEffect",
  "solveEffect",
  "scrambleEffect",
  "viewFade",
  "timerPulse",
  "pressFeedback",
  "slideStagger",
  "coachOn",
  "practiceOn",
];

export function setSpeedMode(store, on) {
  const s = store.settings;
  if (!!on === !!s.speedMode) return;
  if (on) {
    const set = {
      // Lamplight is already flat and still, so speedrun keeps it. The older themes swap to their bare twin.
      theme: resolveTheme(s.theme).id === "lamp" ? "lamp" : resolveTheme(s.theme).dark ? "void" : "minimal",
      numeralFace: resolveTheme(s.theme).id === "lamp" ? s.numeralFace : "grotesk",
      animMs: 0,
      coloring: "correct",
      landEffect: "none",
      solveEffect: "none",
      scrambleEffect: "none",
      viewFade: false,
      timerPulse: false,
      pressFeedback: false,
      slideStagger: 0,
      coachOn: false,
      practiceOn: false,
    };
    const prev = {};
    for (const k of KEEP) prev[k] = s[k];
    for (const k of MOD_KEYS) if (s[k]) prev[k] = true;
    store.set("speedPrev", { prev, set });
    for (const [k, v] of Object.entries(set)) if (s[k] !== v) store.set(k, v);
    for (const k of MOD_KEYS) if (s[k]) store.set(k, false);
  } else {
    const saved = s.speedPrev || {};
    const prev = saved.prev || saved;
    const set = saved.set || {};
    // anything changed by hand during speedrun mode stays as the player left it
    for (const [k, v] of Object.entries(prev))
      if ((!(k in set) || s[k] === set[k]) && s[k] !== v) store.set(k, v);
    store.set("speedPrev", null);
  }
  store.set("speedMode", !!on);
}

/** Practice mode: solves are saved but stay out of averages, records and stats. The coach lives here. */
export function setPractice(store, on) {
  on = !!on;
  if (on && store.settings.speedMode) setSpeedMode(store, false);
  if (!on && store.settings.coachOn) store.set("coachOn", false);
  if (!!store.settings.practiceOn !== on) store.set("practiceOn", on);
}

/** The coach only runs in practice mode, so turning it on turns practice on with it. */
export function setCoach(store, on) {
  on = !!on;
  if (on) setPractice(store, true);
  if (!!store.settings.coachOn !== on) store.set("coachOn", on);
}
