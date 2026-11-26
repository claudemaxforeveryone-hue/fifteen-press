// Motion: how tiles slide, what happens when one lands, how a scramble arrives and how a solve
// is celebrated. Everything is a CSS variable or attribute on <html>, so every board follows it.

export const SLIDES = [
  { value: "slide", label: "Slide", note: "Quick off the mark, soft at the end", ease: "cubic-bezier(0.2, 0.9, 0.25, 1)" },
  { value: "glide", label: "Glide", note: "Eases in and out", ease: "cubic-bezier(0.45, 0, 0.2, 1)" },
  { value: "spring", label: "Spring", note: "Overshoots a touch and settles", ease: "cubic-bezier(0.3, 1.5, 0.5, 1)" },
  {
    value: "bounce",
    label: "Bounce",
    note: "Hits the stop and bounces",
    ease: "linear(0, 0.36 18%, 0.82 36%, 1 46%, 0.9 58%, 1 72%, 0.97 82%, 1)",
  },
  { value: "linear", label: "Linear", note: "Constant speed", ease: "linear" },
  { value: "ratchet", label: "Ratchet", note: "Moves in four clicks", ease: "steps(4, end)" },
  { value: "fade", label: "Fade", note: "No travel: the tile fades in where it lands", ease: "linear", jump: true },
  { value: "pop", label: "Pop", note: "No travel: the tile pops in where it lands", ease: "linear", jump: true },
];

export const LANDS = [
  { value: "none", label: "Nothing" },
  { value: "bump", label: "Bump" },
  { value: "stamp", label: "Stamp" },
  { value: "flash", label: "Ink flash" },
  { value: "tilt", label: "Tilt" },
];

export const SOLVES = [
  { value: "wave", label: "Ink wave" },
  { value: "sweep", label: "Diagonal sweep" },
  { value: "burst", label: "Burst" },
  { value: "spin", label: "Spin" },
  { value: "rise", label: "Rise" },
  { value: "none", label: "Nothing" },
];

export const SCRAMBLES = [
  { value: "none", label: "Instant" },
  { value: "deal", label: "Deal" },
  { value: "drop", label: "Drop" },
  { value: "fade", label: "Fade" },
  { value: "scatter", label: "Scatter" },
];

export const SPEED_PRESETS = [
  { value: 0, label: "Instant" },
  { value: 30, label: "Fast" },
  { value: 45, label: "Quick" },
  { value: 90, label: "Smooth" },
  { value: 160, label: "Slow" },
  { value: 280, label: "Showy" },
];

/** What boards read at move time. */
export const motion = {
  style: "slide",
  jump: false,
  ms: 45,
  stagger: 0,
  land: "none",
  solve: "wave",
  scramble: "none",
  reduced: false,
};

const systemReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function applyMotion(s) {
  const root = document.documentElement;
  const style = SLIDES.find((x) => x.value === s.slideStyle) || SLIDES[0];
  const reduced = s.motionPref === "reduced" || (s.motionPref !== "full" && systemReduced());
  motion.style = style.value;
  motion.jump = !!style.jump;
  motion.ms = Number(s.animMs) || 0;
  motion.stagger = reduced ? 0 : Number(s.slideStagger) || 0;
  motion.land = reduced ? "none" : s.landEffect || "none";
  motion.solve = reduced ? "none" : s.solveEffect || "wave";
  motion.scramble = reduced ? "none" : s.scrambleEffect || "none";
  motion.reduced = reduced;
  root.style.setProperty("--anim", motion.ms + "ms");
  root.style.setProperty("--slide-ease", style.ease);
  root.dataset.slide = style.value;
  root.dataset.land = motion.land;
  root.dataset.solve = motion.solve;
  root.dataset.enter = motion.scramble;
  root.classList.toggle("motion-reduced", reduced);
  root.classList.toggle("fx-press", !!s.pressFeedback && !reduced);
  root.classList.toggle("no-view-fade", !s.viewFade || reduced);
  root.classList.toggle("square", s.squareCorners !== false);
}

/** Replays a one-shot CSS animation class on an element. */
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function pulse(el) {
  if (!motion.reduced) replay(el, "tick");
}
