// @ts-nocheck
/*
 * Somni Контент — MCP-сервер для Claude.
 * Работает как Supabase Edge Function и читает/пишет ту же таблицу docs, что и сайт.
 * Адрес для Claude: https://<ref>.supabase.co/functions/v1/somni-mcp/<SOMNI_MCP_KEY>
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SECRET = Deno.env.get("SOMNI_MCP_KEY") || "";
const BY = "claude";

/* ---------------- справочники ---------------- */
const STREAMS = { N: "Ночь", D: "День", ND: "Оба" };
const STATUSES = { plan: "План", script: "Сценарий", prod: "Производство", ready: "Готово", live: "Опубликовано" };
const VERDICTS = { hit: "Залетело", ok: "Нормально", miss: "Не залетело" };
const FORMATS = { F1: "Ночной POV", F2: "Метод с Lumi", F3: "Говорящая голова", F4: "Экран приложения", F5: "Стоп-кадр вне темы", F6: "Карусель" };
const METRIC_KEYS = ["views", "reach", "skip", "avgWatch", "saves", "shares", "comments", "profile", "follows", "keywords", "clicks", "installs"];
const POST_FIELDS = ["title", "date", "time", "stream", "format", "kind", "length", "week", "hook", "hookText", "hookNote", "hookTrial", "trialNote",
  "body", "cta", "test", "status", "verdict", "verdictNote", "cols", "scenes", "caption", "production", "prompts", "igUrl", "media", "m48", "m7"];
const REEL_COLS = ["Время", "Визуал", "Текст на экране", "Голос Lumi"];

/* ---------------- доступ к данным ---------------- */
async function list(coll) {
  const out = []; let from = 0;
  for (;;) {
    const r = await sb.from("docs").select("id,data").eq("coll", coll).range(from, from + 999);
    if (r.error) throw new Error(r.error.message);
    r.data.forEach((x) => out.push(Object.assign({ id: x.id }, x.data)));
    if (r.data.length < 1000) break; from += 1000;
  }
  return out;
}
async function get(coll, id) {
  const r = await sb.from("docs").select("data").eq("coll", coll).eq("id", id).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return r.data ? Object.assign({ id }, r.data.data) : null;
}
async function put(coll, id, data) {
  const r = await sb.from("docs").upsert({ coll, id, data, updated_at: new Date().toISOString() });
  if (r.error) throw new Error(r.error.message);
}
async function patch(coll, id, p) {
  const r = await sb.rpc("docs_patch", { p_coll: coll, p_id: id, p_patch: Object.assign({}, p, { updatedAt: now(), updatedBy: BY }) });
  if (r.error) throw new Error(r.error.message === "not found" ? `Запись ${coll}/${id} не найдена` : r.error.message);
}
async function del(coll, id) {
  const r = await sb.from("docs").delete().eq("coll", coll).eq("id", id);
  if (r.error) throw new Error(r.error.message);
}
const now = () => new Date().toISOString();
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const pad = (n) => String(n).padStart(2, "0");
let selfReady = false;
async function ensureSelf() { if (selfReady) return; await put("people", BY, { name: "Claude", role: "editor" }); selfReady = true; }
async function log(text, ref) { await ensureSelf(); await put("log", rid(), { at: now(), by: BY, text, ref: ref || "" }); }

/* ---------------- время ---------------- */
function parseD(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); }
const iso = (d) => d.toISOString().slice(0, 10);
function firstSunday(y, m) { const dw = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + (7 - dw) % 7; }
function etOffset(date) { const d = parseD(date); const y = d.getUTCFullYear();
  const s = Date.UTC(y, 2, firstSunday(y, 2) + 7), e = Date.UTC(y, 10, firstSunday(y, 10));
  return d.getTime() >= s && d.getTime() < e ? -4 : -5; }
function msk(date, time) {
  if (!date || !time) return "";
  const [h, mi] = time.split(":").map(Number); const d = parseD(date);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi) - etOffset(date) * 3600e3 + 3 * 3600e3);
  return `${iso(m)} ${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}`;
}
function todayIso() { return iso(new Date()); }

