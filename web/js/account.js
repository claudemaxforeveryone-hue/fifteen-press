// Accounts: a username and password on top of each player's record. An account works on this
// computer straight away; where the cloud is reachable it is also created there, and its solves
// follow it to any other computer. Players without an account are guests.
import { store } from "./store.js";
import { cloud, cloudConfigured, errorText } from "./cloud.js";
import { syncNow, syncSoon, syncStatus, onSync } from "./sync.js";
import { h, openDialog, toast, relDate } from "./ui.js";

const HANDLE = /^[a-z0-9_]{3,20}$/;
const ITER = 150000;

export class AccountError extends Error {}

const norm = (handle) => String(handle || "").trim().toLowerCase();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/* ---------- password hashing (never stored or sent in the clear, except to sign in online) ---------- */

async function derive(password, salt, iter) {
  const enc = new TextEncoder();
  if (globalThis.crypto && crypto.subtle) {
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: iter },
      key,
      256,
    );
    return "p:" + hex(bits);
  }
  // no WebCrypto here (an insecure page): a slow string hash keeps the account usable
  let a = 0x811c9dc5,
    b = 0x01000193;
  const text = salt + "\u0000" + password;
  for (let round = 0; round < 2000; round++)
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
      b = Math.imul(b + a + round, 2246822519) >>> 0;
    }
  return "w:" + a.toString(16) + b.toString(16);
}

async function makeAuth(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iter: ITER, hash: await derive(password, salt, ITER) };
}

async function verify(profile, password) {
  if (!profile || !profile.auth) return true;
  const got = await derive(password, profile.auth.salt, profile.auth.iter || ITER);
  return got === profile.auth.hash;
}

function checkNew(handle, password) {
  if (!HANDLE.test(handle))
    throw new AccountError("Usernames are 3 to 20 characters: lowercase letters, numbers and underscores.");
  if (!password || password.length < 6) throw new AccountError("Passwords need at least 6 characters.");
  if (password.length > 72) throw new AccountError("Passwords can be 72 characters at most.");
}

/* ---------- the account operations ---------- */

/** Connect a local account to its cloud twin, creating the twin if the username is free. */
async function link(profile, password) {
  if (!cloudConfigured() || !profile.handle) return "off";
  if (profile.cloud && profile.cloud.token) return "linked";
  const adopt = (r) => {
    const fresh = !profile.cloud || profile.cloud.accountId !== r.account_id;
    store.patchProfile(profile.id, {
      cloud: {
        ...(fresh ? {} : profile.cloud),
        accountId: r.account_id,
        token: r.token,
        handle: r.handle,
      },
      cloudNote: null,
    });
    if (fresh) store.markAllPending(profile.id);
    syncSoon(200);
    return "linked";
  };
  try {
    return adopt(await cloud.login(profile.handle, password));
  } catch (e) {
    if (e.code !== "bad_login") return e.code || "offline";
  }
  try {
    return adopt(await cloud.signup(profile.handle, password, profile.name));
  } catch (e) {
    if (e.code === "handle_taken") {
      // someone else owns this username online, or the password differs there
      store.patchProfile(profile.id, { cloudNote: "taken" });
      return "taken";
    }
    return e.code || "offline";
  }
}

export async function createAccount({ handle, name, password, claim = false }) {
  handle = norm(handle);
  name = String(name || "").trim().slice(0, 24) || handle;
  checkNew(handle, password);
  if (store.findHandle(handle))
    throw new AccountError("That username is already on this computer. Sign in instead.");
  let cloudInfo = null,
    note = null;
  if (cloudConfigured()) {
    try {
      const r = await cloud.signup(handle, password, name);
      cloudInfo = { accountId: r.account_id, token: r.token, handle: r.handle };
    } catch (e) {
      if (e.code === "offline" || e.code === "unavailable") note = e.code;
      else throw new AccountError(errorText(e));
    }
  }
  const auth = await makeAuth(password);
  const current = store.profile();
  let id;
  if (claim && current && !current.handle) {
    id = current.id;
    store.patchProfile(id, { name, handle, auth, cloud: cloudInfo || undefined, nameDirty: false });
    store.setLocked(false);
  } else {
    id = store.addProfile(name, { handle, auth, ...(cloudInfo ? { cloud: cloudInfo } : {}) });
  }
  if (cloudInfo) {
    store.markAllPending(id);
    syncSoon(200);
  }
  return { id, online: !!cloudInfo, note };
}

