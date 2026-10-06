(() => {
  const $ = (s) => document.querySelector(s);
  const icon = (n) => `<span class="ico">${ICONS[n]}</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayKey = () => key(new Date());
  const endOfMonth = (k) => { const d = parse(k); return key(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };

  const INK = "#161616";
  const PATTERNS = [
    INK,
    `repeating-linear-gradient(-45deg, ${INK} 0 2px, transparent 2px 5px)`,
    `radial-gradient(${INK} 1.3px, transparent 1.5px) 0 0 / 5px 5px`,
    `repeating-linear-gradient(0deg, ${INK} 0 2px, transparent 2px 5px)`,
    `repeating-linear-gradient(45deg, ${INK} 0 1.5px, transparent 1.5px 6px), repeating-linear-gradient(-45deg, ${INK} 0 1.5px, transparent 1.5px 6px)`,
    "transparent",
  ];
  const OLD_COLORS = ["#F7A8B8", "#8FD3BC", "#B9B4F0", "#F9C784", "#94C6F0"];
  const patOf = (t) => PATTERNS[t.pat ?? 0] ?? PATTERNS[0];
  const SCRIBBLE = `<svg class="scribble" viewBox="0 0 48 44" preserveAspectRatio="none"><path d="M31 5 C 13 1, 3 12, 4 24 C 5 37, 19 42, 29 40 C 41 38, 47 27, 44 16 C 41 6, 28 2, 16 7" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/></svg>`;
  const WD = [["M", 1], ["T", 2], ["W", 3], ["T", 4], ["F", 5], ["S", 6], ["S", 0]];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DEFAULT_REPO = "projectwave-commits/monthtasks-data";

  let state = { v: 2, tasks: [] };
  let cfg = null; // { repo, token } when sync is set up
  const now = new Date();
  const view = { y: now.getFullYear(), m: now.getMonth(), sel: todayKey(), open: null, form: null, armed: null, panel: false };
  const sync = { status: "off", last: 0, error: "", busy: false, again: false, timer: null, draft: { repo: DEFAULT_REPO, token: "" } };

  // ---------- storage (desktop: files via Python, phone: localStorage) ----------
  const desktop = () => !!window.pywebview?.api;
  const store = {
    async load() {
      let raw = "";
      if (desktop()) raw = await window.pywebview.api.load();
      else try { raw = localStorage.getItem("monthtasks") || ""; } catch {}
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },
    write() {
      const s = JSON.stringify(state);
      if (desktop()) window.pywebview.api.save(s);
      else try { localStorage.setItem("monthtasks", s); } catch {}
    },
    save() { this.write(); scheduleSync(2000); },
    async loadCfg() {
      let raw = "";
      if (desktop()) raw = await window.pywebview.api.load_config();
      else try { raw = localStorage.getItem("monthtasks-sync") || ""; } catch {}
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },
    saveCfg(c) {
      const s = c ? JSON.stringify(c) : "";
      if (desktop()) window.pywebview.api.save_config(s);
      else try { c ? localStorage.setItem("monthtasks-sync", s) : localStorage.removeItem("monthtasks-sync"); } catch {}
    },
  };

  // ---------- task logic ----------
  const live = () => state.tasks.filter((t) => !t.del);
  const find = (id) => state.tasks.find((t) => t.id === id && !t.del);
  const isActive = (t, k) => k >= t.start && k <= t.end && t.days.includes(parse(k).getDay());
  const status = (t, k) => t.log[k]?.v || (k < todayKey() ? "missed" : "pending");
  function activeDays(t) {
    const out = [];
    for (let d = parse(t.start), end = parse(t.end); d <= end; d.setDate(d.getDate() + 1)) {
      if (t.days.includes(d.getDay())) out.push(key(d));
    }
    return out;
  }
  function stats(t) {
    const days = activeDays(t);
    const s = { total: days.length, done: 0, skip: 0 };
    for (const k of days) {
      const st = status(t, k);
      if (st === "done") s.done++;
      else if (st === "skip" || st === "missed") s.skip++;
    }
    return { ...s, left: s.total - s.done - s.skip, days };
  }
  function mark(id, k, what) {
    const t = find(id);
    if (!t || k > todayKey()) return;
    t.log[k] = { v: t.log[k]?.v === what ? null : what, t: Date.now() };
    store.save();
    render();
  }

  // older saves: string marks, colours instead of patterns, no timestamps
  function upgrade(data) {
    for (const t of data.tasks) {
      if (t.del) continue;
      if (t.pat == null) { t.pat = Math.max(0, OLD_COLORS.indexOf(t.color)); delete t.color; }
      t.u ??= 1;
      t.log ??= {};
      for (const [k, e] of Object.entries(t.log)) if (typeof e === "string") t.log[k] = { v: e, t: 1 };
    }
    data.v = 2;
    return data;
  }

  // ---------- sync ----------
  function scheduleSync(ms) {
    if (!cfg) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(runSync, ms);
  }
  async function runSync() {
    if (!cfg) return;
    if (sync.busy) { sync.again = true; return; }
    if (!navigator.onLine) { sync.status = "offline"; renderSync(); return; }
    sync.busy = true; sync.status = "busy"; renderSync();
    try {
      const merged = await Sync.run(cfg, state);
      // keep anything edited while the request was in flight
      const next = Sync.merge(state, merged);
      if (Sync.canon(next) !== Sync.canon(merged)) sync.again = true;
      const changed = Sync.canon(next) !== Sync.canon(state);
      state = next;
      store.write();
      if (changed) render();
      sync.status = "ok"; sync.last = Date.now(); sync.error = "";
    } catch (e) {
      sync.status = navigator.onLine ? "error" : "offline";
      sync.error = e.message || String(e);
    }
    sync.busy = false;
    renderSync();
    if (sync.again) { sync.again = false; scheduleSync(500); }
  }
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const SYNC_ICON = { off: "cloud", ok: "cloudCheck", busy: "cloudUp", offline: "cloudSlash", error: "cloudWarn" };
  function renderSync() {
    const st = cfg ? sync.status : "off";
    const btn = $("#syncBtn");
    btn.innerHTML = icon(SYNC_ICON[st]);
    btn.className = "icon-btn sync-btn s-" + st;
    btn.title = { off: "Set up sync", ok: "Synced " + ago(sync.last), busy: "Syncing...", offline: "Offline, will sync later", error: sync.error }[st];

    const p = $("#syncPanel");
    if (!view.panel) { p.innerHTML = ""; return; }
    if (!cfg) {
      p.innerHTML = `
        <div class="card panel">
          <div class="panel-title">${icon("cloud")}sync with your phone</div>
          <p class="hint">Saves to a private GitHub repo so this device and your phone stay in step. Works offline and catches up when you're back online.</p>
          <label class="row">repo <input type="text" id="sRepo" value="${esc(sync.draft.repo)}" spellcheck="false"></label>
          <label class="row">token <input type="password" id="sToken" placeholder="github_pat_..." value="${esc(sync.draft.token)}" spellcheck="false" autocomplete="off"></label>
          ${sync.error ? `<p class="err">${esc(sync.error)}</p>` : ""}
          <div class="form-actions"><button class="btn" data-close>Close</button><button class="btn primary" data-connect>Connect</button></div>
        </div>`;
    } else {
      const line = { ok: "synced " + ago(sync.last), busy: "syncing...", offline: "offline, changes will sync later", error: sync.error, off: "" }[sync.status];
      p.innerHTML = `
        <div class="card panel">
          <div class="panel-title">${icon(SYNC_ICON[sync.status])}sync is on</div>
          <p class="hint">${esc(cfg.repo)}<br>syncs every hour, when you open the app and after each change<br><span class="${sync.status === "error" ? "err" : ""}">${esc(line)}</span></p>
          <div class="form-actions"><button class="btn" data-disconnect>Turn off</button><button class="btn" data-close>Close</button><button class="btn primary" data-syncnow>Sync now</button></div>
        </div>`;
    }
  }
  async function connect() {
    const repo = $("#sRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    const token = $("#sToken").value.trim();
    sync.draft = { repo, token };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { sync.error = "Fill in both the repo (owner/name) and the token"; renderSync(); return; }
    const btn = $("[data-connect]"); btn.textContent = "Checking..."; btn.disabled = true;
    try {
      await Sync.pull({ repo, token });
      cfg = { repo, token };
      store.saveCfg(cfg);
      sync.error = "";
      sync.draft = { repo: DEFAULT_REPO, token: "" };
      renderSync();
      runSync();
    } catch (e) {
      sync.error = e.message || "Couldn't reach GitHub";
      renderSync();
    }
  }

  // ---------- calendar ----------
  function renderCal() {
    $("#monthLabel").textContent = `${MONTHS[view.m]} ${view.y}`;
    const first = new Date(view.y, view.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const count = new Date(view.y, view.m + 1, 0).getDate();
    const tk = todayKey();
    const tasks = live();
    let html = "";
    for (let i = 0; i < lead; i++) html += `<div class="day empty"></div>`;
    for (let d = 1; d <= count; d++) {
      const k = key(new Date(view.y, view.m, d));
      // today's tasks sit as dots in a ring around the date, starting at the top
      const todays = k === tk ? tasks.filter((t) => isActive(t, k)).slice(0, 12) : [];
      const ring = todays.length
        ? `<span class="ring">${todays.map((t, i) => `<i class="dot ${status(t, k)}" style="--x:${(Math.sin((2 * Math.PI * i) / todays.length) * 12.5).toFixed(1)}px;--y:${(-Math.cos((2 * Math.PI * i) / todays.length) * 12.5).toFixed(1)}px"></i>`).join("")}</span>`
        : "";
      const cls = ["day", k === tk && "today", k === view.sel && "sel", k < tk && "past", ring && "has-ring"].filter(Boolean).join(" ");
      html += `<button class="${cls}" data-k="${k}">${k === view.sel ? SCRIBBLE : ""}<span class="num">${d}</span>${ring}</button>`;
    }
    $("#grid").innerHTML = html;

    // month summary pills
    const mStart = key(first), mEnd = key(new Date(view.y, view.m, count));
    let done = 0, skip = 0;
    for (const t of tasks) for (const k of activeDays(t)) {
      if (k < mStart || k > mEnd) continue;
      const st = status(t, k);
      if (st === "done") done++;
      else if (st === "skip" || st === "missed") skip++;
    }
    $("#summary").innerHTML = tasks.length
      ? `<span class="pill" title="done this month">${icon("check")}${done}</span><span class="pill muted" title="skipped this month">${icon("x")}${skip}</span>` : "";
  }

  // ---------- tasks ----------
  function renderTasks() {
    const k = view.sel, d = parse(k);
    const tasks = live().filter((t) => isActive(t, k));
    $("#dayLabel").textContent = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const doneN = tasks.filter((t) => t.log[k]?.v === "done").length;
    $("#daySub").textContent = tasks.length ? `${doneN} of ${tasks.length} done` : "a free day";
    const future = k > todayKey();

    if (!tasks.length) {
      $("#list").innerHTML = view.form ? "" : `<div class="empty-state">${icon("smile")}nothing planned here...<br>tap + to doodle something in</div>`;
      return;
    }
    $("#list").innerHTML = tasks.map((t) => {
      const st = status(t, k), s = stats(t), open = view.open === t.id;
      const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
      const strip = s.days.map((dk) => {
        const ds = status(t, dk);
        return `<button class="sd ${ds} ${dk === k ? "cur" : ""}" data-go="${dk}" title="${parse(dk).toDateString()}">${parse(dk).getDate()}</button>`;
      }).join("");
      return `
      <div class="tile ${open ? "open" : ""} ${st === "done" ? "is-done" : ""} ${st === "skip" ? "is-skip" : ""}" data-id="${t.id}" style="--pat:${patOf(t)}">
        <div class="tile-row" data-toggle>
          <span class="blob"></span>
          <div class="tile-main">
            <div class="title">${esc(t.title)}</div>
            <div class="meta">${s.done}/${s.total} done${s.skip ? ` · ${s.skip} skipped` : ""}${s.left ? ` · ${s.left} to go` : ""}</div>
          </div>
          <button class="mark skip ${st === "skip" ? "on" : ""}" data-mark="skip" title="Skip this day" ${future ? "disabled" : ""}>${icon("x")}</button>
          <button class="mark done ${st === "done" ? "on" : ""}" data-mark="done" title="Done" ${future ? "disabled" : ""}>${icon("check")}</button>
        </div>
        <div class="detail">
          <div class="bar"><i class="b-done" style="width:${pct(s.done)}%"></i><i class="b-skip" style="width:${pct(s.skip)}%"></i></div>
          <div class="strip">${strip}</div>
          <div class="legend">
            <span><i class="k kd"></i>done</span>
            <span><i class="k ks"></i>skipped</span>
            <span class="spacer"></span>
            <button class="mini" data-edit>${icon("pencil")}Edit</button>
            <button class="mini danger ${view.armed === t.id ? "armed" : ""}" data-del>${icon("trash")}${view.armed === t.id ? "Sure?" : ""}</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  // ---------- form ----------
  function openForm(t) {
    view.form = t
      ? { id: t.id, title: t.title, start: t.start, end: t.end, days: [...t.days], pat: t.pat ?? 0 }
      : { id: null, title: "", start: view.sel, end: endOfMonth(view.sel), days: [0, 1, 2, 3, 4, 5, 6], pat: live().length % PATTERNS.length };
    renderForm();
    $("#fTitle").focus();
  }
  function renderForm() {
    const f = view.form;
    if (!f) { $("#form").innerHTML = ""; return; }
    $("#form").innerHTML = `
      <div class="card form">
        <input type="text" id="fTitle" placeholder="What do you want to do?" maxlength="80" value="${esc(f.title)}">
        <div class="row">From <input type="date" id="fStart" value="${f.start}"> to <input type="date" id="fEnd" value="${f.end}"></div>
        <div class="chips">${WD.map(([l, n]) => `<button class="chip ${f.days.includes(n) ? "on" : ""}" data-wd="${n}">${l}</button>`).join("")}</div>
        <div class="row">
          <div class="swatches">${PATTERNS.map((p, i) => `<button class="sw ${i === f.pat ? "on" : ""}" data-pat="${i}" style="--pat:${p}" title="pattern"></button>`).join("")}</div>
          <span style="flex:1"></span>
          <div class="form-actions">
            <button class="btn" data-cancel>Cancel</button>
            <button class="btn primary" data-save>${f.id ? "Save" : "Add"}</button>
          </div>
        </div>
      </div>`;
  }
  function saveForm() {
    const f = view.form;
    f.title = $("#fTitle").value.trim();
    f.start = $("#fStart").value || view.sel;
    f.end = $("#fEnd").value || f.start;
    if (!f.title) { $("#fTitle").focus(); return; }
    if (f.end < f.start) [f.start, f.end] = [f.end, f.start];
    if (!f.days.length) f.days = [0, 1, 2, 3, 4, 5, 6];
    const fields = { title: f.title, start: f.start, end: f.end, days: f.days, pat: f.pat, u: Date.now() };
    const existing = f.id && find(f.id);
    if (existing) Object.assign(existing, fields);
    else {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      state.tasks.push({ id, ...fields, log: {} });
      view.open = id;
    }
    view.form = null;
    store.save();
    renderForm();
    render();
  }

  function render() { renderCal(); renderTasks(); }

  function select(k) {
    view.sel = k;
    const d = parse(k);
    view.y = d.getFullYear(); view.m = d.getMonth();
    render();
  }

  // ---------- events ----------
  document.querySelectorAll("[data-i]").forEach((el) => (el.innerHTML = ICONS[el.dataset.i]));
  $("#prev").onclick = () => { view.m--; if (view.m < 0) { view.m = 11; view.y--; } renderCal(); };
  $("#next").onclick = () => { view.m++; if (view.m > 11) { view.m = 0; view.y++; } renderCal(); };
  $("#today").onclick = () => select(todayKey());
  $("#add").onclick = () => (view.form && !view.form.id ? ((view.form = null), renderForm(), renderTasks()) : openForm(null));
  $("#grid").onclick = (e) => { const b = e.target.closest("[data-k]"); if (b) select(b.dataset.k); };
  $("#syncBtn").onclick = () => { view.panel = !view.panel; renderSync(); };
  $("#syncPanel").onclick = (e) => {
    if (e.target.closest("[data-close]")) { view.panel = false; renderSync(); }
    else if (e.target.closest("[data-connect]")) connect();
    else if (e.target.closest("[data-syncnow]")) runSync();
    else if (e.target.closest("[data-disconnect]")) { cfg = null; store.saveCfg(null); sync.status = "off"; renderSync(); }
  };

  $("#list").onclick = (e) => {
    const tile = e.target.closest(".tile");
    if (!tile) return;
    const id = tile.dataset.id;
    const m = e.target.closest("[data-mark]");
    if (m) { if (!m.disabled) mark(id, view.sel, m.dataset.mark); return; }
    const go = e.target.closest("[data-go]");
    if (go) { select(go.dataset.go); return; }
    if (e.target.closest("[data-edit]")) { openForm(find(id)); return; }
    if (e.target.closest("[data-del]")) {
      if (view.armed === id) {
        state.tasks = state.tasks.map((t) => (t.id === id ? { id, del: true, u: Date.now() } : t));
        view.armed = null; view.open = null;
        store.save(); render();
      } else { view.armed = id; renderTasks(); }
      return;
    }
    if (e.target.closest("[data-toggle]")) {
      view.open = view.open === id ? null : id;
      view.armed = null;
      renderTasks();
    }
  };

  $("#form").onclick = (e) => {
    const f = view.form;
    if (!f) return;
    const wd = e.target.closest("[data-wd]");
    const sw = e.target.closest("[data-pat]");
    if (wd || sw) {
      f.title = $("#fTitle").value; f.start = $("#fStart").value; f.end = $("#fEnd").value;
      if (wd) { const n = +wd.dataset.wd; f.days = f.days.includes(n) ? f.days.filter((x) => x !== n) : [...f.days, n]; }
      if (sw) f.pat = +sw.dataset.pat;
      renderForm();
    } else if (e.target.closest("[data-cancel]")) { view.form = null; renderForm(); renderTasks(); }
    else if (e.target.closest("[data-save]")) saveForm();
  };
  document.addEventListener("keydown", (e) => {
    if (!view.form || !e.target.closest("#form")) return;
    if (e.key === "Enter") saveForm();
    if (e.key === "Escape") { view.form = null; renderForm(); renderTasks(); }
  });

  // refresh "today" past midnight; keep the "synced x min ago" label fresh; sync every hour
  const SYNC_EVERY = 60 * 60 * 1000;
  let lastToday = todayKey();
  setInterval(() => {
    if (todayKey() !== lastToday) { lastToday = todayKey(); render(); }
    renderSync();
    if (cfg && Date.now() - sync.last >= SYNC_EVERY) runSync();
  }, 60000);
  window.addEventListener("online", () => scheduleSync(300));
  window.addEventListener("offline", () => { if (cfg) { sync.status = "offline"; renderSync(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(300); });

  // ---------- boot ----------
  let booted = false;
  async function boot() {
    if (booted) return;
    booted = true;
    const data = await store.load();
    if (data && Array.isArray(data.tasks)) state = upgrade(data);
    cfg = await store.loadCfg();
    render();
    renderSync();
    scheduleSync(100);
  }
  if (desktop() || location.protocol === "https:") boot();
  else {
    window.addEventListener("pywebviewready", boot);
    setTimeout(() => { if (!window.pywebview) boot(); }, 800);
  }

  // phone: installable + offline
  if (!window.pywebview && "serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").then((r) => r.update());
    // a new version took over: reload once so it's used straight away
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
    navigator.storage?.persist?.();
  }
})();