/* ---------------- помощники ---------------- */
async function currentCampaign(id) {
  const camps = await list("campaigns");
  if (id) { const c = camps.find((x) => x.id === id); if (!c) throw new Error(`Кампания ${id} не найдена`); return { c, camps }; }
  const t = todayIso();
  const sorted = camps.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const c = sorted.find((x) => x.start && x.end && t >= x.start && t <= x.end) || sorted.find((x) => x.start && x.start > t) || sorted[sorted.length - 1];
  return { c, camps };
}
async function findPost(idOrCode, campaignId) {
  let p = await get("posts", idOrCode); if (p) return p;
  const posts = (await list("posts")).filter((x) => x.code === idOrCode);
  if (!posts.length) throw new Error(`Публикация ${idOrCode} не найдена. Посмотрите список через list_posts.`);
  if (posts.length === 1) return posts[0];
  const { c } = await currentCampaign(campaignId);
  return posts.find((x) => x.campaign === c?.id) || posts[0];
}
function normScenes(sc) {
  if (!Array.isArray(sc)) throw new Error("scenes должен быть массивом строк сценария");
  return sc.map((r) => { const arr = Array.isArray(r) ? r : Array.isArray(r?.c) ? r.c : [r?.time, r?.visual, r?.text, r?.voice];
    return { c: [0, 1, 2, 3].map((i) => String(arr[i] ?? "")) }; });
}
function cleanPostFields(f) {
  const out = {};
  for (const k of Object.keys(f || {})) {
    if (!POST_FIELDS.includes(k)) throw new Error(`Поле ${k} нельзя менять. Доступны: ${POST_FIELDS.join(", ")}`);
    out[k] = f[k];
  }
  if (out.scenes) out.scenes = normScenes(out.scenes);
  if (out.stream && !STREAMS[out.stream]) throw new Error("stream: N (Ночь) или D (День)");
  if (out.status && !STATUSES[out.status]) throw new Error(`status: ${Object.keys(STATUSES).join(", ")}`);
  if (out.verdict && !VERDICTS[out.verdict]) throw new Error(`verdict: ${Object.keys(VERDICTS).join(", ")} или пустая строка`);
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error("date в формате YYYY-MM-DD, по Нью-Йорку");
  if (out.time && !/^\d{2}:\d{2}$/.test(out.time)) throw new Error("time в формате HH:MM, по Нью-Йорку");
  if (out.week != null) out.week = Number(out.week);
  return out;
}
function postBrief(p) {
  return { id: p.id, code: p.code, campaign: p.campaign, week: p.week, date: p.date, time_et: p.time, time_msk: msk(p.date, p.time),
    stream: STREAMS[p.stream] || p.stream, format: p.format, kind: p.kind, title: p.title, hook: p.hook || null, hook_text: p.hookText || undefined,
    body: p.body, cta: p.cta, test: p.test, status: STATUSES[p.status] || p.status, verdict: VERDICTS[p.verdict] || undefined,
    has_metrics: METRIC_KEYS.some((k) => typeof p.m7?.[k] === "number" || typeof p.m48?.[k] === "number") };
}
function nextCode(posts, campaign, week) {
  const nums = posts.filter((p) => p.campaign === campaign && p.week === week).map((p) => parseInt(String(p.code).split("-")[1] || "0", 10)).filter((n) => !isNaN(n));
  return `${week}-${pad((nums.length ? Math.max(...nums) : 0) + 1)}`;
}
function weekStart(c, n) { if (!c?.start) return ""; const d = parseD(c.start); d.setUTCDate(d.getUTCDate() + (n - 1) * 7); return iso(d); }
const LIB = { hooks: { coll: "hooks", prefix: "H-", pad: 2 }, bodies: { coll: "bodies", prefix: "B-", pad: 2 }, rtb: { coll: "bodies", prefix: "R-", pad: 0 }, ctas: { coll: "ctas", prefix: "C-", pad: 2 } };

/* ---------------- инструменты ---------------- */
const S = (props, required) => ({ type: "object", properties: props, required: required || [], additionalProperties: false });
const str = (d) => ({ type: "string", description: d });
const num = (d) => ({ type: "number", description: d });