export async function signIn(handleIn, password) {
  const handle = norm(handleIn);
  if (!handle || !password) throw new AccountError("Type your username and password.");
  const local = store.findHandle(handle);
  if (local) {
    if (await verify(local, password)) {
      store.switchProfile(local.id);
      link(local, password).catch(() => {});
      return { id: local.id, where: "local" };
    }
    // the password may have been changed from another computer
    if (cloudConfigured()) {
      try {
        const r = await cloud.login(handle, password);
        store.patchProfile(local.id, {
          auth: await makeAuth(password),
          cloud: { ...(local.cloud || {}), accountId: r.account_id, token: r.token, handle: r.handle },
        });
        store.switchProfile(local.id);
        syncSoon(200);
        return { id: local.id, where: "cloud" };
      } catch (e) {
        if (e.code === "too_many_attempts") throw new AccountError(errorText(e));
      }
    }
    throw new AccountError("Wrong username or password.");
  }
  if (!cloudConfigured()) throw new AccountError("No account with that username on this computer.");
  let r;
  try {
    r = await cloud.login(handle, password);
  } catch (e) {
    if (e.code === "offline" || e.code === "unavailable")
      throw new AccountError("No account with that username on this computer, and online accounts can't be reached right now.");
    throw new AccountError(errorText(e));
  }
  const id = store.addProfile(r.name || handle, {
    handle: r.handle,
    auth: await makeAuth(password),
    cloud: { accountId: r.account_id, token: r.token, handle: r.handle },
  });
  syncSoon(100);
  return { id, where: "cloud", solves: r.solves };
}

export function signOut() {
  const p = store.profile();
  if (p && p.cloud && p.cloud.token) {
    const token = p.cloud.token;
    // push what is waiting, then end the online session; the solves stay on this computer
    syncNow()
      .catch(() => {})
      .finally(() => cloud.logout(token).catch(() => {}));
    store.dropCloudToken(p.id);
  }
  store.setLocked(true);
}

export async function changePassword(oldPw, newPw) {
  const p = store.profile();
  if (!p || !p.auth) throw new AccountError("This player has no password.");
  if (!(await verify(p, oldPw))) throw new AccountError("The current password is wrong.");
  checkNew(p.handle, newPw);
  if (p.cloud && p.cloud.accountId) {
    if (!p.cloud.token) await link(p, oldPw);
    const token = store.profile().cloud && store.profile().cloud.token;
    if (!token) throw new AccountError("Connect to the internet to change the password of an online account.");
    try {
      await cloud.changePassword(token, oldPw, newPw);
    } catch (e) {
      throw new AccountError(errorText(e));
    }
  }
  store.patchProfile(p.id, { auth: await makeAuth(newPw) });
}

export async function deleteAccount(password) {
  const p = store.profile();
  if (!p) return;
  if (p.auth && !(await verify(p, password))) throw new AccountError("Wrong password.");
  if (p.cloud && p.cloud.accountId) {
    if (!p.cloud.token) await link(p, password);
    const token = store.profile().cloud && store.profile().cloud.token;
    if (!token) throw new AccountError("Connect to the internet to delete an online account.");
    try {
      await cloud.deleteAccount(token, password);
    } catch (e) {
      throw new AccountError(errorText(e));
    }
  }
  if (store.profiles().length < 2) {
    store.addProfile("Player 1");
    store.switchProfile(p.id);
  }
  store.deleteProfile(p.id);
  if (store.profile().auth) store.setLocked(true);
}

/** Switch to another player on this computer. Accounts need their password. */
export async function switchTo(id, password) {
  const p = store.state.profiles[id];
  if (!p) return;
  if (p.auth) {
    if (!(await verify(p, password || ""))) throw new AccountError("Wrong password.");
    store.switchProfile(id);
    link(p, password).catch(() => {});
  } else store.switchProfile(id);
}

/* ---------- what the masthead chip says ---------- */

export function accountLabel(p = store.profile()) {
  if (!p) return "";
  if (!p.handle) return "Guest";
  const st = syncStatus();
  if (st.state === "off") return "@" + p.handle;
  if (p.cloud && p.cloud.token) {
    if (st.state === "syncing") return "@" + p.handle + " · syncing";
    if (st.state === "offline") return "@" + p.handle + " · offline";
    return "@" + p.handle + " · online";
  }
  return "@" + p.handle + " · this computer";
}

