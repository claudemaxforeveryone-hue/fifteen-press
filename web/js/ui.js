// Tiny DOM helpers.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object")
        for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else
      el.appendChild(
        c instanceof Node ? c : document.createTextNode(String(c)),
      );
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = document.querySelector(".toast");
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

export function seg(options, value, onPick, label) {
  const wrap = h("div", {
    class: "seg",
    role: "group",
    "aria-label": label || null,
  });
  for (const o of options) {
    const b = h(
      "button",
      {
        type: "button",
        "aria-pressed": String(o.value === value),
        title: o.title || null,
      },
      o.label,
    );
    b.addEventListener("click", () => {
      for (const x of wrap.children) x.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", "true");
      onPick(o.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

export function openDialog(build) {
  const d = document.getElementById("dialog");
  clear(d);
  const body = h("div", { class: "sheet-body" });
  d.appendChild(body);
  build(body, () => d.close());
  if (!d.open) d.showModal();
  return d;
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    ok = false;
  }
  ta.remove();
  return ok;
}

// In-page confirmation (embedded hosts refuse window.confirm).
export function confirmAction(message, actionLabel, onConfirm) {
  openDialog((body, close) => {
    body.append(
      h("p", { style: { fontSize: "16px", fontWeight: "600" } }, message),
      h("div", { class: "row" },
        h("button", { class: "btn btn--primary", type: "button", onclick: () => { close(); onConfirm(); } }, actionLabel),
        h("button", { class: "btn btn--ghost", type: "button", onclick: close }, "Cancel")),
    );
  });
}

export async function downloadFile(name, text, type = "application/json") {
  // Hosted pages block script downloads; their host offers a save capability instead.
  if (window.claude && typeof window.claude.use === "function") {
    try {
      const dl = await window.claude.use("downloads");
      if (dl) { await dl.save({ filename: name, data: text }); return; }
    } catch (e) {
      if (e && e.code && e.code !== "not_granted") { toast("Download cancelled"); return; }
    }
  }
  const blob = new Blob([text], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function relDate(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function todayKey() {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

export function isTyping(e) {
  const t = e.target;
  return (
    t &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable)
  );
}

// Views build children with optional parts (cond ? el : null). Native append would print "null",
// so skip empty values and flatten nested arrays everywhere in this app.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['append', 'replaceChildren']) {
    const native = proto[name];
    proto[name] = function (...nodes) {
      return native.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false));
    };
  }
}
