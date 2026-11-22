// Small SVG charts with a hover layer. Colours come from theme tokens.
const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ||
    mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step)
    out.push(+v.toFixed(10));
  return out;
}

function frame(
  el,
  { height = 240, pad = { t: 14, r: 14, b: 42, l: 40 } } = {},
) {
  el.innerHTML = "";
  el.classList.add("chart");
  const width = Math.max(260, el.clientWidth || 600);
  const svg = svgEl(
    "svg",
    { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" },
    el,
  );
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  el.appendChild(tip);
  return {
    svg,
    tip,
    width,
    height,
    pad,
    iw: width - pad.l - pad.r,
    ih: height - pad.t - pad.b,
  };
}

function axes(
  f,
  xs,
  ys,
  { xFmt = String, yFmt = String, xLabel, yLabel } = {},
) {
  const g = svgEl("g", { class: "axes" }, f.svg);
  for (const v of ys.ticks) {
    const y = ys.map(v);
    svgEl(
      "line",
      { x1: f.pad.l, x2: f.pad.l + f.iw, y1: y, y2: y, class: "grid" },
      g,
    );
    const t = svgEl(
      "text",
      { x: f.pad.l - 8, y: y + 4, "text-anchor": "end", class: "tick" },
      g,
    );
    t.textContent = yFmt(v);
  }
  for (const v of xs.ticks) {
    const x = xs.map(v);
    const t = svgEl(
      "text",
      { x, y: f.pad.t + f.ih + 18, "text-anchor": "middle", class: "tick" },
      g,
    );
    t.textContent = xFmt(v);
  }
  svgEl(
    "line",
    {
      x1: f.pad.l,
      x2: f.pad.l + f.iw,
      y1: f.pad.t + f.ih,
      y2: f.pad.t + f.ih,
      class: "baseline",
    },
    g,
  );
  if (yLabel) {
    const t = svgEl(
      "text",
      { x: f.pad.l, y: f.pad.t - 4, class: "axis-label" },
      g,
    );
    t.textContent = yLabel;
  }
  if (xLabel) {
    const t = svgEl(
      "text",
      {
        x: f.pad.l + f.iw,
        y: f.pad.t + f.ih + 36,
        "text-anchor": "end",
        class: "axis-label",
      },
      g,
    );
    t.textContent = xLabel;
  }
}

function scale(dMin, dMax, rMin, rMax, tickCount) {
  if (dMax === dMin) dMax = dMin + 1;
  const ticks = niceTicks(dMin, dMax, tickCount);
  return {
    ticks,
    map: (v) => rMin + ((v - dMin) / (dMax - dMin)) * (rMax - rMin),
    invert: (p) => dMin + ((p - rMin) / (rMax - rMin)) * (dMax - dMin),
  };
}

function placeTip(f, el, tip, x, y, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const box = el.getBoundingClientRect();
  const sx = box.width / f.width;
  const w = tip.offsetWidth;
  let left = x * sx + 12;
  if (left + w > box.width - 4) left = x * sx - w - 12;
  tip.style.left = Math.max(4, left) + "px";
  tip.style.top = Math.max(0, y * sx - tip.offsetHeight - 10) + "px";
}

export function legend(el, items) {
  const wrap = document.createElement("div");
  wrap.className = "legend";
  for (const it of items) {
    const s = document.createElement("span");
    s.className = "legend-item";
    const sw = document.createElement("i");
    sw.className =
      "swatch" +
      (it.dash ? " swatch--dash" : "") +
      (it.dot ? " swatch--dot" : "");
    sw.style.setProperty("--sw", it.color);
    s.append(sw, document.createTextNode(it.name));
    wrap.appendChild(s);
  }
  el.prepend(wrap);
}

/**
 * Line chart. series: [{name, color, points:[{x,y}], dash, dotsOnly, width}]
 * opts: xLabel, yLabel, xFmt, yFmt, height, tipFor(xValue) -> html, onPick(x), markers:[{x,y,color}], cursorX
 */
export function lineChart(el, series, opts = {}) {
  const f = frame(el, opts);
  const all = series.flatMap((s) => s.points.filter((p) => p.y != null));
  if (!all.length) {
    el.innerHTML = '<p class="chart-empty">Nothing to plot yet.</p>';
    return null;
  }
  const xMin = opts.xMin ?? Math.min(...all.map((p) => p.x));
  const xMax = opts.xMax ?? Math.max(...all.map((p) => p.x));
  const yMin = opts.yMin ?? Math.min(0, ...all.map((p) => p.y));
  const yMax = opts.yMax ?? Math.max(...all.map((p) => p.y)) * 1.05;
  const xs = scale(xMin, xMax, f.pad.l, f.pad.l + f.iw, opts.xTicks || 6);
  const ys = scale(yMin, yMax, f.pad.t + f.ih, f.pad.t, 4);
  axes(f, xs, ys, opts);
  if (opts.title) f.svg.setAttribute("aria-label", opts.title);

  for (const s of series) {
    const pts = s.points.filter((p) => p.y != null);
    if (!pts.length) continue;
    if (!s.dotsOnly) {
      let d = "";
      let pen = false;
      for (const p of s.points) {
        if (p.y == null) {
          pen = false;
          continue;
        }
        d +=
          (pen ? "L" : "M") +
          xs.map(p.x).toFixed(1) +
          " " +
          ys.map(p.y).toFixed(1);
        pen = true;
      }
      svgEl(
        "path",
        {
          d,
          fill: "none",
          stroke: s.color,
          "stroke-width": s.width || 2,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
          "stroke-dasharray": s.dash ? "6 5" : "none",
          class: "series",
        },
        f.svg,
      );
    } else {
      const g = svgEl("g", {}, f.svg);
      for (const p of pts)
        svgEl(
          "circle",
          {
            cx: xs.map(p.x),
            cy: ys.map(p.y),
            r: s.r || 2.5,
            fill: s.color,
            class: "dot",
          },
          g,
        );
    }
  }
  if (opts.markers) {
    const g = svgEl("g", { class: "markers" }, f.svg);
    for (const m of opts.markers) {
      svgEl(
        "circle",
        {
          cx: xs.map(m.x),
          cy: ys.map(m.y),
          r: m.r || 4,
          fill: m.color,
          stroke: "var(--paper-2)",
          "stroke-width": 2,
        },
        g,
      );
    }
  }

  const cursor = svgEl(
    "line",
    { y1: f.pad.t, y2: f.pad.t + f.ih, class: "cursor", visibility: "hidden" },
    f.svg,
  );
  const pinned = svgEl(
    "line",
    {
      y1: f.pad.t,
      y2: f.pad.t + f.ih,
      class: "cursor cursor--pinned",
      visibility: "hidden",
    },
    f.svg,
  );
  const hit = svgEl(
    "rect",
    {
      x: f.pad.l,
      y: f.pad.t,
      width: f.iw,
      height: f.ih,
      fill: "transparent",
      class: "hit",
    },
    f.svg,
  );

  const snap = (evt) => {
    const box = f.svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * f.width;
    let x = xs.invert(px);
    if (opts.integerX !== false) x = Math.round(x);
    return Math.max(xMin, Math.min(xMax, x));
  };
  hit.addEventListener("pointermove", (evt) => {
    const x = snap(evt);
    const px = xs.map(x);
    cursor.setAttribute("x1", px);
    cursor.setAttribute("x2", px);
    cursor.setAttribute("visibility", "visible");
    if (opts.tipFor) {
      const html = opts.tipFor(x);
      if (html) placeTip(f, el, f.tip, px, f.pad.t + 8, html);
    }
    if (opts.onHover) opts.onHover(x);
  });
  hit.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    f.tip.hidden = true;
  });
  hit.addEventListener("click", (evt) => opts.onPick && opts.onPick(snap(evt)));

  return {
    setCursor(x) {
      if (x == null) {
        pinned.setAttribute("visibility", "hidden");
        return;
      }
      const px = xs.map(x);
      pinned.setAttribute("x1", px);
      pinned.setAttribute("x2", px);
      pinned.setAttribute("visibility", "visible");
    },
  };
}