/* ---------- screens ---------- */

function field(label, input, note) {
  return h("label", { class: "form-field" }, h("span", null, label), input, note ? h("small", null, note) : null);
}

function form(fields, submitLabel, onSubmit, extra) {
  const err = h("p", { class: "form-error", role: "alert", hidden: true });
  const btn = h("button", { class: "btn btn--primary", type: "submit" }, submitLabel);
  const f = h("form", { class: "stack account-form", novalidate: true }, ...fields, err, h("div", { class: "row" }, btn, ...(extra || [])));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.hidden = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "One moment";
    try {
      await onSubmit();
    } catch (ex) {
      err.textContent = ex instanceof AccountError ? ex.message : errorText(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return f;
}

const pw = (label = "Password", auto = "current-password") =>
  h("input", { type: "password", autocomplete: auto, maxlength: 72, "aria-label": label });

/** The account sheet. `gate` is the signed-out screen: it cannot be dismissed. */
export function accountDialog({ gate = false, screen = null } = {}) {
  const d = openDialog((body, close) => {
    const go = (name, arg) => {
      body.replaceChildren();
      screens[name](arg);
      const first = body.querySelector("input:not([type=checkbox])");
      if (first) setTimeout(() => first.focus(), 30);
    };
    const done = () => {
      d.dataset.gate = "";
      close();
    };
    const back = (to = "home") =>
      h("button", { class: "btn btn--ghost", type: "button", onclick: () => go(to) }, "Back");
    const locked = () => store.state.locked;

    const others = (title) => {
      const me = store.profile();
      const list = store.profiles().filter((p) => locked() || p.id !== me.id);
      if (!list.length) return null;
      return h(
        "div",
        { class: "stack account-list" },
        h("div", { class: "label" }, title),
        ...list.map((p) =>
          h(
            "button",
            {
              class: "account-row",
              type: "button",
              onclick: () => {
                if (p.auth) go("signin", p.handle);
                else {
                  store.switchProfile(p.id);
                  done();
                }
              },
            },
            h("span", { class: "initial" }, (p.name || "?").trim()[0]?.toUpperCase() || "?"),
            h("span", { class: "who" }, h("strong", null, p.name), h("small", null, p.handle ? "@" + p.handle : "Guest")),
            h("span", { class: "muted" }, store.solves({ profileId: p.id }).length + " solves"),
          ),
        ),
      );
    };

    const screens = {
      home() {
        const p = store.profile();
        if (locked()) {
          body.append(
            h("h2", null, "Who's playing?"),
            h("p", { class: "muted" }, "Pick a player, sign in, or make an account. Every player keeps their own stats."),
            others("On this computer"),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn btn--primary", type: "button", onclick: () => go("signin") }, "Sign in"),
              h("button", { class: "btn", type: "button", onclick: () => go("create") }, "Create account"),
              h(
                "button",
                {
                  class: "btn btn--ghost",
                  type: "button",
                  onclick: () => {
                    const guest = store.profiles().find((x) => !x.handle);
                    if (guest) store.switchProfile(guest.id);
                    else store.addProfile("Guest");
                    done();
                  },
                },
                "Play as guest",
              ),
            ),
          );
          return;
        }
        const count = store.solves({ profileId: p.id }).length;
        if (!p.handle) {
          const name = h("input", { type: "text", value: p.name, maxlength: 24, "aria-label": "Guest name" });
          name.addEventListener("change", () => store.renameProfile(p.id, name.value.trim()));
          body.append(
            h("h2", null, "Guest"),
            h(
              "p",
              { class: "muted" },
              `${count} solve${count === 1 ? "" : "s"} saved on this computer. An account puts a password on them` +
                (cloudConfigured() ? ", backs them up online and puts you on the Everyone board." : "."),
            ),
            field("Name", name),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn btn--primary", type: "button", onclick: () => go("create", true) }, "Create account"),
              h("button", { class: "btn", type: "button", onclick: () => go("signin") }, "Sign in"),
            ),
            others("Other players on this computer"),
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "btn btn--ghost btn--small",
                  type: "button",
                  onclick: () => {
                    store.addProfile("Guest " + (store.profiles().filter((x) => !x.handle).length + 1));
                    go("home");
                  },
                },
                "Add another guest",
              ),
              h("button", { class: "btn btn--ghost", type: "button", onclick: done }, "Done"),
            ),
          );
          return;
        }
        // a signed-in account
        const st = syncStatus();
        const linked = !!(p.cloud && p.cloud.token);
        let line;
        if (st.state === "off") line = "Saved on this computer.";
        else if (linked)
          line =
            st.state === "syncing"
              ? "Syncing now."
              : st.message ||
                (st.waiting
                  ? `${st.waiting} change${st.waiting === 1 ? "" : "s"} waiting to sync.`
                  : st.last
                    ? "Synced " + relDate(st.last) + "."
                    : "Online. Your solves are backed up.");
        else if (p.cloudNote === "taken")
          line = "This username belongs to someone else online, or has a different password there. This account stays on this computer.";
        else line = "On this computer only for now. It goes online the next time you sign in with a connection.";
        const name = h("input", { type: "text", value: p.name, maxlength: 24, "aria-label": "Display name" });
        name.addEventListener("change", () => {
          store.renameProfile(p.id, name.value.trim());
          syncSoon(500);
        });
        const lock = h("input", { type: "checkbox", checked: !!p.lockOnStart });
        lock.addEventListener("change", () => store.patchProfile(p.id, { lockOnStart: lock.checked }));
        const status = h("p", { class: "muted account-status" }, line);
        body.append(
          h("h2", null, p.name),
          h("p", { class: "account-handle" }, "@" + p.handle, h("span", { class: "muted" }, ` · ${count} solve${count === 1 ? "" : "s"}`)),
          status,
          field("Display name", name, cloudConfigured() ? "Shown on the Everyone board." : null),
          h("label", { class: "switch-row", style: { justifyContent: "start", gap: "10px", cursor: "pointer" } }, lock, "Ask for my password when the app opens"),
          h(
            "div",
            { class: "row" },
            linked
              ? h(
                  "button",
                  {
                    class: "btn",
                    type: "button",
                    onclick: async (e) => {
                      e.target.disabled = true;
                      status.textContent = "Syncing now.";
                      try {
                        const r = await syncNow();
                        status.textContent = `Synced. ${r.pushed || 0} sent, ${r.pulled || 0} received.`;
                      } catch (ex) {
                        status.textContent = errorText(ex);
                      }
                      e.target.disabled = false;
                    },
                  },
                  "Sync now",
                )
              : cloudConfigured() && p.cloudNote !== "taken"
                ? h("button", { class: "btn", type: "button", onclick: () => go("golive") }, "Go online")
                : null,
            h("button", { class: "btn", type: "button", onclick: () => go("password") }, "Change password"),
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => {
                  signOut();
                  go("home");
                },
              },
              "Sign out",
            ),
          ),
          others("Other players on this computer"),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn btn--ghost btn--small", type: "button", onclick: () => go("create") }, "Add an account"),
            h("button", { class: "btn btn--ghost btn--small btn--danger", type: "button", onclick: () => go("remove") }, "Delete this account"),
            h("button", { class: "btn btn--ghost", type: "button", onclick: done }, "Done"),
          ),
        );
      },

      signin(prefill) {
        const user = h("input", {
          type: "text",
          value: prefill || "",
          autocomplete: "username",
          autocapitalize: "none",
          spellcheck: false,
          maxlength: 20,
          "aria-label": "Username",
        });
        const pass = pw();
        body.append(
          h("h2", null, "Sign in"),
          form(
            [field("Username", user), field("Password", pass)],
            "Sign in",
            async () => {
              await signIn(user.value, pass.value);
              toast("Signed in as " + store.profile().name);
              done();
            },
            [back()],
          ),
          h("p", { class: "hint-text" }, "There is no password reset, because accounts have no email attached."),
        );
        if (prefill) setTimeout(() => pass.focus(), 40);
      },

      create(claimDefault) {
        const cur = store.profile();
        const canClaim = !locked() && cur && !cur.handle && store.solves({ profileId: cur.id }).length > 0;
        const user = h("input", {
          type: "text",
          autocomplete: "username",
          autocapitalize: "none",
          spellcheck: false,
          maxlength: 20,
          "aria-label": "Username",
        });
        const display = h("input", {
          type: "text",
          maxlength: 24,
          value: canClaim && !/^Player \d+$|^Guest/.test(cur.name) ? cur.name : "",
          "aria-label": "Display name",
        });
        const pass = pw("Password", "new-password");
        const again = pw("Password again", "new-password");
        const claim = h("input", { type: "checkbox", checked: canClaim && claimDefault !== false });
        body.append(
          h("h2", null, "Create account"),
          form(
            [
              field("Username", user, "3 to 20 characters: lowercase letters, numbers, underscores."),
              field("Display name", display, cloudConfigured() ? "Shown on the Everyone board. Skip your real name." : "Shown on the leaderboard."),
              field("Password", pass, "At least 6 characters. It is stored scrambled, never as typed."),
              field("Password again", again),
              canClaim
                ? h(
                    "label",
                    { class: "switch-row", style: { justifyContent: "start", gap: "10px", cursor: "pointer" } },
                    claim,
                    `Keep ${cur.name}'s ${store.solves({ profileId: cur.id }).length} solves in this account`,
                  )
                : null,
            ],
            "Create account",
            async () => {
              if (pass.value !== again.value) throw new AccountError("The two passwords don't match.");
              const r = await createAccount({
                handle: user.value,
                name: display.value,
                password: pass.value,
                claim: canClaim && claim.checked,
              });
              toast(
                r.online
                  ? "Account created and online"
                  : r.note
                    ? "Account created on this computer. It goes online when the connection is there."
                    : "Account created",
                4200,
              );
              done();
            },
            [back()],
          ),
        );
      },

      golive() {
        const pass = pw();
        body.append(
          h("h2", null, "Go online"),
          h("p", { class: "muted" }, "Type your password to back this account up online and join the Everyone board."),
          form(
            [field("Password", pass)],
            "Go online",
            async () => {
              const p = store.profile();
              if (!(await verify(p, pass.value))) throw new AccountError("Wrong password.");
              const r = await link(p, pass.value);
              if (r === "linked") {
                toast("Online. Syncing your solves.");
                go("home");
              } else if (r === "taken") throw new AccountError("That username is taken online by someone else. This account stays on this computer.");
              else throw new AccountError(errorText({ code: r }));
            },
            [back()],
          ),
        );
      },

      password() {
        const old = pw("Current password");
        const next = pw("New password", "new-password");
        const again = pw("New password again", "new-password");
        body.append(
          h("h2", null, "Change password"),
          form(
            [field("Current password", old), field("New password", next), field("New password again", again)],
            "Change password",
            async () => {
              if (next.value !== again.value) throw new AccountError("The two new passwords don't match.");
              await changePassword(old.value, next.value);
              toast("Password changed");
              go("home");
            },
            [back()],
          ),
        );
      },

      remove() {
        const p = store.profile();
        const count = store.solves({ profileId: p.id }).length;
        const pass = pw();
        body.append(
          h("h2", null, "Delete this account"),
          h(
            "p",
            null,
            `This deletes @${p.handle} and its ${count} solve${count === 1 ? "" : "s"} from this computer` +
              (p.cloud && p.cloud.accountId ? " and from the online board." : ".") +
              " It can't be undone. Download a backup from Settings first if you want a copy.",
          ),
          form(
            [field("Password", pass)],
            "Delete account",
            async () => {
              await deleteAccount(pass.value);
              toast("Account deleted");
              go("home");
            },
            [back()],
          ),
        );
      },
    };
    go(screen || "home");
  });
  d.dataset.gate = gate ? "1" : "";
  return d;
}

let wired = false;
/** Start-up: wire the lock, and show the sign-in screen when nobody is signed in. */
export function initAccounts({ onChange } = {}) {
  const d = document.getElementById("dialog");
  if (!wired) {
    wired = true;
    // the signed-out screen cannot be escaped
    d.addEventListener("cancel", (e) => {
      if (store.state.locked) e.preventDefault();
    });
    d.addEventListener("close", () => {
      if (store.state.locked) setTimeout(() => accountDialog({ gate: true }), 0);
    });
    onSync(() => onChange && onChange());
  }
  const p = store.profile();
  if (p && p.auth && p.lockOnStart) store.setLocked(true);
  if (store.state.locked) accountDialog({ gate: true });
  else if (p && p.cloud && p.cloud.token) syncSoon(1200);
}
