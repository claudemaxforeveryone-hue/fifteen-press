// Cloud accounts. The desktop app talks to a small set of server functions and nothing else:
// no table is readable from here, and every call past sign-in carries a session token.
// Where no cloud is configured (the web version), every call reports "unavailable".

const cfg = (typeof window !== "undefined" && window.FifteenCloud) || null;

export function cloudConfigured() {
  return !!(cfg && cfg.url && cfg.key);
}

export class CloudError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const TEXT = {
  bad_handle: "Usernames are 3 to 20 characters: lowercase letters, numbers and underscores.",
  bad_password: "Passwords need 6 to 72 characters.",
  handle_taken: "That username is taken. Pick another one.",
  bad_login: "Wrong username or password.",
  too_many_attempts: "Too many wrong tries. Wait ten minutes and try again.",
  bad_session: "This computer is signed out online. Sign in again to sync.",
  busy: "Too many new accounts right now. Try again in an hour.",
  too_big: "That was too much data to save in one go.",
  bad_request: "The server did not understand that.",
  offline: "No connection. Your solves are safe on this computer and sync later.",
  unavailable: "Online accounts are not switched on yet. This account works on this computer for now.",
};

export function errorText(e) {
  const code = e && e.code ? e.code : String(e);
  return TEXT[code] || (e && e.message) || "Something went wrong.";
}

async function rpc(fn, args, { timeout = 15000 } = {}) {
  if (!cloudConfigured()) throw new CloudError("unavailable");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: "Bearer " + cfg.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args || {}),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new CloudError("offline");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    // the functions are not installed (yet), or the project is paused
    if (res.status === 404 || res.status === 401 || res.status === 403 || res.status >= 500)
      throw new CloudError("unavailable", data && data.message);
    throw new CloudError("bad_request", data && data.message);
  }
  if (data && data.error) throw new CloudError(data.error);
  return data || {};
}

export const cloud = {
  signup: (handle, password, name) => rpc("fp_signup", { p_handle: handle, p_password: password, p_name: name }),
  login: (handle, password) => rpc("fp_login", { p_handle: handle, p_password: password }),
  logout: (token) => rpc("fp_logout", { p_token: token }),
  whoami: (token) => rpc("fp_whoami", { p_token: token }),
  updateProfile: (token, { name = null, settings = null, summary = null } = {}) =>
    rpc("fp_profile_update", { p_token: token, p_name: name, p_settings: settings, p_summary: summary }),
  changePassword: (token, oldPw, newPw) => rpc("fp_change_password", { p_token: token, p_old: oldPw, p_new: newPw }),
  deleteAccount: (token, password) => rpc("fp_delete_account", { p_token: token, p_password: password }),
  push: (token, solves) => rpc("fp_push", { p_token: token, p_solves: solves }, { timeout: 30000 }),
  pull: (token, since, after, limit = 300) =>
    rpc("fp_pull", { p_token: token, p_since: since || null, p_after: after || "", p_limit: limit }, { timeout: 30000 }),
  leaderboard: (N, cat, daily) => rpc("fp_leaderboard", { p_n: N, p_cat: cat, p_daily: daily || null }),
};
