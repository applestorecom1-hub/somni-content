/*
 * Somni Контент — подключение к Supabase.
 * Страница написана под встроенную базу claude.ai (window.claude.use).
 * Этот файл повторяет ту же схему поверх Supabase: данные, вход по почте,
 * файлы и выгрузку. Менять сам сайт для GitHub не нужно.
 */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return; // открыто на claude.ai — работает родная база

  var cfg = window.SOMNI_CONFIG || {};
  var BUCKET = cfg.bucket || "media";
  window.SOMNI_MAX_MB = cfg.maxFileMb || 50;
  window.SOMNI_NO_DB_TEXT = "Не удалось подключиться к базе. Проверьте адрес и ключ Supabase в файле config.js.";

  var configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/XXXX|ВСТАВЬТЕ/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
  var sb = (configured && window.supabase) ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  /* ---------- локальная копия базы ---------- */
  var store = new Map();
  var listeners = new Set();
  function coll(c) { if (!store.has(c)) store.set(c, new Map()); return store.get(c); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function merge(cur, patch) {
    Object.keys(patch).forEach(function (k) {
      if (isObj(patch[k]) && isObj(cur[k])) merge(cur[k], patch[k]); else cur[k] = clone(patch[k]);
    });
    return cur;
  }
  function docSnap(id, data) {
    var d = clone(data);
    return { id: id, exists: data !== undefined, data: function () { return d; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function fire(l) {
    var m = coll(l.coll);
    if (l.id !== undefined) { l.fn(docSnap(l.id, m.get(l.id))); return; }
    var arr = Array.from(m.entries()).map(function (e) { return { id: e[0], d: e[1] }; });
    l.where.forEach(function (w) { arr = arr.filter(function (x) { var v = x.d[w[0]];
      return w[1] === "==" ? v === w[2] : w[1] === "!=" ? v !== w[2] : w[1] === "<" ? v < w[2] : w[1] === "<=" ? v <= w[2] :
        w[1] === ">" ? v > w[2] : w[1] === ">=" ? v >= w[2] : w[1] === "in" ? w[2].indexOf(v) >= 0 : w[1] === "array-contains" ? Array.isArray(v) && v.indexOf(w[2]) >= 0 : true; }); });
    if (l.order) {
      var f = l.order.f, s = l.order.dir === "desc" ? -1 : 1;
      arr.sort(function (a, b) { var x = a.d[f], y = b.d[f];
        if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * s; });
    } else arr.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    if (l.limit) arr = arr.slice(0, l.limit);
    var docs = arr.map(function (x) { return docSnap(x.id, x.d); });
    l.fn({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } });
  }
  function notify(c) { listeners.forEach(function (l) { if (l.coll === c) { try { fire(l); } catch (e) { console.error(e); } } }); }

  function mapErr(e) {
    var msg = (e && e.message) || "", code = e && e.code;
    if (code === "42501" || code === "P0002" || /row-level security|permission|not found/i.test(msg)) return { code: "invalid_argument", message: msg };
    if (/fetch|network/i.test(msg)) return { code: "unavailable", message: msg };
    return { code: "unavailable", message: msg };
  }
  function genId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 20); }

  async function loadAll() {
    var from = 0, page = 1000;
    for (;;) {
      var r = await sb.from("docs").select("coll,id,data").range(from, from + page - 1);
      if (r.error) throw r.error;
      r.data.forEach(function (row) { coll(row.coll).set(row.id, row.data); });
      if (r.data.length < page) break;
      from += page;
    }
  }
  function realtime() {
    sb.channel("somni-docs").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (p) {
      if (p.eventType === "DELETE") { var o = p.old || {}; if (o.coll) { coll(o.coll).delete(o.id); notify(o.coll); } return; }
      var n = p.new; if (!n || !n.coll) return;
      coll(n.coll).set(n.id, n.data); notify(n.coll);
    }).subscribe();
  }

  /* ---------- db ---------- */
  function docRef(path) {
    var parts = String(path).split("/"); var c = parts[0], id = parts[1];
    if (parts.length !== 2 || !c || !id) throw new TypeError("Путь документа должен быть вида коллекция/документ: " + path);
    return {
      id: id, path: path,
      get: async function () { return docSnap(id, coll(c).get(id)); },
      set: async function (data) {
        var prev = coll(c).get(id); coll(c).set(id, clone(data)); notify(c);
        var r = await sb.from("docs").upsert({ coll: c, id: id, data: data, updated_at: new Date().toISOString() });
        if (r.error) { if (prev === undefined) coll(c).delete(id); else coll(c).set(id, prev); notify(c); throw mapErr(r.error); }
      },
      update: async function (patch) {
        var cur = coll(c).get(id);
        if (cur === undefined) throw { code: "invalid_argument", message: "Документ не найден" };
        coll(c).set(id, merge(clone(cur), patch)); notify(c);
        var r = await sb.rpc("docs_patch", { p_coll: c, p_id: id, p_patch: patch });
        if (r.error) { coll(c).set(id, cur); notify(c); throw mapErr(r.error); }
      },
      delete: async function () {
        var prev = coll(c).get(id); coll(c).delete(id); notify(c);
        var r = await sb.from("docs").delete().match({ coll: c, id: id });
        if (r.error) { if (prev !== undefined) coll(c).set(id, prev); notify(c); throw mapErr(r.error); }
      },
      onSnapshot: function (next) { var l = { coll: c, id: id, fn: next, where: [] }; listeners.add(l); setTimeout(function () { fire(l); }, 0); return function () { listeners.delete(l); }; },
      collection: function () { throw new TypeError("Вложенные коллекции в этой версии не поддерживаются"); }
    };
  }
  function query(c, q) {
    q = q || { where: [], order: null, limit: 0 };
    var api = {
      where: function (f, op, v) { return query(c, { where: q.where.concat([[f, op, v]]), order: q.order, limit: q.limit }); },
      orderBy: function (f, dir) { return query(c, { where: q.where, order: { f: f, dir: dir || "asc" }, limit: q.limit }); },
      limit: function (n) { return query(c, { where: q.where, order: q.order, limit: n }); },
      get: function () { return new Promise(function (res) { fire({ coll: c, where: q.where, order: q.order, limit: q.limit, fn: res }); }); },
      onSnapshot: function (next) { var l = { coll: c, where: q.where, order: q.order, limit: q.limit, fn: next }; listeners.add(l); setTimeout(function () { fire(l); }, 0); return function () { listeners.delete(l); }; }
    };
    return api;
  }
  var dbApi = {
    doc: docRef,
    collection: function (c) {
      var api = query(c); api.path = c;
      api.doc = function (id) { return docRef(c + "/" + (id || genId())); };
      api.add = async function (data) { var ref = docRef(c + "/" + genId()); await ref.set(data); return ref; };
      return api;
    }
  };

  /* ---------- пользователь ---------- */
  var me = null, role = null;
  var COLORS = ["#8B74D9", "#E0A23B", "#4FA37A", "#D06A6A", "#4F8FD0", "#B565A7", "#6A9C3A"];
  function colorOf(id) { var h = 0; String(id).split("").forEach(function (ch) { h = (h * 31 + ch.charCodeAt(0)) >>> 0; }); return COLORS[h % COLORS.length]; }
  function avatar(name, id) {
    var ini = String(name || "?").trim().split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase() || "?";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="' + colorOf(id) + '"/><text x="32" y="41" font-family="sans-serif" font-size="26" font-weight="600" text-anchor="middle" fill="#fff">' + ini.replace(/[<&>"]/g, "") + "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  var canWrite = function () { return role === "owner" || role === "editor"; };
  var userApi = {
    isOwner: async function () { return role === "owner"; },
    canEdit: async function () { return canWrite(); },
    can: async function (n) { return (n === "data.write" || n === "assets.write" || n === "files.write") ? canWrite() : false; },
    me: async function () { return { id: me.id, name: me.name, email: me.email, avatarUrl: avatar(me.name, me.id), color: colorOf(me.id), isOwner: role === "owner", canEdit: canWrite() }; },
    id: async function () { return me.id; },
    name: async function () { return me.name; },
    email: async function () { return me.email; },
    avatarUrl: async function () { return avatar(me.name, me.id); },
    search: async function () { return []; },
    profiles: async function (ids) {
      var out = {}; [].concat(ids).forEach(function (id) {
        var p = coll("people").get(id) || {};
        out[id] = { id: id, name: p.name || "", avatarUrl: avatar(p.name || "?", id), color: colorOf(id), email: null, isMe: me && id === me.id, guest: false };
      }); return out;
    }
  };

  /* ---------- файлы ---------- */
  window.SOMNI_BLOB_URL = function (id) { return sb ? sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl : ""; };
  var assetsApi = {
    upload: async function (file) {
      if (file.size > window.SOMNI_MAX_MB * 1024 * 1024) throw { code: "too_large", message: "Файл слишком большой" };
      var ext = ((file.name || "").split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
      var path = new Date().toISOString().slice(0, 7) + "/" + genId() + "." + ext;
      var r = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (r.error) { var st = String(r.error.statusCode || r.error.status || "");
        throw { code: st === "413" ? "too_large" : st === "415" ? "unsupported_type" : "upstream_error", message: r.error.message }; }
      return { id: path, url: window.SOMNI_BLOB_URL(path), sizeBytes: file.size, contentType: file.type || "application/octet-stream" };
    },
    delete: async function (id) { var r = await sb.storage.from(BUCKET).remove([id]); if (r.error) throw { code: "upstream_error", message: r.error.message }; return { deleted: true }; },
    list: async function () { return { assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }; }
  };
  var downloadsApi = {
    save: function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = req.filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      return Promise.resolve({ status: "saved" });
    }
  };

  /* ---------- вход ---------- */
  var resolveReady; var ready = new Promise(function (r) { resolveReady = r; });
  window.claude = { use: async function (name) {
    var ok = await ready; if (!ok) return null;
    if (name === "db") return dbApi;
    if (name === "user") return userApi;
    if (name === "assets") return canWrite() ? assetsApi : null;
    if (name === "downloads") return downloadsApi;
    return null;
  } };
  window.SOMNI_SIGNOUT = function () { return sb && sb.auth.signOut(); };
  document.addEventListener("click", function (e) { if (e.target && e.target.id === "signOut") { sb.auth.signOut().then(function () { location.reload(); }); } });

  var gate;
  function showGate(html) {
    if (!gate) { gate = document.createElement("div"); gate.id = "gate";
      gate.style.cssText = "position:fixed;inset:0;z-index:100;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:24px";
      document.body.appendChild(gate); }
    gate.innerHTML = '<div style="width:100%;max-width:380px;display:grid;gap:14px">' +
      '<div class="brand" style="font-size:28px">somni<i>.</i> <small>контент</small></div>' + html + "</div>";
  }
  function hideGate() { if (gate) { gate.remove(); gate = null; } }
  function esc(s) { return String(s || "").replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function loginForm(note) {
    showGate('<p class="muted" style="margin:0">Войдите, чтобы открыть контент-план. Почту и пароль выдаёт владелец сайта.</p>' +
      '<div><label class="lab" for="gEmail">Почта</label><input class="in" id="gEmail" type="email" autocomplete="email" placeholder="name@example.com"></div>' +
      '<div><label class="lab" for="gPass">Пароль</label><input class="in" id="gPass" type="password" autocomplete="current-password"></div>' +
      '<button class="btn pri" id="gSend">Войти</button>' +
      '<p id="gNote" class="muted" style="margin:0;font-size:14px">' + (note || "") + "</p>");
    var send = async function () {
      var email = document.getElementById("gEmail").value.trim(), pass = document.getElementById("gPass").value;
      var note = document.getElementById("gNote");
      if (!/^\S+@\S+\.\S+$/.test(email) || !pass) { note.textContent = "Введите почту и пароль."; return; }
      document.getElementById("gSend").disabled = true; note.textContent = "Входим…";
      var r = await sb.auth.signInWithPassword({ email: email, password: pass });
      if (r.error) { document.getElementById("gSend").disabled = false;
        note.textContent = /invalid/i.test(r.error.message) ? "Неверная почта или пароль." : "Не получилось войти: " + r.error.message; }
    };
    document.getElementById("gSend").addEventListener("click", send);
    ["gEmail", "gPass"].forEach(function (id) { document.getElementById(id).addEventListener("keydown", function (e) { if (e.key === "Enter") send(); }); });
  }
  var loggingIn = false;
  async function afterLogin(session) {
    if (me || loggingIn) return; loggingIn = true;
    showGate('<p class="muted" style="margin:0">Загружаем план…</p>');
    var r = await sb.rpc("register_me");
    if (r.error || !r.data) {
      showGate('<p style="margin:0">Адрес <b>' + esc(session.user.email) + '</b> не добавлен в команду.</p>' +
        '<p class="muted" style="margin:0">Попросите владельца добавить его в таблицу members в Supabase и войдите снова.</p>' +
        '<button class="btn" id="gOut">Выйти</button>');
      document.getElementById("gOut").addEventListener("click", function () { sb.auth.signOut().then(function () { location.reload(); }); });
      loggingIn = false; return;
    }
    me = { id: session.user.id, email: session.user.email, name: r.data.name || session.user.email };
    role = r.data.role || "editor";
    try { await loadAll(); } catch (e) { showGate('<p style="margin:0">Не удалось загрузить данные: ' + esc(e.message) + "</p>"); return; }
    realtime(); hideGate(); resolveReady(true);
  }
  async function start() {
    if (!sb) { resolveReady(false); return; }
    sb.auth.onAuthStateChange(function (ev, s) { if (s && (ev === "SIGNED_IN" || ev === "INITIAL_SESSION")) afterLogin(s); });
    var res = await sb.auth.getSession();
    if (res.data && res.data.session) afterLogin(res.data.session);
    else loginForm();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