const TOOLS = [
  { name: "somni_overview", description: "Сводка контент-плана Somni: кампании и недели, публикации на ближайшие 7 дней, статусы, новые идеи, статусы хуков и пороги метрик. Начинайте с этого инструмента.",
    inputSchema: S({ campaign: str("ID кампании. По умолчанию текущая") }),
    run: async (a) => {
      const { c, camps } = await currentCampaign(a.campaign);
      const posts = await list("posts"); const cp = posts.filter((p) => p.campaign === c?.id);
      const t = todayIso(), t7 = iso(new Date(Date.now() + 7 * 864e5));
      const byStatus = {}; cp.forEach((p) => { const k = STATUSES[p.status] || p.status; byStatus[k] = (byStatus[k] || 0) + 1; });
      const ideas = await list("ideas"); const hooks = await list("hooks"); const thr = await get("settings", "thresholds");
      const hs = {}; hooks.forEach((h) => { hs[h.status || "test"] = (hs[h.status || "test"] || 0) + 1; });
      return { campaigns: camps.map((x) => ({ id: x.id, name: x.name, start: x.start, end: x.end })),
        current: c ? { id: c.id, name: c.name, start: c.start, end: c.end, goal: c.goal, weeks: c.weeks } : null,
        posts_total: cp.length, by_status: byStatus,
        next_7_days: posts.filter((p) => p.date && p.date >= t && p.date <= t7).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time)).map(postBrief),
        new_ideas: ideas.filter((i) => (i.status || "new") === "new").length, hooks_by_status: hs,
        thresholds: thr?.items || [],
        notes: "Время публикаций хранится по Нью-Йорку (ET). Коды: H — хук, B — тело, R — строка доверия, C — призыв, F1–F6 — формат. Потоки: N — Ночь, D — День." };
    } },
  { name: "list_posts", description: "Список публикаций с фильтрами. Возвращает краткие карточки: код, дата и время (ET и МСК), поток, формат, название, коды хука, тела и призыва, статус.",
    inputSchema: S({ campaign: str("ID кампании, по умолчанию текущая. 'all' — все"), week: num("Номер недели"), stream: str("N или D"), status: str("plan, script, prod, ready, live"),
      date_from: str("YYYY-MM-DD"), date_to: str("YYYY-MM-DD"), query: str("Поиск по названию, хуку, подписи") }),
    run: async (a) => {
      let posts = await list("posts");
      if (a.campaign !== "all") { const { c } = await currentCampaign(a.campaign); posts = posts.filter((p) => p.campaign === c?.id); }
      if (a.week != null) posts = posts.filter((p) => p.week === Number(a.week));
      if (a.stream) posts = posts.filter((p) => p.stream === a.stream);
      if (a.status) posts = posts.filter((p) => p.status === a.status);
      if (a.date_from) posts = posts.filter((p) => p.date && p.date >= a.date_from);
      if (a.date_to) posts = posts.filter((p) => p.date && p.date <= a.date_to);
      if (a.query) { const q = a.query.toLowerCase(); posts = posts.filter((p) => [p.code, p.title, p.hookText, p.caption, p.test].join(" ").toLowerCase().includes(q)); }
      return posts.sort((x, y) => ((x.date || "") + (x.time || "")).localeCompare((y.date || "") + (y.time || ""))).map(postBrief);
    } },
  { name: "get_post", description: "Полная карточка публикации: сценарий по сценам, подпись, производство, промпты, медиа, метрики за 48 часов и 7 дней, комментарии. Тексты хука, тела и призыва подставлены из библиотек.",
    inputSchema: S({ id: str("ID или код публикации, например 1-03") }, ["id"]),
    run: async (a) => {
      const p = await findPost(a.id);
      const hook = p.hook ? await get("hooks", p.hook) : null; const cta = p.cta ? await get("ctas", p.cta) : null;
      const codes = String(p.body || "").match(/\b(?:B-\d{2}|R-\d)\b/g) || [];
      const bodies = []; for (const c of codes) { const b = await get("bodies", c); if (b) bodies.push({ code: c, title: b.title, content: b.content }); }
      const comments = (await list("comments")).filter((c) => c.post === p.id).sort((x, y) => (x.at || "").localeCompare(y.at || ""));
      return Object.assign({}, p, { time_msk: msk(p.date, p.time), hook_resolved: hook ? { code: hook.code, text: hook.text, frame: hook.frame } : null,
        bodies_resolved: bodies, cta_resolved: cta ? { code: cta.code, text: cta.text } : null,
        comments: comments.map((c) => ({ id: c.id, text: c.text, at: c.at, by: c.by })) });
    } },
  { name: "create_post", description: "Создать публикацию в неделе кампании. Код присваивается сам (неделя-номер). Время — по Нью-Йорку. Сценарий можно передать сразу: scenes — массив строк [время, визуал, текст на экране, голос].",
    inputSchema: S({ campaign: str("ID кампании, по умолчанию текущая"), week: num("Номер недели"), title: str("Название"), date: str("YYYY-MM-DD по Нью-Йорку"), time: str("HH:MM по Нью-Йорку"),
      stream: str("N или D"), format: str("F1–F6"), kind: str("Рилс, Карусель и т. п."), length: str("Длина, например 20 с"), hook: str("Код хука H-xx"), hookText: str("Свой текст хука, если его нет в базе"),
      body: str("Коды тела, например B-02 + R-1"), cta: str("Код призыва C-xx"), test: str("Что проверяем"), status: str("plan, script, prod, ready, live"),
      scenes: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Строки сценария: [время, визуал, текст на экране, голос]" },
      cols: { type: "array", items: { type: "string" }, description: "4 заголовка колонок сценария" },
      caption: str("Подпись к посту (EN)"), production: str("Что и где делать"), prompts: { type: "array", items: { type: "string" } } }, ["week", "title"]),
    run: async (a) => {
      const { c } = await currentCampaign(a.campaign); if (!c) throw new Error("Нет кампаний");
      const week = Number(a.week); const posts = await list("posts"); const code = nextCode(posts, c.id, week);
      let id = c.id === "nov-2026" ? code : `${c.id}-w${code}`; if (posts.some((p) => p.id === id)) id += "-" + rid().slice(0, 5);
      const f = cleanPostFields(Object.fromEntries(Object.entries(a).filter(([k]) => k !== "campaign" && k !== "week")));
      const data = Object.assign({ code, campaign: c.id, week, order: 999, date: weekStart(c, week), time: "23:30", stream: "N", format: "", kind: "Рилс", title: "", length: "",
        hook: "", hookText: "", hookNote: "", hookTrial: "", trialNote: "", body: "", cta: "", test: "", status: "plan", verdict: "", verdictNote: "",
        cols: REEL_COLS, scenes: [], caption: "", production: "", prompts: [], media: [], igUrl: "", m48: {}, m7: {}, updatedAt: now(), updatedBy: BY, createdBy: BY }, f);
      await put("posts", id, data); await log(`добавил(а) публикацию ${code}`, id);
      return { created: postBrief(Object.assign({ id }, data)) };
    } },
  { name: "update_post", description: "Изменить поля публикации. Передавайте только то, что меняется. scenes и prompts заменяются целиком. m48 и m7 (метрики) сливаются с уже внесёнными. Поля: " + POST_FIELDS.join(", "),
    inputSchema: S({ id: str("ID или код публикации"), fields: { type: "object", description: "Поля для изменения" } }, ["id", "fields"]),
    run: async (a) => {
      const p = await findPost(a.id); const f = cleanPostFields(a.fields);
      await patch("posts", p.id, f); await log(`изменил(а) ${Object.keys(f).join(", ")} в ${p.code}`, p.id);
      return { updated: p.id, code: p.code, fields: Object.keys(f) };
    } },
  { name: "set_metrics", description: "Внести метрики публикации за 48 часов или за 7 дней. Проценты (skip, avgWatch) — числом без знака %.",
    inputSchema: S({ id: str("ID или код публикации"), period: { type: "string", enum: ["48h", "7d"] }, views: num("Просмотры"), reach: num("Охват"),
      skip: num("Пропуски в первые 3 с, %"), avgWatch: num("Средний просмотр, % длины"), saves: num("Сохранения"), shares: num("Пересылки"), comments: num("Комментарии"),
      profile: num("Переходы в профиль"), follows: num("Подписки"), keywords: num("Кодовые слова"), clicks: num("Клики по ссылке"), installs: num("Установки") }, ["id", "period"]),
    run: async (a) => {
      const p = await findPost(a.id); const m = {}; METRIC_KEYS.forEach((k) => { if (typeof a[k] === "number") m[k] = a[k]; });
      if (!Object.keys(m).length) throw new Error("Передайте хотя бы одну метрику");
      const col = a.period === "7d" ? "m7" : "m48"; await patch("posts", p.id, { [col]: m });
      await log(`внёс(ла) метрики ${p.code} за ${a.period === "7d" ? "7 дней" : "48 часов"}`, p.id);
      return { updated: p.code, period: a.period, metrics: m };
    } },
  { name: "delete_post", description: "Удалить публикацию насовсем. Перед удалением уточните у пользователя.",
    inputSchema: S({ id: str("ID или код публикации") }, ["id"]),
    run: async (a) => { const p = await findPost(a.id); await del("posts", p.id); await log(`удалил(а) публикацию ${p.code}`); return { deleted: p.code }; } },
  { name: "list_library", description: "Библиотеки: hooks — хуки (первые 3 секунды), bodies — тела, rtb — строки доверия, ctas — призывы. Для хуков есть статус: test, works, weak, arch.",
    inputSchema: S({ kind: { type: "string", enum: ["hooks", "bodies", "rtb", "ctas"] }, status: str("Фильтр по статусу хука"), group: str("Группа хука A–H") }, ["kind"]),
    run: async (a) => {
      const L = LIB[a.kind]; let items = await list(L.coll);
      if (L.coll === "bodies") items = items.filter((b) => String(b.code || b.id).startsWith(L.prefix));
      if (a.status) items = items.filter((x) => (x.status || "test") === a.status);
      if (a.group) items = items.filter((x) => x.group === a.group);
      return items.sort((x, y) => String(x.code).localeCompare(String(y.code), "en", { numeric: true })).map((x) => { const o = Object.assign({}, x); delete o.updatedAt; delete o.updatedBy; delete o.order; return o; });
    } },
  { name: "upsert_library_item", description: "Добавить или изменить элемент библиотеки. Без code создаётся новый со следующим кодом. Поля хука: text, frame, group (A–H), stream (N, D, ND), source, status (test, works, weak, arch), note. Тела: title, kind (night, day), content, why, rtb, screens, length, formats, note. Призыва: text, gives, stream, metric, note.",
    inputSchema: S({ kind: { type: "string", enum: ["hooks", "bodies", "rtb", "ctas"] }, code: str("Код, например H-12. Пусто — новый"), fields: { type: "object" } }, ["kind", "fields"]),
    run: async (a) => {
      const L = LIB[a.kind]; const f = Object.assign({}, a.fields || {}); delete f.code; delete f.id;
      let code = a.code;
      if (code) { const cur = await get(L.coll, code); if (cur) { await patch(L.coll, code, f); await log(`изменил(а) ${code}`); return { updated: code }; } }
      if (!code) { const items = (await list(L.coll)).map((x) => x.id).filter((id) => id.startsWith(L.prefix)).map((id) => parseInt(id.slice(2), 10)).filter((n) => !isNaN(n));
        const n = (items.length ? Math.max(...items) : 0) + 1; code = L.prefix + (L.pad ? pad(n) : String(n)); }
      const base = a.kind === "hooks" ? { group: "A", text: "", frame: "", stream: "N", source: "", status: "test", note: "" }
        : a.kind === "ctas" ? { text: "", gives: "", stream: "ND", metric: "", status: "test", note: "" }
        : { kind: a.kind === "rtb" ? "rtb" : "night", title: a.kind === "rtb" ? "Строка RTB" : "", content: "", why: "", rtb: "", screens: "", length: "", formats: "", note: "" };
      await put(L.coll, code, Object.assign(base, f, { code, order: 999, updatedAt: now(), updatedBy: BY })); await log(`добавил(а) ${code}`);
      return { created: code };
    } },
  { name: "get_strategy", description: "Вся контент-стратегия в Markdown, по разделам с их ID.",
    inputSchema: S({}),
    run: async () => (await list("strategy")).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => ({ id: s.id, title: s.title, body: s.body, updatedAt: s.updatedAt, versions: (s.history || []).length })) },
  { name: "update_strategy_section", description: "Изменить или создать раздел стратегии. body — Markdown (таблицам нужна строка | --- | под заголовком). Старая версия сохраняется в истории раздела. Без id создаётся новый раздел в конце.",
    inputSchema: S({ id: str("ID раздела из get_strategy"), title: str("Название раздела"), body: str("Текст раздела в Markdown") }),
    run: async (a) => {
      if (a.id) { const s = await get("strategy", a.id);
        if (s) { const hist = [...(s.history || []), { at: s.updatedAt || now(), by: s.updatedBy || null, title: s.title, body: s.body }].slice(-15);
          const p = { history: hist }; if (a.title != null) p.title = a.title; if (a.body != null) p.body = a.body;
          await patch("strategy", a.id, p); await log(`обновил(а) раздел стратегии «${a.title || s.title}»`); return { updated: a.id }; } }
      const all = await list("strategy"); const order = Math.max(0, ...all.map((s) => s.order || 0)) + 1; const id = a.id || "s-" + rid().slice(0, 8);
      await put("strategy", id, { title: a.title || "Новый раздел", body: a.body || "", order, updatedAt: now(), updatedBy: BY, history: [] });
      await log(`добавил(а) раздел стратегии «${a.title || "Новый раздел"}»`); return { created: id };
    } },
  { name: "update_threshold", description: "Изменить порог метрики. key: skip, avgWatch, saveShare, commentRate, profileRate, kwPer1000, installRate.",
    inputSchema: S({ key: str("Ключ метрики"), good: num("Хороший порог"), bad: num("Плохой порог") }, ["key"]),
    run: async (a) => {
      const t = await get("settings", "thresholds"); const items = (t?.items || []).map((x) => Object.assign({}, x)); const it = items.find((x) => x.key === a.key);
      if (!it) throw new Error("Нет такого порога. Ключи: " + items.map((x) => x.key).join(", "));
      if (typeof a.good === "number") it.good = a.good; if (typeof a.bad === "number") it.bad = a.bad;
      await put("settings", "thresholds", { items }); await log(`изменил(а) порог «${it.label}»`); return it;
    } },
  { name: "list_ideas", description: "Идеи команды. status: new, take, planned, later.",
    inputSchema: S({ status: str("Фильтр по статусу") }),
    run: async (a) => (await list("ideas")).filter((i) => !a.status || (i.status || "new") === a.status).sort((x, y) => (y.at || "").localeCompare(x.at || "")) },
  { name: "add_idea", description: "Добавить идею в банк идей.",
    inputSchema: S({ text: str("Текст идеи, можно Markdown"), kind: { type: "string", enum: ["Хук", "Тело", "Формат", "Тема", "Призыв", "Другое"] }, stream: { type: "string", enum: ["N", "D", "ND"] } }, ["text"]),
    run: async (a) => { await ensureSelf(); const id = rid(); await put("ideas", id, { text: a.text, kind: a.kind || "Другое", stream: a.stream || "ND", status: "new", by: BY, at: now(), post: "" }); await log("добавил(а) идею"); return { created: id }; } },
  { name: "update_idea", description: "Изменить идею: статус (new, take, planned, later), текст или связанную публикацию.",
    inputSchema: S({ id: str("ID идеи"), status: str("Статус"), text: str("Текст"), post: str("ID публикации") }, ["id"]),
    run: async (a) => { const p = {}; ["status", "text", "post"].forEach((k) => { if (a[k] != null) p[k] = a[k]; }); await patch("ideas", a.id, p); return { updated: a.id }; } },
  { name: "add_comment", description: "Оставить комментарий к публикации от имени Claude. Можно Markdown.",
    inputSchema: S({ post_id: str("ID или код публикации"), text: str("Текст комментария") }, ["post_id", "text"]),
    run: async (a) => { await ensureSelf(); const p = await findPost(a.post_id); const id = rid(); await put("comments", id, { post: p.id, text: a.text, by: BY, at: now() }); await log(`прокомментировал(а) ${p.code}`, p.id); return { created: id }; } },
  { name: "create_campaign", description: "Создать новую кампанию с неделями. Стратегия и библиотеки общие для всех кампаний.",
    inputSchema: S({ name: str("Название, например «Декабрь 2026»"), start: str("Первый день, понедельник, YYYY-MM-DD"), weeks: num("Сколько недель"), goal: str("Цель кампании") }, ["name", "start"]),
    run: async (a) => {
      const n = Math.max(1, Math.min(12, Number(a.weeks) || 4)); const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
      const weeks = []; for (let i = 1; i <= n; i++) { const s = parseD(a.start); s.setUTCDate(s.getUTCDate() + (i - 1) * 7); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6);
        weeks.push({ n: i, dates: `${s.getUTCDate()} ${months[s.getUTCMonth()]} — ${e.getUTCDate()} ${months[e.getUTCMonth()]}`, title: "" }); }
      const end = parseD(a.start); end.setUTCDate(end.getUTCDate() + n * 7 - 1);
      const id = "c-" + Date.now().toString(36); const camps = await list("campaigns");
      await put("campaigns", id, { name: a.name, subtitle: "", start: a.start, end: iso(end), goal: a.goal || "", weeks, summary: "", order: camps.length + 1, createdAt: now(), createdBy: BY });
      await log(`создал(а) кампанию «${a.name}»`); return { created: id, weeks };
    } },
  { name: "update_campaign", description: "Изменить кампанию: name, goal, summary (итоги), или тему недели через week_titles {номер: тема}.",
    inputSchema: S({ id: str("ID кампании"), name: str("Название"), goal: str("Цель"), summary: str("Итоги кампании в Markdown"), week_titles: { type: "object", description: "Например {\"1\": \"Ночной метод против дневного\"}" } }, ["id"]),
    run: async (a) => {
      const c = await get("campaigns", a.id); if (!c) throw new Error("Кампания не найдена");
      const p = {}; ["name", "goal", "summary"].forEach((k) => { if (a[k] != null) p[k] = a[k]; });
      if (a.week_titles) p.weeks = (c.weeks || []).map((w) => a.week_titles[String(w.n)] != null ? Object.assign({}, w, { title: a.week_titles[String(w.n)] }) : w);
      await patch("campaigns", a.id, p); await log(`изменил(а) кампанию «${a.name || c.name}»`); return { updated: a.id };
    } },
  { name: "get_history", description: "Последние изменения на сайте: кто и что менял.",
    inputSchema: S({ limit: num("Сколько записей, по умолчанию 30") }),
    run: async (a) => {
      const people = Object.fromEntries((await list("people")).map((p) => [p.id, p.name]));
      return (await list("log")).sort((x, y) => (y.at || "").localeCompare(x.at || "")).slice(0, Number(a.limit) || 30).map((l) => ({ at: l.at, who: people[l.by] || "Участник", text: l.text, ref: l.ref || undefined }));
    } },
];