/**
 * Bar chart over integer bins. bins: [{x, value, label}] ; overlay: [{x, y}] drawn as a line.
 * opts: color, overlayColor, xLabel, yLabel, yFmt, tipFor(bin), highlightX
 */
export function barChart(el, bins, opts = {}) {
  const f = frame(el, opts);
  if (!bins.length) {
    el.innerHTML = '<p class="chart-empty">Nothing to plot yet.</p>';
    return;
  }
  const xMin = opts.xMin ?? Math.min(...bins.map((b) => b.x));
  const xMax = opts.xMax ?? Math.max(...bins.map((b) => b.x));
  const yMaxData = Math.max(
    ...bins.map((b) => b.value),
    ...(opts.overlay || []).map((p) => p.y),
  );
  const ys = scale(0, yMaxData * 1.08 || 1, f.pad.t + f.ih, f.pad.t, 4);
  const slots = xMax - xMin + 1;
  const slotW = f.iw / slots;
  const xs = {
    ticks: niceTicks(xMin, xMax, Math.min(10, slots)).filter((v) =>
      Number.isInteger(v),
    ),
    map: (v) => f.pad.l + (v - xMin + 0.5) * slotW,
  };
  axes(f, xs, ys, opts);
  const g = svgEl("g", {}, f.svg);
  const barW = Math.max(1, slotW - 2);
  for (const b of bins) {
    const x = xs.map(b.x) - barW / 2;
    const y = ys.map(b.value);
    const h = f.pad.t + f.ih - y;
    if (h <= 0) continue;
    const d = `M${x} ${y + h}V${y}H${x + barW}V${y + h}Z`;
    svgEl(
      "path",
      {
        d,
        fill:
          b.x === opts.highlightX
            ? "var(--spot)"
            : b.color || opts.color || "var(--chart-a)",
        class: "bar",
      },
      g,
    );
  }
  if (opts.overlay && opts.overlay.length) {
    let d = "";
    opts.overlay.forEach((p, i) => {
      d +=
        (i ? "L" : "M") + xs.map(p.x).toFixed(1) + " " + ys.map(p.y).toFixed(1);
    });
    svgEl(
      "path",
      {
        d,
        fill: "none",
        stroke: opts.overlayColor || "var(--chart-b)",
        "stroke-width": 2,
        "stroke-linejoin": "round",
        class: "series",
      },
      f.svg,
    );
  }
  if (opts.highlightX != null) {
    const x = xs.map(opts.highlightX);
    svgEl(
      "line",
      {
        x1: x,
        x2: x,
        y1: f.pad.t,
        y2: f.pad.t + f.ih,
        class: "cursor cursor--pinned",
      },
      f.svg,
    );
  }
  const hit = svgEl(
    "rect",
    {
      x: f.pad.l,
      y: f.pad.t,
      width: f.iw,
      height: f.ih,
      fill: "transparent",
      class: "hit",
    },
    f.svg,
  );
  hit.addEventListener("pointermove", (evt) => {
    const box = f.svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * f.width;
    const x = Math.max(
      xMin,
      Math.min(xMax, Math.floor((px - f.pad.l) / slotW) + xMin),
    );
    const bin = bins.find((b) => b.x === x) || { x, value: 0 };
    if (opts.tipFor)
      placeTip(f, el, f.tip, xs.map(x), ys.map(bin.value), opts.tipFor(bin));
  });
  hit.addEventListener("pointerleave", () => {
    f.tip.hidden = true;
  });
}
