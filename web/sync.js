// Offline-first sync of the task data to a file in a private GitHub repo.
// Every task carries `u` (last edit time) and every day mark carries `t`,
// so two devices can merge: newest task details win, newest mark per day wins,
// and deletions are kept as tombstones ({ id, del: true, u }).
window.Sync = (() => {
  const FILE = "data.json";
  const API = "https://api.github.com/repos/";

  // JSON with sorted keys, so equal data always gives the same string
  const stable = (x) =>
    Array.isArray(x) ? "[" + x.map(stable).join(",") + "]"
    : x && typeof x === "object" ? "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}"
    : JSON.stringify(x);

  // newer wins; on an exact tie pick deterministically so both devices agree
  const newer = (x, y, ts) => ({ yWins: ts(y) !== ts(x) ? ts(y) > ts(x) : stable(y) > stable(x) });

  function mergeLog(a = {}, b = {}) {
    const out = { ...a };
    for (const [k, e] of Object.entries(b)) if (!out[k] || newer(out[k], e, (z) => z.t || 0).yWins) out[k] = e;
    return out;
  }

  function merge(a, b) {
    const byId = new Map();
    for (const t of a.tasks || []) byId.set(t.id, [t, null]);
    for (const t of b.tasks || []) byId.set(t.id, [byId.get(t.id)?.[0] || null, t]);
    const tasks = [];
    for (const [id, [x, y]] of byId) {
      const meta = (z) => ({ ...z, log: 0 });
      const win = !x ? y : !y ? x : newer(meta(x), meta(y), (z) => z.u || 0).yWins ? y : x;
      if (win.del) tasks.push({ id, del: true, u: win.u });
      else tasks.push({ ...win, log: mergeLog(x?.log, y?.log) });
    }
    tasks.sort((p, q) => (p.id < q.id ? -1 : 1));
    return { v: 2, tasks };
  }

  // stable string used to tell whether two copies differ
  const canon = (s) => stable(merge(s, { tasks: [] }));

  const toB64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

  async function gh(cfg, method, body) {
    const res = await fetch(API + cfg.repo + "/contents/" + FILE + (method === "GET" ? "?t=" + Date.now() : ""), {
      method,
      cache: "no-store",
      headers: {
        Authorization: "Bearer " + cfg.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  function explain(res) {
    if (res.status === 401) return "GitHub didn't accept the token (expired or mistyped?)";
    if (res.status === 403) return "The token isn't allowed to write to that repo";
    if (res.status === 404) return "Repo not found, or the token can't see it";
    return "GitHub said " + res.status;
  }

  // returns { data, sha } or { data: null } when the file doesn't exist yet
  async function pull(cfg) {
    const res = await gh(cfg, "GET");
    if (res.status === 404) {
      // distinguish "no file yet" from "no repo / no access"
      const repo = await fetch(API + cfg.repo, { cache: "no-store", headers: { Authorization: "Bearer " + cfg.token } });
      if (repo.ok) return { data: null, sha: null };
    }
    if (!res.ok) throw new Error(explain(res));
    const j = await res.json();
    return { data: JSON.parse(fromB64(j.content)), sha: j.sha };
  }

  async function push(cfg, data, sha) {
    const res = await gh(cfg, "PUT", {
      message: "sync " + new Date().toISOString(),
      content: toB64(JSON.stringify(data, null, 1)),
      ...(sha ? { sha } : {}),
    });
    if (res.status === 409 || res.status === 422) return false; // someone else wrote first: pull & merge again
    if (!res.ok) throw new Error(explain(res));
    return true;
  }

  // pull, merge into local, push back if remote is behind. Returns merged state.
  async function run(cfg, local) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await pull(cfg);
      const merged = merge(local, remote.data || { tasks: [] });
      if (remote.data && canon(remote.data) === canon(merged)) return merged;
      if (await push(cfg, merged, remote.sha)) return merged;
      local = merged;
    }
    throw new Error("Kept colliding with another device, will retry");
  }

  return { merge, canon, run, pull };
})();