/* ---------------- протокол MCP ---------------- */
const INSTRUCTIONS = "Контент-план Instagram для Somni — приложения о сне для женщин 40+ в США. Публикация собирается из хука (H-xx, первые 3 секунды), тела (B-xx, плюс строка доверия R-x) и призыва (C-xx). Потоки: N — Ночь, D — День. Форматы F1–F6. Даты и время хранятся по Нью-Йорку. Начинайте с somni_overview, перед правкой читайте get_post. Тексты на экране и подписи — на английском, пояснения команде — на русском.";
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-client-info, apikey", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });

async function rpc(msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!method) return fail(-32600, "Invalid Request");
  if (id === undefined || id === null) return null; // уведомление
  if (method === "initialize") {
    const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0];
    return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "somni-content", version: "1.0.0" }, instructions: INSTRUCTIONS });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(-32602, `Неизвестный инструмент ${params?.name}`);
    try {
      const res = await tool.run(params.arguments || {});
      return ok({ content: [{ type: "text", text: JSON.stringify(res, null, 1) }] });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "Ошибка: " + (e?.message || String(e)) }], isError: true });
    }
  }
  return fail(-32601, `Метод ${method} не поддерживается`);
}

export async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const key = url.pathname.split("/").filter(Boolean).pop() || "";
  const qkey = url.searchParams.get("key") || "";
  if (!SECRET || (key !== SECRET && qkey !== SECRET)) return json({ error: "Неверный ключ доступа" }, 401);
  if (req.method !== "POST") return json({ error: "Используйте POST" }, 405);
  let body; try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) { const out = (await Promise.all(body.map(rpc))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202, headers: CORS }); }
  const out = await rpc(body);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}

Deno.serve(handle);
