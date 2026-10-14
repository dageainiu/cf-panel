const SECH={"Strict-Transport-Security":"max-age=31536000; includeSubDomains","X-Content-Type-Options":"nosniff","X-Frame-Options":"SAMEORIGIN","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"geolocation=(), microphone=(), camera=()","Content-Security-Policy":"default-src \x27self\x27; img-src \x27self\x27 data:; style-src \x27self\x27 \x27unsafe-inline\x27; script-src \x27self\x27 \x27unsafe-inline\x27; connect-src \x27self\x27; frame-ancestors \x27self\x27; base-uri \x27self\x27; form-action \x27self\x27"};
import { EmailMessage } from "cloudflare:email";
// Status / security monitor for panel.example.com
// Served under /status via portal (portal rewrites /status -> / , /status/* -> /*).
// Bindings (+ GUARD_TOKEN secret: audit read + DNS edit on this zone, for 令牌异常自动处置): LOG (kv), CFK (kv, cfnext config: only config.outboundProxy is ever written, by proxy failover), CFNEXT/DRIVE/OTP (service), optional CF_ZONE_ID + CF_ANALYTICS_TOKEN (plain/secret)
//           DB (d1, panel-log: events + health), MAIL (send_email -> verified destination)

const SVC_HARD = true; // phase flag: false=soft, true=hard (require x-svc-key)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    // External push from GitHub Actions (domain-guard). Not behind the portal x-svc-key gate,
    // but authenticated by its own shared secret (x-ci-key == env.CI_REPORT_KEY, constant-time).
    if (p === "/api/ci-report") return ciReport(request, env);
    // Proxy health / outbound failover report from the same GitHub Actions job (same x-ci-key auth).
    if (p === "/api/proxy-health") return proxyHealthApi(request, env);
    // 令牌异常自动处置: on-demand scan (hourly GitHub monitor nudge / tests) and 每日报告 trigger. Same x-ci-key auth.
    if (p === "/api/guard-scan") return guardScanApi(request, env);
    if (p === "/api/daily-report") return dailyApi(request, env);
    // 订阅泄露检测: on-demand scan (tests / GitHub). Same x-ci-key auth; {dry:true} = compute only (no state, no email).
    if (p === "/api/leak-scan") return leakScanApi(request, env);
    // Batch B: 节点优选 IP (GitHub ip-opt), 「立即优选」 queue (GitHub monitor), 域名与证书 (GitHub domain-check). Same x-ci-key auth.
    if (p === "/api/ip-opt") return ipOptApi(request, env);
    if (p === "/api/ip-opt-pending") return ipOptPendingApi(request, env);
    if (p === "/api/domain-check") return domainCheckApi(request, env);
    // On the workers.dev hostname only the CI push endpoint exists (GitHub runners are challenged by
    // Bot Fight Mode on the main domain); everything else is reachable solely via the portal service binding.
    if (url.hostname.endsWith(".workers.dev")) return new Response("not found", { status: 404 });
    const _k = request.headers.get("x-svc-key");
    if (!(await keyOk(_k, env.SVC_KEY))) return new Response("forbidden", { status: 403 }); // L3: constant-time
    try {
      if (p === "/api/mail-delivery") return json(await mailDelivery(env, Number(url.searchParams.get("since")) || 0));
      if (p === "/api/overview") return json(await overview(env));
      if (p === "/api/cf") return json(await cfAnalytics(env));
      if (p === "/api/uptime") return json(await uptimeData(env));
      if (p.startsWith("/api/guard/")) return guardApi(request, env, p);
      return new Response(PAGE, { headers: Object.assign({ "content-type": "text/html; charset=utf-8" }, SECH) });
    } catch (e) {
      // Keep details server-side only (CodeQL js/stack-trace-exposure).
      console.error("status worker error: " + String(e && e.stack || e));
      return json({ ok: false, error: "internal error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(healthCheck(env).catch(e => console.log("healthCheck failed: " + String(e && e.message || e))));
    ctx.waitUntil(bPrune(env, event && event.scheduledTime ? Number(event.scheduledTime) : Date.now()).catch(e => console.log("daily prune failed: " + String(e && e.message || e))));
    // 令牌异常自动处置: piggybacks on this 5-minute cron, runs when >= 15 min since the last scan (no extra cron trigger).
    // CFNext 配置版本: snapshot KV config every 5 minutes when it changed (any writer, incl. the CFNext panel itself).
    ctx.waitUntil((async () => { if (env.CFK) { const raw = await env.CFK.get("config"); if (raw) { const r = await cvSnapshot(env, raw, "定时检测到变化"); if (r && r.id && !r.skipped) console.log("config version saved #" + r.id); } } })().catch(e => console.log("config snapshot failed: " + String(e && e.message || e))));
    // 订阅泄露检测: hourly (self-throttled).
    ctx.waitUntil(leakScan(env, { cron: true }).then(r => { if (r && !r.skipped) console.log("leak scan: " + JSON.stringify({ ok: r.ok, status: r.status, mailed: r.mailed, error: r.error })); }, e => console.log("leak scan failed: " + String(e && e.message || e))));
    ctx.waitUntil(guardScan(env, { cron: true, source: "cron" }).then(r => { if (r && !r.skipped) console.log("guard scan: " + JSON.stringify({ ok: r.ok, scanned: r.scanned, flagged: r.flagged, deleted: r.deleted, error: r.error })); }, e => console.log("guard scan failed: " + String(e && e.message || e))));
  }
};

function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, SECH) });
}

// M7: probes hit a real API (drive /api/list -> GitHub, otp /api/latest -> Outlook Graph) and anything outside 200-399
// (or a JSON body with ok:false / err) counts as down. r.ok is the single verdict used by alerts, health_log and the page.
async function ping(binding, path, key, timeoutMs, check) {
  const t0 = Date.now();
  let timer;
  try {
    const p = (async () => {
      const res = await binding.fetch("https://panel.example.com" + path, { headers: key ? { "User-Agent": "status-monitor", "x-svc-key": key } : { "User-Agent": "status-monitor" } });
      let err = "";
      if (check && res.status >= 200 && res.status < 400) { try { err = check(await res.json()); } catch (e) { err = "返回内容不是 JSON"; } }
      else { try { await res.body?.cancel(); } catch (e) {} }
      return { res, err };
    })();
    const { res, err } = timeoutMs ? await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout " + timeoutMs + "ms")), timeoutMs); })]) : await p;
    const ok = res.status >= 200 && res.status < 400 && !err;
    return { up: true, ok, code: res.status, ms: Date.now() - t0, err: err || (ok ? "" : "HTTP " + res.status) };
  } catch (e) {
    return { up: false, ok: false, code: 0, ms: Date.now() - t0, err: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
const CHK_DRIVE = j => j && j.ok === true && Array.isArray(j.files) ? "" : "网盘接口返回异常：" + String(j && j.error || "").slice(0, 60);
const CHK_OTP = j => j && j.ok === true && !j.err ? "" : "读取邮箱失败：" + String(j && j.err || "").slice(0, 60);

async function pingUrl(url, timeoutMs) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "status-monitor" }, redirect: "manual", signal: ctl.signal, cf: { cacheTtl: 0 } });
    try { await res.body?.cancel(); } catch (e) {}
    return { up: true, ok: res.status === 200, code: res.status, ms: Date.now() - t0, err: res.status === 200 ? "" : "HTTP " + res.status };
  } catch (e) {
    return { up: false, ok: false, code: 0, ms: Date.now() - t0, err: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

function pingAll(env, timeoutMs) {
  return Promise.all([
    env.CFNEXT ? ping(env.CFNEXT, "/version", null, timeoutMs) : Promise.resolve({ up: false, ok: false, code: 0, ms: 0, err: "no binding" }),
    env.DRIVE ? ping(env.DRIVE, "/api/list", env.SVC_KEY, timeoutMs, CHK_DRIVE) : Promise.resolve({ up: false, ok: false, code: 0, ms: 0, err: "no binding" }),
    env.OTP ? ping(env.OTP, "/api/latest", env.SVC_KEY, timeoutMs, CHK_OTP) : Promise.resolve({ up: false, ok: false, code: 0, ms: 0, err: "no binding" })
  ]);
}

// ---- GitHub domain-guard CI push (single latest row in D1 ci_status, id=1) ----
const CI_MAX_BODY = 32768;
const CI_MAX_DETAILS = 16000; // per-check JSON array (~25 checks) fits comfortably
async function sha256(str) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))); }
async function keyOk(given, expected) {
  if (!given || !expected) return false;
  const a = await sha256(given), b = await sha256(expected); // equal-length digests
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
}
function ghUrl(u) { u = String(u || "").slice(0, 300); return /^https:\/\/github\.com\/[\w.\-\/#?=&%]+$/.test(u) ? u : ""; }
function toInt(n) { n = parseInt(n, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : 0; }
async function ciReport(request, env) {
  if (!(await keyOk(request.headers.get("x-ci-key"), env.CI_REPORT_KEY))) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  try {
    const raw = await request.text();
    if (raw.length > CI_MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);
    let b; try { b = JSON.parse(raw); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
    if (!b || typeof b !== "object") return json({ ok: false, error: "invalid body" }, 400);
    if (b.kind === "backup") return json(Object.assign({ ok: true }, await backupReport(env, b)));
    const c = String(b.conclusion || "").toLowerCase();
    const conclusion = c === "pass" || c === "success" ? "pass" : c === "fail" || c === "failure" ? "fail" : "unknown";
    const repo = /^[\w.\-]{1,100}\/[\w.\-]{1,100}$/.test(String(b.repo || "")) ? String(b.repo) : "";
    const runAt = String(b.run_at || "").slice(0, 40);
    const now = new Date().toISOString();
    // details: JSON string of the per-check array (or the array itself), else a plain-text summary (older workflow).
    let details = Array.isArray(b.details) ? JSON.stringify(b.details) : String(b.details || b.summary || "");
    if (details.length > CI_MAX_DETAILS) details = String(b.summary || "").slice(0, 2000) || details.slice(0, 2000);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS ci_status (id INTEGER PRIMARY KEY CHECK(id=1), run_at TEXT, conclusion TEXT, passed INT, failed INT, details TEXT, issue_url TEXT, run_url TEXT, repo TEXT, updated_at TEXT)").run();
    await env.DB.prepare("INSERT INTO ci_status (id, run_at, conclusion, passed, failed, details, issue_url, run_url, repo, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO UPDATE SET run_at = excluded.run_at, conclusion = excluded.conclusion, passed = excluded.passed, failed = excluded.failed, details = excluded.details, issue_url = excluded.issue_url, run_url = excluded.run_url, repo = excluded.repo, updated_at = excluded.updated_at")
      .bind(runAt || now, conclusion, toInt(b.passed), toInt(b.failed), details, ghUrl(b.issue_url), ghUrl(b.run_url), repo, now).run();
    return json({ ok: true });
  } catch (e) {
    console.error("ci-report error: " + String(e && e.stack || e));
    return json({ ok: false, error: "internal error" }, 500);
  }
}
// ---- Daily encrypted backup (GitHub Actions domain-guard `backup` workflow, POST /api/ci-report with kind=backup) ----
// Stored separately in D1 backup_status (id=1) so it never overwrites the hourly monitor row. Emails only on ok <-> failed changes.
async function backupReport(env, b) {
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS backup_status (id INTEGER PRIMARY KEY CHECK(id=1), run_at TEXT, conclusion TEXT, workers INT, d1_rows INT, changed INT, run_url TEXT, commit_url TEXT, updated_at TEXT)").run();
  const conclusion = String(b.conclusion || "").toLowerCase() === "pass" ? "pass" : "fail";
  const prev = await db.prepare("SELECT conclusion FROM backup_status WHERE id = 1").first().catch(() => null);
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO backup_status (id, run_at, conclusion, workers, d1_rows, changed, run_url, commit_url, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET run_at=excluded.run_at, conclusion=excluded.conclusion, workers=excluded.workers, d1_rows=excluded.d1_rows, changed=excluded.changed, run_url=excluded.run_url, commit_url=excluded.commit_url, updated_at=excluded.updated_at")
    .bind(String(b.run_at || "").slice(0, 40) || now, conclusion, toInt(b.workers), toInt(b.d1_rows), b.changed ? 1 : 0, ghUrl(b.run_url), ghUrl(b.commit_url), now).run();
  let mailed = false;
  if (((prev && prev.conclusion !== conclusion) || (!prev && conclusion !== "pass")) && await gateOk(env, "backup:" + conclusion, Date.now())) {
    try {
      const subject = conclusion === "pass" ? "[备份] 每日备份已恢复正常" : "[备份] 每日备份失败";
      const L = [conclusion === "pass" ? "GitHub 每日备份恢复正常。" : "GitHub 每日备份失败，请查看运行记录。", "", "运行记录：" + (ghUrl(b.run_url) || "—"), "时间：" + fmtCN(Date.now()), "查看：https://panel.example.com/status"];
      const mime = ["From: =?UTF-8?B?" + b64utf8("面板监控") + "?= <" + ALERT_FROM + ">", "To: <" + ALERT_TO + ">", "Subject: =?UTF-8?B?" + b64utf8(subject) + "?=",
        "Date: " + new Date().toUTCString().replace("GMT", "+0000"), "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>", "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64utf8(L.join("\r\n")).replace(/.{1,76}/g, "$&\r\n")].join("\r\n");
      if (env.DB) { await outboxMime(env, "backup", mime); mailed = true; }
    } catch (e) { console.log("backup mail failed: " + String(e && e.message || e)); }
  }
  return { kind: "backup", conclusion, mailed };
}
async function ciStatus(env) {
  if (!env.DB) return null;
  let row;
  try { row = await env.DB.prepare("SELECT run_at, conclusion, passed, failed, details, issue_url, run_url, repo, updated_at FROM ci_status WHERE id = 1").first(); } catch (e) { return null; }
  if (!row) return null;
  try { row.backup = await env.DB.prepare("SELECT run_at, conclusion, workers, d1_rows, changed, run_url, commit_url FROM backup_status WHERE id = 1").first(); } catch (e) { row.backup = null; }
  row.checks = parseChecks(row.details);
  if (row.checks) row.details = ""; // structured list replaces the text summary
  return row;
}
// Per-check array -> [{group,name,status:pass|fail|skip,note}] ; null if details is not such an array (older rows).
function parseChecks(d) {
  if (typeof d !== "string" || d.charAt(0) !== "[") return null;
  let a; try { a = JSON.parse(d); } catch (e) { return null; }
  if (!Array.isArray(a) || !a.length) return null;
  return a.slice(0, 100).filter(x => x && typeof x === "object" && x.name).map(x => {
    const st = ["pass", "fail", "skip"].includes(x.status) ? x.status : x.ok === true ? "pass" : x.ok === false ? "fail" : "skip";
    return { group: String(x.group || "").slice(0, 40), name: String(x.name).slice(0, 80), status: st, note: String(x.note || "").slice(0, 300) };
  });
}

async function overview(env) {
  const [[cf, dr, ot], ci, proxy, guard, daily, domain, ipopt] = await Promise.all([pingAll(env, 12000), ciStatus(env), proxyView(env), guardView(env), dailyView(env), domainView(env), ipOptView(env)]);
  const services = [
    { key: "portal", name: "入口 / 工作台", up: true, code: 200, ms: 0, note: "正在服务此面板" },
    { key: "cfnext", name: "cfnext 代理面板", up: cf.ok, code: cf.code, ms: cf.ms, note: cf.ok ? "" : cf.err },
    { key: "drive", name: "drive 网盘", up: dr.ok, code: dr.code, ms: dr.ms, note: dr.ok ? "" : dr.err },
    { key: "otp", name: "otp 验证码", up: ot.ok, code: ot.code, ms: ot.ms, note: ot.ok ? "" : ot.err }
  ];
  let health = null;
  if (env.DB) { try { health = (await env.DB.prepare("SELECT svc, up, fails, since, t, code, ms FROM health ORDER BY svc").all()).results || []; } catch (e) {} }
  if (env.DB) {
    try { return { ok: true, now: Date.now(), services, health, ci, proxy, guard, daily, domain, ipopt, security: await securityD1(env) }; } catch (e) {}
  }
  let counters = { authFail: 0, probes: 0, errors: 0, bots: 0, total: 0, byIp: {}, byCountry: {}, byPath: {} };
  let events = [];
  if (env.LOG) {
    try { const c = await env.LOG.get("counters"); if (c) counters = Object.assign(counters, JSON.parse(c)); } catch (e) {}
    try { const e2 = await env.LOG.get("events"); if (e2) events = JSON.parse(e2); } catch (e) {}
  }
  const topIp = topN(counters.byIp, 8);
  const topCountry = topN(counters.byCountry, 8);
  const topPath = topN(counters.byPath, 8).map(x => ({ k: maskUuid(x.k), v: x.v }));
  counters.byPath = {}; events = events.map(e => Object.assign({}, e, { path: maskUuid(e.path) }));
  return { ok: true, now: Date.now(), services, health, ci, proxy, security: { source: "kv", counters, topIp, topCountry, topPath, events: events.slice(-60).reverse() } };
}

// Same shape as the KV version, computed from D1 (aggregates over the last 7 days; most recent 200 events).
const BOT_WORDS = ["bot", "crawl", "spider", "scan", "curl", "wget", "python-requests", "libwww", "nikto", "sqlmap", "nmap", "masscan", "httpx", "zgrab", "go-http"];
const SEC_WINDOW_MS = 7 * 86400000;
// UUID-like path segments are never shown (the proxy path is a secret); the user's own proxy traffic (websocket 101,
// UUID paths, requests from our outbound exits) is not counted as 可疑事件.
const UUID_SEG = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
function maskUuid(p) { return String(p == null ? "" : p).replace(UUID_SEG, m => m.slice(0, 4) + "…(已隐藏)"); }
const SEC_OWN = "st <> 101 AND path NOT LIKE '%-____-____-____-%' AND path NOT LIKE '%(已隐藏)%' AND ip NOT IN (SELECT last_ip FROM outbound_pool WHERE last_ip IS NOT NULL AND last_ip <> '')";
async function securityD1(env) {
  const since = Date.now() - SEC_WINDOW_MS;
  const botExpr = BOT_WORDS.map(w => "ua LIKE '%" + w + "%'").join(" OR ");
  const db = env.DB;
  const W = "t >= ?1 AND " + SEC_OWN;
  const [agg, ips, paths, cos, ev] = await db.batch([
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(type = 'auth'), 0) AS authFail, COALESCE(SUM(type = 'probe'), 0) AS probes, COALESCE(SUM(st >= 400), 0) AS errors, COALESCE(SUM(" + botExpr + "), 0) AS bots FROM events WHERE " + W).bind(since),
    db.prepare("SELECT ip AS k, COUNT(*) AS v FROM events WHERE " + W + " AND ip <> '' GROUP BY ip ORDER BY v DESC LIMIT 8").bind(since),
    db.prepare("SELECT path AS k, COUNT(*) AS v FROM events WHERE " + W + " GROUP BY path ORDER BY v DESC LIMIT 8").bind(since),
    db.prepare("SELECT co AS k, COUNT(*) AS v FROM events WHERE " + W + " AND co <> '' GROUP BY co ORDER BY v DESC LIMIT 8").bind(since),
    db.prepare("SELECT t, type, ip, co, path, st, ua FROM events WHERE " + SEC_OWN + " ORDER BY t DESC, id DESC LIMIT 200")
  ]);
  const a = (agg.results && agg.results[0]) || {};
  const topIp = ips.results || [], topPath = (paths.results || []).map(x => ({ k: maskUuid(x.k), v: x.v })), topCountry = cos.results || [];
  const toObj = arr => { const o = {}; for (const x of arr) o[x.k] = x.v; return o; };
  const counters = { total: a.total || 0, authFail: a.authFail || 0, probes: a.probes || 0, errors: a.errors || 0, bots: a.bots || 0, byIp: toObj(topIp), byPath: toObj(topPath), byCountry: toObj(topCountry) };
  const events = (ev.results || []).map(e => Object.assign(e, { path: maskUuid(e.path) }));
  return { source: "d1", window: "7d", counters, topIp, topCountry, topPath, events };
}

// ---- Cron health check (every 5 min) + email alert on state change ----
const ALERT_TO = "<OWNER_EMAIL>";
const ALERT_FROM = "alert@panel.example.com";
const FAILS_TO_DOWN = 2; // consecutive failures before declaring down (avoids cold-start false alarms)
const SVC_NAMES = { cfnext: "cfnext 代理面板", drive: "drive 网盘", otp: "otp 验证码" };
const FAILS_TO_DOWN_SVC = {};
// Email noise rules (2026-10): state still flips after FAILS_TO_DOWN(_SVC) consecutive failures (status page / header),
// but the DOWN email is only sent once a service has been failing for MAIL_AFTER_FAILS checks,
// at most once per hour per service (D1 alert_gate). A recovery email is only sent if the down email went out (health.alerted).
const MAIL_AFTER_FAILS = {};
async function gateOk(env, k, now, windowMs) {
  if (!env.DB) return true;
  try {
    const r = await env.DB.prepare("INSERT INTO alert_gate (k, t, suppressed) VALUES (?1, ?2, 0) ON CONFLICT(k) DO UPDATE SET t = CASE WHEN ?2 - t >= ?3 THEN ?2 ELSE t END, suppressed = CASE WHEN ?2 - t >= ?3 THEN 0 ELSE suppressed + 1 END RETURNING t").bind(k, now, windowMs || 3600000).first();
    return !!r && Number(r.t) === now;
  } catch (e) { console.log("alert_gate failed: " + String(e && e.message || e)); return true; }
}
async function healthCheck(env) {
  const now = Date.now();
  const [cf, dr, ot] = await pingAll(env, 15000);
  const cur = { cfnext: cf, drive: dr, otp: ot };
  // Uptime history for the daily report (portal probed over the public hostname; not used for alerts).
  try { const po = await pingUrl("https://panel.example.com/", 10000); po.ok = po.up && po.code >= 200 && po.code < 400; await healthLog(env, Object.assign({ portal: po }, cur), now); } catch (e) { console.log("health_log failed: " + String(e && e.message || e)); }
  let prev = {};
  if (env.DB) {
    const rows = (await env.DB.prepare("SELECT svc, up, fails, since, alerted FROM health").all()).results || [];
    for (const r of rows) prev[r.svc] = { up: !!r.up, fails: r.fails || 0, since: r.since || now, alerted: !!r.alerted };
  }
  const next = {}, changes = [];
  for (const k of Object.keys(cur)) {
    const r = cur[k];
    const ok = !!r.ok;
    const p = prev[k] || { up: true, fails: 0, since: now, alerted: false };
    const n = { up: p.up, fails: ok ? 0 : (p.fails || 0) + 1, since: p.since, t: now, code: r.code, ms: r.ms, err: r.err || "", alerted: p.alerted };
    if (p.up && !ok && n.fails >= (FAILS_TO_DOWN_SVC[k] || FAILS_TO_DOWN)) { n.up = false; n.since = now; }
    else if (!p.up && ok) { n.up = true; n.since = now; if (p.alerted) changes.push({ k, to: "up", r, n, downFor: now - (p.since || now) }); n.alerted = false; }
    if (!n.up && !n.alerted && n.fails >= (MAIL_AFTER_FAILS[k] || FAILS_TO_DOWN_SVC[k] || FAILS_TO_DOWN)) {
      if (await gateOk(env, "svc_down:" + k, now)) { n.alerted = true; changes.push({ k, to: "down", r, n }); }
    }
    next[k] = n;
  }
  if (env.DB) {
    const st = env.DB.prepare("INSERT INTO health (svc, up, fails, since, t, code, ms, alerted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(svc) DO UPDATE SET up = excluded.up, fails = excluded.fails, since = excluded.since, t = excluded.t, code = excluded.code, ms = excluded.ms, alerted = excluded.alerted");
    await env.DB.batch(Object.entries(next).map(([k, n]) => st.bind(k, n.up ? 1 : 0, n.fails, n.since, n.t, n.code, n.ms, n.alerted ? 1 : 0)));
  }
  if (changes.length) {
    try { await sendAlert(env, changes, now); } catch (e) { console.log("alert send failed: " + String(e && e.message || e)); }
  }
  return { next, changes };
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fmtCN(ts) {
  return new Date(ts + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
}
function buildAlertMime(changes, now) {
  const subject = "[面板告警] " + changes.map(c => c.k + (c.to === "down" ? " 离线" : " 恢复")).join("，");
  const lines = ["panel.example.com 定时巡检（每 5 分钟）发现状态变化：", "（同一项目 1 小时内最多 1 封离线邮件；只有发过离线邮件才会发恢复邮件）", ""];
  for (const c of changes) {
    if (c.to === "down") lines.push("● " + (SVC_NAMES[c.k] || c.k) + "：离线（连续 " + c.n.fails + " 次检查失败，约 " + c.n.fails * 5 + " 分钟）HTTP " + c.r.code + (c.r.err ? " · " + c.r.err : ""));
    else lines.push("● " + (SVC_NAMES[c.k] || c.k) + "：已恢复 HTTP " + c.r.code + " · " + c.r.ms + "ms" + (c.downFor ? "（离线约 " + Math.max(1, Math.round(c.downFor / 60000)) + " 分钟）" : ""));
  }
  lines.push("", "时间：" + fmtCN(now), "查看：https://panel.example.com/status");
  const body = b64utf8(lines.join("\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    "From: =?UTF-8?B?" + b64utf8("面板监控") + "?= <" + ALERT_FROM + ">",
    "To: <" + ALERT_TO + ">",
    "Subject: =?UTF-8?B?" + b64utf8(subject) + "?=",
    "Date: " + new Date(now).toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body
  ].join("\r\n");
}
async function sendAlert(env, changes, now) {
  if (!env.DB) throw new Error("no DB binding");
  await outboxMime(env, "status", buildAlertMime(changes, now));
}

function topN(obj, n) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
}

async function cfAnalytics(env) {
  const zone = env.CF_ZONE_ID;
  const token = env.CF_ANALYTICS_TOKEN;
  if (!zone || !token) return { ok: true, configured: false };
  const day = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const query = `query($zone:String!,$day:String!){viewer{zones(filter:{zoneTag:$zone}){g:httpRequests1dGroups(limit:7,filter:{date_geq:$day},orderBy:[date_DESC]){dimensions{date} sum{requests cachedRequests bytes threats countryMap{clientCountryName requests threats} browserMap{pageViews uaBrowserFamily}}}}}}`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { zone, day } })
    });
    const data = await res.json();
    if (data.errors && data.errors.length) return { ok: false, configured: true, error: JSON.stringify(data.errors).slice(0, 300) };
    const z = ((((data.data || {}).viewer || {}).zones || [])[0]) || {};
    const g = z.g || [];
    let requests = 0, cached = 0, bytes = 0, threats = 0;
    const cmap = {}, bmap = {};
    for (const d of g) {
      const sm = d.sum || {};
      requests += sm.requests || 0; cached += sm.cachedRequests || 0; bytes += sm.bytes || 0; threats += sm.threats || 0;
      for (const c of (sm.countryMap || [])) { const k = c.clientCountryName || "?"; cmap[k] = cmap[k] || { requests: 0, threats: 0 }; cmap[k].requests += c.requests || 0; cmap[k].threats += c.threats || 0; }
      for (const b of (sm.browserMap || [])) { const k = b.uaBrowserFamily || "?"; bmap[k] = (bmap[k] || 0) + (b.pageViews || 0); }
    }
    const country = Object.entries(cmap).map(([k, v]) => ({ country: k, count: v.requests, threats: v.threats })).sort((a, b) => b.count - a.count).slice(0, 12);
    const BOTF = /curl|headless|wget|python|bot|crawl|unknown|go-http|scrapy|java|okhttp|libwww/i;
    const clients = Object.entries(bmap).map(([k, v]) => ({ name: k, count: v, bot: BOTF.test(k) })).sort((a, b) => b.count - a.count).slice(0, 12);
    const botViews = clients.filter(c => c.bot).reduce((a, c) => a + c.count, 0);
    return { ok: true, configured: true, window: "7d", totals: { requests, cachedRequests: cached, bytes, threats }, country, clients, botViews };
  } catch (e) {
    console.error("cfAnalytics error: " + String(e && e.stack || e));
    return { ok: false, configured: true, error: "analytics request failed" };
  }
}

const PAGE = String.raw`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全监控 · panel.example.com</title>
<style>
:root{--bg:#09090b;--card:#18181b;--card2:#18181b;--line:#27272a;--txt:#fafafa;--muted:#a1a1aa;--brand:#8b5cf6;--brand2:#a78bfa;--ok:#22c55e;--warn:#eab308;--err:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--txt);background:radial-gradient(1100px 650px at 88% -12%,rgba(122,92,255,.16),transparent 60%),radial-gradient(900px 600px at -5% 110%,rgba(91,140,255,.14),transparent 55%),var(--bg);min-height:100vh}
.wrap{max-width:1180px;margin:auto;padding:28px 22px 70px}
.top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:18px}
.mark{letter-spacing:.18em;text-transform:uppercase;font-size:11px;color:var(--muted)}
h1{font-weight:650;font-size:22px;margin-top:2px}
.ctrl{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:13px}
.btn{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--txt);border-radius:10px;padding:8px 14px;cursor:pointer;font:inherit;font-size:13px}
.btn.p{border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));font-weight:600;box-shadow:0 8px 22px rgba(91,140,255,.3)}
a{color:var(--brand);text-decoration:none}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,1fr)}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}
@media(max-width:860px){.g4,.g2,.g3{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.g4,.g2,.g3{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:0 4px 12px rgb(0 0 0 / 0.2);transition:all 0.2s cubic-bezier(0.4,0,0.2,1)}
.card:hover{border-color:#3f3f46;box-shadow:0 8px 24px rgb(0 0 0 / 0.3);transform:translateY(-2px)}
.card h3{font-size:13px;font-weight:600;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.tick{width:3px;height:13px;border-radius:2px;background:linear-gradient(var(--brand),var(--brand2))}
.svc{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px dashed var(--line)}
.svc:last-child{border-bottom:0}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:8px}
.dot.up{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.down{background:var(--err);box-shadow:0 0 8px var(--err)}
.mut{color:var(--muted);font-size:12px}
.stat{font-size:28px;font-weight:700}
.stat.err{color:var(--err)}.stat.warn{color:var(--warn)}.stat.ok{color:var(--ok)}.stat.b{color:var(--brand)}
.row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}
.bar{height:6px;border-radius:4px;background:linear-gradient(90deg,var(--brand),var(--brand2));margin-top:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 8px;font-size:12.5px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
th{color:var(--muted);font-weight:500;font-size:11.5px}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
.tag.f{color:var(--err);border-color:rgba(255,107,107,.4)}.tag.p{color:var(--warn);border-color:rgba(255,184,77,.4)}.tag.e{color:var(--muted)}
.sec{margin-top:18px}.sec>h2{font-size:14px;color:var(--muted);font-weight:600;margin:0 2px 10px}
.empty{color:var(--muted);font-size:13px;padding:10px 0}
.ci{display:grid;grid-template-columns:minmax(180px,240px) 1fr;gap:18px;align-items:start}
@media(max-width:560px){.ci{grid-template-columns:1fr}}
.ci .pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;font-weight:650;font-size:15px;border:1px solid var(--line)}
.ci .pill.ok{color:var(--ok);border-color:rgba(56,211,159,.4);background:rgba(56,211,159,.08)}
.ci .pill.err{color:var(--err);border-color:rgba(255,107,107,.45);background:rgba(255,107,107,.08)}
.ci .pill.unk{color:var(--muted)}
.ci .cnt{margin-top:12px;font-size:13px;color:var(--muted)}.ci .cnt b{font-size:20px;margin-right:2px}
.alert{color:var(--err)}.alert a{color:var(--err);text-decoration:underline}
.cks{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}
.cks .gh{font-size:12px;letter-spacing:.06em;color:var(--muted);margin:12px 0 6px}.cks .gh:first-child{margin-top:0}
.cks .gh.bad{color:var(--err);font-weight:650}
.cks .gl{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px 12px}
.ck{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.02);font-size:13px;line-height:1.4}
.ck .ic{flex:none;width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;margin-top:1px}
.ck.pass .ic{color:var(--ok);background:rgba(56,211,159,.14)}
.ck.fail{border-color:rgba(255,107,107,.5);background:rgba(255,107,107,.08)}.ck.fail .ic{color:var(--err);background:rgba(255,107,107,.18)}
.ck.skip .ic{color:var(--muted);background:rgba(255,255,255,.06)}
.ck .nt{display:block;color:var(--muted);font-size:12px;margin-top:2px;white-space:pre-wrap;word-break:break-word}
.ck.fail .nt{color:#ffb3b3}
.inp{background:var(--card2);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:8px 10px;font:inherit;font-size:13px;min-width:200px}
#gd td .btn{padding:3px 10px;font-size:12px}
.uprow{padding:10px 0 4px;border-bottom:1px dashed var(--line)}.uprow:last-of-type{border-bottom:0}
.uphd{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:13px;margin-bottom:6px}.uphd .dot{margin-right:6px}
.upsvg{width:100%;height:92px;display:block}
.gh2{font-size:12px;letter-spacing:.06em;color:var(--muted);margin:16px 0 8px}
.strip{display:flex;align-items:center;gap:10px;margin:4px 0;font-size:12px}.strip .snm{width:150px;flex:none;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strip .sd{display:flex;gap:3px;flex-wrap:wrap}.strip i{display:inline-block;width:14px;height:18px;border-radius:3px}
</style></head><body>
<div class="wrap">
  <div class="top">
    <div><p class="mark">panel.example.com</p><h1>安全监控</h1></div>
    <div class="ctrl"><span id="upd">—</span><label><input type="checkbox" id="auto" checked> 自动刷新</label><button class="btn p" onclick="load()">刷新</button><a class="btn" href="/">返回</a></div>
  </div>

  <div class="sec"><div class="grid g4" id="kpi"></div></div>

  <div class="sec"><div class="grid g2">
    <div class="card"><h3><span class="tick"></span>项目在线状态</h3><div id="svc"><div class="empty">加载中…</div></div></div>
    <div class="card"><h3><span class="tick"></span>可疑来源 IP（本站记录）</h3><div id="ips"><div class="empty">加载中…</div></div></div>
  </div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>在线率历史（近 7 天，每小时 · UTC+8）</h3><div id="up"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>域名与证书</h3><div id="dm"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>GitHub 巡检 / 配置备份</h3><div id="ci"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>代理体检</h3><div id="px"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>令牌异常自动处置</h3><div id="gd"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="card"><h3><span class="tick"></span>每日报告</h3><div id="dr"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><div class="grid g2">
    <div class="card"><h3><span class="tick"></span>被探测的路径</h3><div id="paths"><div class="empty">加载中…</div></div></div>
    <div class="card"><h3><span class="tick"></span>来访国家/地区</h3><div id="ctry"><div class="empty">加载中…</div></div></div>
  </div></div>

  <div class="sec"><h2>Cloudflare 分析（近 7 天）</h2><div id="cf"><div class="card"><div class="empty">加载中…</div></div></div></div>

  <div class="sec"><h2>最近安全事件（本站记录）</h2>
    <div class="card"><div style="overflow:auto"><table id="ev"><thead><tr><th>时间</th><th>类型</th><th>IP</th><th>国家</th><th>路径</th><th>状态</th><th>UA</th></tr></thead><tbody><tr><td colspan="7" class="empty">加载中…</td></tr></tbody></table></div></div>
  </div>
</div>
<script>
var timer=null;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function ago(ts){var d=(Date.now()-Number(ts))/1000;if(!isFinite(d))return "—";if(d<60)return Math.floor(d)+"秒前";if(d<3600)return Math.floor(d/60)+"分前";if(d<86400)return Math.floor(d/3600)+"时前";return Math.floor(d/86400)+"天前";}
function fmt(n){n=Number(n)||0;if(n>=1e9)return (n/1e9).toFixed(1)+"B";if(n>=1e6)return (n/1e6).toFixed(1)+"M";if(n>=1e3)return (n/1e3).toFixed(1)+"k";return ""+n;}
function bytes(n){n=Number(n)||0;var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return n.toFixed(i?1:0)+u[i];}
function mk(p){return String(p==null?"":p).replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi,function(m){return m.slice(0,4)+"…(已隐藏)";});}
function escA(s){return esc(s);} // attribute-safe: esc() already escapes & < > " '
function ghLink(u,t,cls){u=String(u||"");if(!/^https:\/\/github\.com\//.test(u))return "";return '<a'+(cls?' class="'+escA(cls)+'"':'')+' href="'+escA(u)+'" target="_blank" rel="noopener noreferrer">'+esc(t)+'</a>';}
function cnTime(iso){var d=new Date(iso);if(isNaN(d))return esc(iso||"—");return d.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})+" (UTC+8)";}
var CI_REPO="https://github.com/dageainiu/domain-guard";
function renderCI(ci){
  var el=document.getElementById("ci");
  if(!ci){el.innerHTML='<div class="empty">等待首次上报。GitHub Actions 每小时巡检一次，结果会推送到这里。 '+ghLink(CI_REPO,"打开仓库 →")+'</div>';return;}
  var st=ci.conclusion==="pass"?["ok","✔ 通过"]:ci.conclusion==="fail"?["err","✖ 异常"]:["unk","? 未知"];
  var t=new Date(ci.run_at).getTime();var stale=isNaN(t)?false:(Date.now()-t>2*3600000);
  var rows='<div class="row"><span class="mut">上次巡检</span><span>'+cnTime(ci.run_at)+(isNaN(t)?'':' · '+ago(t))+'</span></div>'+
    (stale?'<div class="row"><span class="mut">上报状态</span><span style="color:var(--warn)">超过 2 小时未收到新的巡检结果</span></div>':'')+
    '<div class="row"><span class="mut">运行记录</span><span>'+(ghLink(ci.run_url,"查看本次 Actions 运行 →")||'<span class="mut">—</span>')+'</span></div>'+
    '<div class="row"><span class="mut">仓库 / 配置备份</span><span>'+ghLink(CI_REPO,"dageainiu/domain-guard →")+'</span></div>'+
    (function(bk){if(!bk)return '<div class="row"><span class="mut">每日加密备份</span><span class="mut">等待首次备份（每天 03:20 UTC+8）</span></div>';var bt=new Date(bk.run_at).getTime();var old=!isNaN(bt)&&Date.now()-bt>26*3600000;return '<div class="row'+(bk.conclusion!=="pass"?' alert':'')+'"><span class="mut">每日加密备份</span><span>'+(bk.conclusion==="pass"?'<span style="color:var(--ok)">✔ 成功</span>':'<span style="color:var(--err)">✖ 失败</span>')+' · '+cnTime(bk.run_at)+(isNaN(bt)?'':' · '+ago(bt))+(old?' <span style="color:var(--warn)">（超过 26 小时没有新备份）</span>':'')+' · '+(ghLink(bk.commit_url,"提交 →")||ghLink(bk.run_url,"运行记录 →")||"")+'</span></div>';})(ci.backup)+
    (ci.issue_url?'<div class="row alert"><span>告警 Issue（未关闭）</span><span>'+ghLink(ci.issue_url,ci.issue_url.replace("https://github.com/",""))+'</span></div>':'')+
    (ci.details&&!(ci.checks&&ci.checks.length)?'<div class="row"><span class="mut">摘要</span><span class="mut" style="text-align:right;white-space:pre-wrap;max-width:70%">'+esc(ci.details)+'</span></div>':'');
  el.innerHTML='<div class="ci"><div><span class="pill '+st[0]+'">'+st[1]+'</span><div class="cnt"><b style="color:var(--ok)">'+fmt(ci.passed)+'</b> 项通过 · <b style="color:'+(ci.failed?'var(--err)':'var(--muted)')+'">'+fmt(ci.failed)+'</b> 项失败</div><div class="mut" style="margin-top:8px">黑盒探测 + Cloudflare 配置漂移检测</div></div><div>'+rows+'</div></div>'+renderChecks(ci.checks);
}
// Every individual check inline (failures first, then by section). Pass notes are tooltips; fail/skip notes are shown.
function renderChecks(cks){
  if(!cks||!cks.length)return "";
  var icon={pass:"✔",fail:"✖",skip:"–"};
  function item(c){var showNote=c.status!=="pass"&&c.note;return '<div class="ck '+escA(c.status)+'"'+(c.note?' title="'+escA(c.note)+'"':'')+'><span class="ic">'+esc(icon[c.status]||"")+'</span><span>'+esc(c.name)+(showNote?'<span class="nt">'+esc(c.note)+'</span>':'')+'</span></div>';}
  var fails=cks.filter(function(c){return c.status==="fail";});
  var h="";
  if(fails.length)h+='<div class="gh bad">需要处理（'+fails.length+'）</div><div class="gl">'+fails.map(item).join("")+'</div>';
  var order=[],groups={};
  cks.forEach(function(c){if(c.status==="fail")return;var g=c.group||"其它";if(!groups[g]){groups[g]=[];order.push(g);}groups[g].push(c);});
  order.forEach(function(g){var ok=groups[g].filter(function(c){return c.status==="pass";}).length;var sk=groups[g].length-ok;h+='<div class="gh">'+esc(g)+' · '+ok+' 项通过'+(sk?' · '+sk+' 项未直接观测':'')+'</div><div class="gl">'+groups[g].map(item).join("")+'</div>';});
  return '<div class="cks">'+h+'</div>';
}
function renderPX(px){
  var el=document.getElementById("px");
  if(!px){el.innerHTML='<div class="empty">代理体检数据读取失败</div>';return;}
  var h=px.health,pool=px.pool||[];
  var act=pool.filter(function(p){return p.is_active;})[0];
  var stb=pool.filter(function(p){return !p.is_active;});
  var poolRows='<div class="row"><span class="mut">当前出口</span><span>'+(act?esc(act.protocol+"://"+act.host+":"+act.port)+(act.last_check_at?(act.last_fail_at>=act.last_check_at?' <span style="color:var(--err)">不通</span>':' <span style="color:var(--ok)">正常</span>'+(act.last_ms?' · '+esc(act.last_ms)+'ms':'')):''):'<span class="mut">未登记</span>')+'</span></div>'+
    '<div class="row"><span class="mut">备用出口</span><span>'+(stb.length?stb.map(function(p){return esc(p.host+":"+p.port)+(p.enabled?(p.last_check_at?(p.last_fail_at>=p.last_check_at?' ✖':' ✔'):''):'（停用）');}).join("、"):'<span style="color:var(--warn)">没有（出口挂了也无法自动切换）</span>')+'</span></div>';
  var lf=px.lastFailover;
  poolRows+='<div class="row"><span class="mut">上次切换</span><span>'+(lf?ago(lf.t)+' · '+esc(lf.kind==="failover"?(lf.from_id+" → "+lf.to_id+(lf.ok?"":"（失败）")):lf.kind.indexOf("no_standby")>=0?"无备用，未切换":lf.kind):'<span class="mut">从未切换</span>')+'</span></div>';
  if(!h){el.innerHTML='<div class="ci"><div><span class="pill unk">? 等待首次体检</span><div class="mut" style="margin-top:8px">GitHub Actions 每小时检查一次</div></div><div>'+poolRows+'</div></div>';return;}
  var st=h.conclusion==="pass"?["ok","✔ 正常"]:h.conclusion==="warn"?["unk","! 部分异常"]:["err","✖ 异常"];
  var stale=Date.now()-Number(h.t)>2*3600000;
  var smp=h.samples||[];var sok=smp.filter(function(x){return x.ok;}).length;
  var rows='<div class="row"><span class="mut">上次检查</span><span>'+cnTime(h.run_at)+' · '+ago(h.t)+(h.simulated?' <span style="color:var(--warn)">（模拟测试）</span>':'')+'</span></div>'+
    (stale?'<div class="row"><span class="mut">上报状态</span><span style="color:var(--warn)">超过 2 小时没有新的体检结果</span></div>':'')+
    '<div class="row"><span class="mut">订阅</span><span>'+(h.sub_via==="challenged"?'<span class="mut">本次未测到（GitHub 机房 IP 被 Cloudflare 人机验证拦截，不算故障）</span>':(h.sub_ok?'<span style="color:var(--ok)">正常</span>':'<span style="color:var(--err)">异常</span>')+' · HTTP '+esc(h.sub_code)+' · '+esc(h.node_count)+' 个节点'+(h.sub_via&&h.sub_via!=="direct"?' · 经出口代理拉取':''))+'</span></div>'+
    '<div class="row"><span class="mut">节点抽检</span><span>'+sok+' / '+smp.length+' 个 WebSocket 握手 101</span></div>'+poolRows+
    '<div class="row"><span class="mut">运行记录</span><span>'+(ghLink(h.run_url,"查看本次 Actions 运行 →")||'<span class="mut">—</span>')+' · <a href="/admin/proxy">出口池管理 →</a></span></div>';
  var sm=smp.length?'<div class="cks"><div class="gh">抽检节点</div><div class="gl">'+smp.map(function(x){return '<div class="ck '+(x.ok?"pass":"fail")+'"><span class="ic">'+(x.ok?"✔":"✖")+'</span><span>'+esc(x.name||x.host)+'<span class="nt">'+esc(x.host+":"+x.port)+' · '+(x.ok?esc(x.ms)+' ms':'返回 '+esc(x.code||"无响应"))+'</span></span></div>';}).join("")+'</div></div>':'';
  el.innerHTML='<div class="ci"><div><span class="pill '+st[0]+'">'+st[1]+'</span><div class="cnt">订阅 + 节点握手 + 出站代理</div><div class="mut" style="margin-top:8px">每小时检查一次，状态变化才发邮件；当前出口不通且有可用备用时自动切换</div></div><div>'+rows+'</div></div>'+sm;
}
var CATCN={dns:"DNS 记录",tunnel:"隧道",token:"API 令牌",waf:"WAF / 规则",zone:"域名设置"};
function renderGD(g){
  var el=document.getElementById("gd");
  if(!g){el.innerHTML='<div class="empty">读取失败</div>';return;}
  var s=g.state,head;
  if(!g.configured)head='<span class="pill err">✖ 未配置令牌</span>';
  else if(!s)head='<span class="pill unk">? 等待首次扫描</span>';
  else if(s.last_err)head='<span class="pill err">✖ 上次扫描失败</span>';
  else head=g.day.n?'<span class="pill err">! 24 小时 '+esc(g.day.n)+' 条告警</span>':'<span class="pill ok">✔ 无异常</span>';
  var stale=s&&Date.now()-Number(s.last_scan)>45*60000;
  var rows='<div class="row"><span class="mut">上次扫描</span><span>'+(s?ago(s.last_scan)+' · 读取 '+esc(s.last_n)+' 条审计日志 · '+esc(s.source==="cron"?"定时任务":s.source==="github-actions"?"GitHub 巡检触发":s.source):'—')+'</span></div>'+
    (s&&s.last_err?'<div class="row alert"><span>错误</span><span>'+esc(s.last_err)+'</span></div>':'')+
    (stale?'<div class="row"><span class="mut">提示</span><span style="color:var(--warn)">超过 45 分钟没有扫描</span></div>':'')+
    '<div class="row"><span class="mut">最近 24 小时</span><span>'+esc(g.day.n)+' 条告警 · 自动删除 '+esc(g.day.del)+' 条 DNS 记录</span></div>'+
    '<div class="row"><span class="mut">自动处置</span><span style="text-align:right;max-width:72%">高风险令牌 / 未登记令牌，从白名单外的 IP 新建 A/AAAA/CNAME → 自动删除 + 邮件，可在下面一键恢复；其余情况只发邮件</span></div>';
  var al=g.alerts||[];
  var tb=al.length?'<div style="overflow:auto;margin-top:12px"><table><thead><tr><th>时间</th><th>类别 / 动作</th><th>操作者</th><th>来源 IP</th><th>对象</th><th>处置</th></tr></thead><tbody>'+al.map(function(a){
    var auto=String(a.auto||""),act;
    if(auto.indexOf("deleted")===0)act=a.restored?'<span class="tag e">已删除 → 已恢复</span>':'<span class="tag f">已自动删除</span> <button class="btn" data-restore="'+escA(a.id)+'">恢复</button>';
    else if(auto.indexOf("delete_failed")===0)act='<span class="tag f" title="'+escA(auto)+'">删除失败</span>';
    else if(auto.indexOf("skip:")===0)act='<span class="tag p" title="'+escA(auto.slice(5))+'">仅告警</span><div class="mut">'+esc(auto.slice(5))+'</div>';
    else act='<span class="tag p">仅告警</span>';
    return '<tr><td class="mut" title="'+escA(new Date(a.t).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}))+'">'+ago(a.t)+(a.baseline?' <span class="tag e" title="首次扫描时的历史记录，没有发邮件">历史</span>':'')+'</td><td>'+esc(CATCN[a.cat]||a.cat)+'<div class="mut">'+esc(a.action)+'</div></td><td title="'+escA(a.reasons)+'">'+esc(a.actor)+(a.token_cls==="high"?' <span class="tag f">高风险令牌</span>':a.token_cls==="unknown"?' <span class="tag f">未登记令牌</span>':'')+'</td><td>'+esc(a.ip||"—")+'<div class="mut">'+esc(a.ip_label||"")+'</div></td><td title="'+escA(a.target)+'">'+esc(a.target)+'</td><td>'+act+'</td></tr>';
  }).join("")+'</tbody></table></div>':'<div class="empty">最近没有可疑操作。</div>';
  var alw='<div class="cks"><div class="gh">来源 IP 白名单（'+(g.allow||[]).length+'）· 不在名单里的 IP 改 DNS / 隧道 / 令牌 / 规则都会告警；工作台登录过的 IP 自动算白名单</div><div class="gl">'+(g.allow||[]).map(function(x){return '<div class="ck '+(x.weak?'skip':'pass')+'"><span class="ic">'+(x.weak?'~':'✔')+'</span><span>'+esc(x.ip)+(/[.:]$/.test(x.ip)||x.ip==="2a09:bac"?'*':'')+'<span class="nt">'+esc(x.label)+(x.weak?'（共享出口，不为高风险令牌担保）':'')+' · <a href="#" data-del="'+escA(x.ip)+'">移除</a></span></span></div>';}).join("")+'</div><div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center"><input id="alw-ip" class="inp" placeholder="IP 或前缀，如 1.2.3.4 / 1.2.3."><input id="alw-lb" class="inp" placeholder="备注（可选）"><button class="btn p" id="alw-add" type="button">加入白名单</button><span id="alw-msg" class="mut"></span></div></div>';
  el.innerHTML='<div class="ci"><div>'+head+'<div class="cnt">每 15 分钟扫描一次 Cloudflare 账户审计日志</div><div class="mut" style="margin-top:8px">监控 DNS、隧道、API 令牌、域名设置、WAF 规则的改动</div></div><div>'+rows+'</div></div>'+tb+alw;
}
function gpost(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json","x-guard":"1"},body:JSON.stringify(b),credentials:"same-origin"}).then(function(r){return r.json();}).catch(function(e){return {ok:false,error:e.message};});}
document.getElementById("gd").addEventListener("click",function(ev){var t=ev.target;if(!t||!t.getAttribute)return;
  var rid=t.getAttribute("data-restore"),del=t.getAttribute("data-del");
  if(rid){if(!confirm("确定恢复这条 DNS 记录吗？只在你确认是自己（或你授权的工具）建的时候恢复。"))return;t.disabled=true;gpost("/status/api/guard/restore",{id:rid}).then(function(d){alert(d.ok?"已恢复："+d.record.type+" "+d.record.name:"恢复失败："+(d.error||""));load();});}
  else if(del){ev.preventDefault();if(!confirm("从白名单移除 "+del+" ？"))return;gpost("/status/api/guard/allow-del",{ip:del}).then(function(){load();});}
  else if(t.id==="alw-add"){gpost("/status/api/guard/allow",{ip:document.getElementById("alw-ip").value,label:document.getElementById("alw-lb").value}).then(function(d){if(d.ok)load();else document.getElementById("alw-msg").textContent=d.error||"失败";});}
});
function renderDR(r){
  var el=document.getElementById("dr");
  if(!r||!r.summary){el.innerHTML='<div class="empty">还没有发过每日报告。每天 08:17（UTC+8）由 GitHub Actions 触发，邮件发到你的 Outlook。</div>';return;}
  var s=r.summary,w=s.warn||[],g=s.gql||{};
  var head=w.length?'<span class="pill err">! '+w.length+' 项需要注意</span>':'<span class="pill ok">✔ 一切正常</span>';
  var sv=(s.svcs||[]).map(function(x){var c=x.pct==null?'skip':x.pct>=99?'pass':'fail';return '<div class="ck '+c+'"><span class="ic">'+(x.pct==null?'–':x.pct>=99?'✔':'✖')+'</span><span>'+esc(x.name)+'<span class="nt">'+(x.pct==null?'暂无数据':esc(x.pct)+'% · '+esc(x.n)+' 次巡检'+(x.ms!=null?' · 平均 '+esc(x.ms)+' ms':''))+'</span></span></div>';}).join("");
  var rows='<div class="row"><span class="mut">上次发送</span><span>'+cnTime(new Date(r.t).toISOString())+' · '+ago(r.t)+(r.mailed?'':' <span style="color:var(--err)">（邮件发送失败）</span>')+'</span></div>'+
    (w.length?'<div class="row alert"><span>需要注意</span><span style="text-align:right">'+w.map(esc).join("<br>")+'</span></div>':'')+
    '<div class="row"><span class="mut">工作台登录</span><span>成功 '+esc(s.login.ok)+' 次 · 密码错误 '+esc(s.login.fail)+' 次</span></div>'+
    (g.err?'<div class="row"><span class="mut">Cloudflare 统计</span><span>'+esc(g.err)+'</span></div>':'<div class="row"><span class="mut">Cloudflare 防护</span><span>拦截 '+fmt(g.blocked)+' · 人机验证 '+fmt(g.challenged)+' · 总请求 '+fmt(g.requests)+'</span></div><div class="row"><span class="mut">代理</span><span>订阅拉取 '+(g.subPulls==null?'—':fmt(g.subPulls))+' · 连接 '+fmt(g.wsConns)+' · 流量 '+bytes(g.wsBytes)+'</span></div>')+
    '<div class="row"><span class="mut">代理体检 / 备份</span><span>'+(s.proxy?esc({pass:"正常",warn:"部分异常",fail:"异常"}[s.proxy.conclusion]||s.proxy.conclusion):'—')+' / '+(s.backup?(s.backup.conclusion==="pass"?"成功":"失败"):'—')+'</span></div>'+
    '<div class="row"><span class="mut">告警 Issue / 令牌告警</span><span>'+esc((s.issues||[]).length)+' 个 / '+esc(s.guard?s.guard.n:0)+' 条</span></div>'+
    (r.run_url?'<div class="row"><span class="mut">运行记录</span><span>'+ghLink(r.run_url,"查看 Actions 运行 →")+'</span></div>':'');
  el.innerHTML='<div class="ci"><div>'+head+'<div class="cnt">每天 08:17（UTC+8）发到你的邮箱</div><div class="mut" style="margin-top:8px">统计最近 24 小时</div></div><div>'+rows+'</div></div><div class="cks"><div class="gh">项目在线率（最近 24 小时）</div><div class="gl">'+sv+'</div></div>';
}
function pct1(ok,n){return n?Math.round(ok/n*1000)/10:null;}
function upColor(p){return p==null?"rgba(255,255,255,.07)":p>=99.9?"#38d39f":p>=95?"#9be15d":p>=80?"#ffb84d":"#ff6b6b";}
function d8(ms){var d=new Date(ms+28800000);return (d.getUTCMonth()+1)+"/"+d.getUTCDate();}
function h8(ms){var d=new Date(ms+28800000);return (d.getUTCMonth()+1)+"/"+d.getUTCDate()+" "+String(d.getUTCHours()).padStart(2,"0")+":00";}
var UPT=0;
async function loadUp(force){
  if(!force&&Date.now()-UPT<300000)return;UPT=Date.now();
  var el=document.getElementById("up");
  try{
    var r=await fetch("/status/api/uptime",{cache:"no-store"});var u=await r.json();
    if(!u.ok)throw new Error(u.error||"读取失败");
    var H=3600000,D=86400000,N=168,W=840,BH=22,LH=46;
    var from=u.from7;var html="";
    var ticks="";for(var i=0;i<=N;i++){var t=from+i*H;if((t+28800000)%D===0){var x=Math.round(i*W/N);ticks+='<line x1="'+x+'" y1="0" x2="'+x+'" y2="'+(BH+LH+8)+'" stroke="rgba(255,255,255,.08)"/><text x="'+(x+3)+'" y="'+(BH+LH+20)+'" fill="#8a97b1" font-size="11">'+d8(t)+'</text>';}}
    u.svcs.forEach(function(s){
      var m={};(u.hours[s.k]||[]).forEach(function(a){m[a[0]]=a;});
      var bars="",pts=[],tn=0,tok=0,mss=[];
      for(var i=0;i<N;i++){var hk=from/H+i,a=m[hk];var p=a?pct1(a[2],a[1]):null;if(a){tn+=a[1];tok+=a[2];if(a[3]!=null){mss.push(a[3]);}}
        var x=(i*W/N);bars+='<rect x="'+x.toFixed(1)+'" y="0" width="'+(W/N-0.8).toFixed(1)+'" height="'+BH+'" rx="1" fill="'+upColor(p)+'"><title>'+h8(hk*H)+(a?" · 在线 "+a[2]+"/"+a[1]+" 次巡检"+(a[3]!=null?" · 平均 "+a[3]+" ms":""):" · 无数据")+'</title></rect>';
        if(a&&a[3]!=null)pts.push([x+W/N/2,a[3]]);}
      var sorted=mss.slice().sort(function(a,b){return a-b;});var cap=sorted.length?Math.max(50,sorted[Math.min(sorted.length-1,Math.floor(sorted.length*0.95))]):100;
      var avg=mss.length?Math.round(mss.reduce(function(a,b){return a+b;},0)/mss.length):null;
      var line=pts.length>1?'<polyline fill="none" stroke="#7a5cff" stroke-width="1.6" points="'+pts.map(function(p){return p[0].toFixed(1)+","+(BH+6+LH-Math.min(p[1],cap)/cap*LH).toFixed(1);}).join(" ")+'"/>':'';
      var pt=pct1(tok,tn);
      html+='<div class="uprow"><div class="uphd"><span><span class="dot '+(pt==null?'':pt>=99?'up':'down')+'"></span><b>'+esc(s.name)+'</b></span><span class="mut">7 天在线率 <b style="color:'+upColor(pt)+'">'+(pt==null?"—":pt+"%")+'</b> · '+tn+' 次巡检'+(avg!=null?' · 平均延迟 '+avg+' ms（上限刻度 '+cap+' ms）':'')+'</span></div>'+
        '<svg class="upsvg" viewBox="0 0 '+W+' '+(BH+LH+24)+'" preserveAspectRatio="none" role="img" aria-label="'+escA(s.name)+' 在线率和延迟">'+ticks+bars+'<text x="'+(W-4)+'" y="'+(BH+16)+'" fill="#8a97b1" font-size="10" text-anchor="end">延迟 ↑</text>'+line+'</svg></div>';
    });
    var days=[];for(var t=u.from30;t<=u.now;t+=D)days.push(Math.floor((t+28800000)/D));
    var strip=u.svcs.map(function(s){var m={};(u.days[s.k]||[]).forEach(function(a){m[a[0]]=a;});
      return '<div class="strip"><span class="snm">'+esc(s.name)+'</span><span class="sd">'+days.map(function(dk){var a=m[dk];var p=a?pct1(a[2],a[1]):null;return '<i style="background:'+upColor(p)+'" title="'+d8(dk*D)+(a?" · "+p+"%（"+a[2]+"/"+a[1]+"）"+(a[3]!=null?" · 平均 "+a[3]+" ms":""):" · 无数据")+'"></i>';}).join("")+'</span></div>';}).join("");
    var first=u.first?'数据从 '+cnTime(new Date(u.first).toISOString())+' 开始记录，':'';
    el.innerHTML=html+'<div class="gh2">每日在线率（最近 30 天，一格一天，UTC+8）</div>'+strip+
      '<div class="mut" style="margin-top:10px">'+first+'每 5 分钟巡检一次，按北京时间（UTC+8）整点分组；柱子颜色 = 那一小时的在线率（绿 ≥ 99.9%，浅绿 ≥ 95%，黄 ≥ 80%，红 &lt; 80%，灰 = 无数据），紫线 = 平均响应时间。记录保留 30 天。鼠标悬停看明细。</div>';
  }catch(e){el.innerHTML='<div class="empty">在线率历史读取失败：'+esc(e.message)+'</div>';}
}
function renderDM(dm){
  var el=document.getElementById("dm");
  if(!dm){el.innerHTML='<div class="empty">还没有检查结果。GitHub Actions 每天 07:47（UTC+8）检查一次证书、Cloudflare 域名状态和 NS 委派。</div>';return;}
  var d=dm.data||{};
  var st=dm.status==="ok"?["ok","✔ 正常"]:dm.status==="warn"?["unk","! 有项目没查到"]:["err","✖ 有问题"];
  var stale=Date.now()-Number(dm.t)>26*3600000;
  var rows='<div class="row"><span class="mut">上次检查</span><span>'+cnTime(new Date(dm.t).toISOString())+' · '+ago(dm.t)+(stale?' <span style="color:var(--warn)">（超过 26 小时没有新结果）</span>':'')+'</span></div>';
  (d.certs||[]).forEach(function(c){rows+='<div class="row"><span class="mut">证书 '+esc(c.host)+'</span><span>'+(c.ok?'<b style="color:'+(c.days<14?'var(--err)':c.days<30?'var(--warn)':'var(--ok)')+'">还剩 '+esc(c.days)+' 天</b> · '+esc(String(c.not_after).slice(0,10))+' 到期 · '+esc(c.issuer)+(c.covers===false?' <span style="color:var(--err)">不含此域名</span>':''):'<span style="color:var(--err)">'+esc(c.err||"拿不到证书")+'</span>')+'</span></div>';});
  var z=d.zone||{};
  rows+='<div class="row"><span class="mut">Cloudflare 域名状态</span><span>'+(z.ok?(z.status==="active"&&!z.paused?'<span style="color:var(--ok)">active</span>':'<span style="color:var(--err)">'+esc(z.status)+(z.paused?"（已暂停）":"")+'</span>')+' · NS '+esc((z.ns||[]).join("、")):'<span class="mut">'+esc(z.err||"读取失败")+'</span>')+'</span></div>';
  var rs=d.resolvers||[];var zns=(z.ns||[]).slice().sort().join(",");
  rows+='<div class="row"><span class="mut">公共 DNS 看到的 NS</span><span>'+(rs.map(function(r){var g=(r.ns||[]).slice().sort().join(",");return esc(r.resolver)+' '+(!r.ok?'<span class="mut">查询失败</span>':!g?'<span style="color:var(--err)">查不到</span>':(zns&&g!==zns)?'<span style="color:var(--err)">不一致</span>':'<span style="color:var(--ok)">✔</span>');}).join(" · ")||'—')+'</span></div>';
  var p=d.parent||{};var an=(p.answers||[]);
  rows+='<div class="row"><span class="mut">上级 " + PARENT_DOMAIN + " 委派</span><span>'+(an.length?an.map(function(a){var g=(a.ns||[]).slice().sort().join(",");return esc(a.server)+' '+(a.ok?(!g?'<span style="color:var(--err)">没有委派</span>':(zns&&g!==zns)?'<span style="color:var(--err)">指向 '+esc(g)+'</span>':'<span style="color:var(--ok)">✔ 指向 Cloudflare</span>'):'<span class="mut">'+esc(a.status||"无响应")+'</span>');}).join(" · "):'<span class="mut">'+esc(p.err||"未查询")+'</span>')+'</span></div>';
  var rd=d.rdap||{};
  rows+='<div class="row"><span class="mut">上级域名 " + PARENT_DOMAIN + " 注册</span><span>'+(rd.ok?esc((rd.status||[]).join("、")||"无状态标记")+' · '+esc(String(rd.expires||"").slice(0,10))+' 到期':'<span class="mut">'+esc(rd.err||"查询失败")+'</span>')+'</span></div>';
  if(dm.run_url)rows+='<div class="row"><span class="mut">运行记录</span><span>'+ghLink(dm.run_url,"查看 Actions 运行 →")+'</span></div>';
  var pr=(dm.problems||[]).length?'<div class="cks"><div class="gh bad">需要处理</div>'+dm.problems.map(function(x){return '<div class="ck fail"><span class="ic">✖</span><span>'+esc(x)+'</span></div>';}).join("")+'</div>':'';
  var nt=(dm.notes||[]).length?'<div class="mut" style="margin-top:8px">'+dm.notes.map(esc).join("；")+'</div>':'';
  el.innerHTML='<div class="ci"><div><span class="pill '+st[0]+'">'+st[1]+'</span><div class="cnt">证书 · 域名状态 · NS 委派</div><div class="mut" style="margin-top:8px">每天 07:47（UTC+8）检查；证书少于 14 天、域名不是 active、NS 委派变了或上级域名异常时发邮件（同类 24 小时 1 封）。这里通过「上级 NS 还委派给 Cloudflare」来判断域名状态正常。</div></div><div>'+rows+'</div></div>'+pr+nt;
}
function kpi(label,val,cls){return '<div class="card"><h3>'+label+'</h3><div class="stat '+escA(cls||"")+'">'+val+'</div></div>';}
function listKV(arr,unit){if(!arr||!arr.length)return '<div class="empty">暂无数据</div>';var max=arr[0].v||1;return arr.map(function(x){return '<div class="row"><span>'+esc(x.k)+'</span><b>'+fmt(x.v)+(unit||"")+'</b></div><div class="bar" style="width:'+Math.max(6,Math.round(x.v/max*100))+'%"></div>';}).join("");}
async function load(){
  try{
    var r=await fetch("/status/api/overview",{cache:"no-store"});var d=await r.json();
    if(!d.ok)throw new Error(d.error||"err");
    var c=d.security.counters;var win=d.security.window==="7d"?"（近 7 天）":"";
    document.getElementById("kpi").innerHTML=
      kpi("可疑事件总数"+win,fmt(c.total),c.total?"warn":"ok")+
      kpi("登录失败",fmt(c.authFail),c.authFail?"err":"ok")+
      kpi("可疑探测",fmt(c.probes),c.probes?"warn":"ok")+
      kpi("错误响应 4xx/5xx",fmt(c.errors),c.errors?"warn":"ok");
    document.getElementById("svc").innerHTML=d.services.map(function(s){return '<div class="svc"><span><span class="dot '+(s.up?"up":"down")+'"></span>'+esc(s.name)+'</span><span class="mut">'+(s.note?esc(s.note):("HTTP "+esc(s.code)+" · "+esc(s.ms)+"ms"))+'</span></div>';}).join("")+
      (d.health&&d.health.length?'<div class="mut" style="padding-top:10px">定时巡检（每 5 分钟，异常邮件告警）：上次 '+ago(Math.max.apply(null,d.health.map(function(h){return h.t||0;})))+' · '+d.health.map(function(h){return esc(h.svc)+(h.up?" 正常":" 离线");}).join(" / ")+'</div>':'');
    try{renderCI(d.ci);}catch(e){document.getElementById("ci").innerHTML='<div class="empty">巡检信息渲染失败</div>';}
    try{renderPX(d.proxy);}catch(e){document.getElementById("px").innerHTML='<div class="empty">代理体检渲染失败</div>';}
    try{renderGD(d.guard);}catch(e){document.getElementById("gd").innerHTML='<div class="empty">令牌异常处置渲染失败</div>';}
    try{renderDR(d.daily);}catch(e){document.getElementById("dr").innerHTML='<div class="empty">每日报告渲染失败</div>';}
    try{renderDM(d.domain);}catch(e){document.getElementById("dm").innerHTML='<div class="empty">域名与证书渲染失败</div>';}
    loadUp(false);
    document.getElementById("ips").innerHTML=listKV(d.security.topIp);
    document.getElementById("paths").innerHTML=listKV(d.security.topPath);
    document.getElementById("ctry").innerHTML=listKV(d.security.topCountry);
    var ev=d.security.events||[];
    document.getElementById("ev").querySelector("tbody").innerHTML= ev.length? ev.map(function(e){
      var t=e.type==="auth"?'<span class="tag f">登录失败</span>':e.type==="probe"?'<span class="tag p">探测</span>':'<span class="tag e">'+esc(e.type)+'</span>';
      return '<tr><td class="mut">'+ago(e.t)+'</td><td>'+t+'</td><td>'+esc(e.ip)+'</td><td>'+esc(e.co||"")+'</td><td title="'+escA(mk(e.path))+'">'+esc(mk(e.path))+'</td><td>'+esc(e.st||"")+'</td><td title="'+escA(e.ua||"")+'" class="mut">'+esc((e.ua||"").slice(0,40))+'</td></tr>';
    }).join(""):'<tr><td colspan="7" class="empty">暂无记录。出现登录失败或可疑探测时会显示在这里。</td></tr>';
    document.getElementById("upd").textContent="更新于 "+new Date().toLocaleTimeString();
  }catch(e){document.getElementById("upd").textContent="加载失败: "+e.message;}
  try{
    var r2=await fetch("/status/api/cf",{cache:"no-store"});var cf=await r2.json();var el=document.getElementById("cf");
    if(!cf.configured){el.innerHTML='<div class="card"><div class="empty">未接入 Cloudflare 分析。配置 Analytics 令牌后,这里会显示总请求、威胁拦截、来访国家和客户端类型(含爬虫信号)。</div></div>';}
    else if(!cf.ok){el.innerHTML='<div class="card"><div class="empty">读取失败: '+esc(cf.error)+'</div></div>';}
    else{var t=cf.totals||{};
      var k='<div class="grid g4" style="margin-bottom:14px">'+
        kpi("总请求",fmt(t.requests),"b")+kpi("已缓存",fmt(t.cachedRequests),"ok")+kpi("威胁拦截",fmt(t.threats),t.threats?"err":"ok")+kpi("流量",bytes(t.bytes),"b")+'</div>';
      var cl=(cf.clients||[]);
      var botv=cf.botViews||0;
      var clh='<div class="card"><h3><span class="tick"></span>客户端类型 / 爬虫信号</h3>'+(cl.length?'<div class="empty" style="margin:-4px 0 10px">疑似爬虫/脚本访问 <b style="color:var(--warn)">'+fmt(botv)+'</b> 次</div><div style="overflow:auto"><table><thead><tr><th>客户端</th><th>标记</th><th>次数</th></tr></thead><tbody>'+cl.map(function(x){return '<tr><td>'+esc(x.name)+'</td><td>'+(x.bot?'<span class="tag f">爬虫/脚本</span>':'<span style="color:var(--muted)">浏览器</span>')+'</td><td><b>'+fmt(x.count)+'</b></td></tr>';}).join("")+'</tbody></table></div>':'<div class="empty">暂无数据</div>')+'</div>';
      var co=(cf.country||[]);
      var coh='<div class="card"><h3><span class="tick"></span>来访国家（全站 7 天）</h3>'+listKV(co.map(function(x){return{k:x.country+(x.threats?' ⚠'+x.threats:''),v:x.count};}))+'</div>';
      el.innerHTML=k+'<div class="grid g2">'+clh+coh+'</div>';
    }
  }catch(e){document.getElementById("cf").innerHTML='<div class="card"><div class="empty">CF 分析加载失败: '+esc(e.message)+'</div></div>';}
}
document.getElementById("auto").addEventListener("change",function(){if(this.checked){load();timer=setInterval(load,30000);}else{clearInterval(timer);}});
if(document.getElementById("auto").checked){timer=setInterval(load,30000);}
load();
</script>
</body></html>`;

// ---- Proxy health + outbound SOCKS5 failover (report pushed by GitHub Actions domain-guard monitor, hourly) ----
// GET  /api/proxy-health  (x-ci-key) -> outbound pool metadata for the CI job (no plaintext passwords; pass_enc is AES-GCM ciphertext)
// POST /api/proxy-health  (x-ci-key) -> structured report {sub, samples, outbounds, simulated?, dry_run?}
// Failover: if the ACTIVE outbound (the pool entry matching cfnext KV config.outboundProxy) is down and an enabled standby is up,
// rewrite ONLY config.outboundProxy in cfnext KV (binding CFK), log to D1 proxy_failover_log and email. No standby -> email, config untouched.
// Passwords: Worker secret OUTBOUND_POOL_JSON (seeded entries) or D1 pass_enc decrypted with Worker secret OUTBOUND_POOL_KEY.
const PH_MAX_BODY = 32768;
// M8: the pool (encrypted passwords) and the failover switch need the WRITE key (CI_WRITE_KEY / GitHub PANEL_WRITE_KEY);
// the read key (CI_REPORT_KEY) only posts monitor results, the daily-report trigger and non-destructive guard scans.
async function writeKeyOk(request, env) { return !!env.CI_WRITE_KEY && await keyOk(request.headers.get("x-ci-key"), env.CI_WRITE_KEY); }
async function proxyHealthApi(request, env) {
  if (!(await writeKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  try {
    if (request.method === "GET") {
      const pool = (await env.DB.prepare("SELECT id, host, port, user, protocol, enabled, is_active, pass_enc FROM outbound_pool ORDER BY is_active DESC, created_at").all()).results || [];
      let sub_url = "";
      try { const c = await loadCfnextCfg(env); if (c.path || c.uuid) sub_url = "https://panel.example.com/" + String(c.path || c.uuid) + "/sub"; } catch (e) {}
      return json({ ok: true, pool, sub_url });
    }
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    const raw = await request.text();
    if (raw.length > PH_MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);
    let b; try { b = JSON.parse(raw); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
    if (!b || typeof b !== "object") return json({ ok: false, error: "invalid body" }, 400);
    const res = await processProxyReport(env, b, "github-actions");
    return json(Object.assign({ ok: true }, res));
  } catch (e) {
    console.error("proxy-health error: " + String(e && e.stack || e));
    return json({ ok: false, error: "internal error" }, 500);
  }
}
const s40 = (v, n) => String(v == null ? "" : v).slice(0, n || 40);
function cleanReport(b) {
  const sub = b.sub && typeof b.sub === "object" ? b.sub : {};
  const samples = (Array.isArray(b.samples) ? b.samples : []).slice(0, 8).map(x => ({ name: s40(x && x.name, 60), host: s40(x && x.host, 80), port: toInt(x && x.port), proto: s40(x && x.proto, 10), code: toInt(x && x.code), ms: toInt(x && x.ms), ok: !!(x && x.ok) }));
  const outbounds = (Array.isArray(b.outbounds) ? b.outbounds : []).slice(0, 20).map(x => ({ id: s40(x && x.id, 40), ok: !!(x && x.ok), ms: toInt(x && x.ms), ip: /^[0-9a-fA-F:.]{3,45}$/.test(String(x && x.ip || "")) ? String(x.ip) : "", err: s40(x && x.err, 160), attempts: toInt(x && x.attempts) }));
  return {
    run_at: s40(b.run_at, 40), run_url: ghUrl(b.run_url),
    sub: { ok: !!sub.ok, code: toInt(sub.code), nodes: toInt(sub.nodes), via: s40(sub.via, 20), err: s40(sub.err, 160) },
    samples, outbounds, simulated: !!b.simulated, dry_run: !!b.dry_run
  };
}
function proxyHostPort(u) {
  const m = /^(?:[a-z0-9+.-]+:\/\/)?(?:[^@\/]*@)?(\[[^\]]+\]|[^:\/?#@]+)(?::(\d+))?/i.exec(String(u || "").trim());
  return m ? (m[1].replace(/^\[|\]$/g, "") + ":" + (m[2] || "1080")).toLowerCase() : "";
}
async function loadCfnextCfg(env) {
  if (!env.CFK) throw new Error("no CFK binding");
  const raw = await env.CFK.get("config");
  const cfg = raw ? JSON.parse(raw) : null;
  if (!cfg || typeof cfg !== "object" || !cfg.uuid) throw new Error("cfnext config unreadable");
  return cfg;
}
function poolSecretMap(env) {
  const m = {};
  try { for (const x of JSON.parse(env.OUTBOUND_POOL_JSON || "[]")) if (x && x.id) m[String(x.id)] = x; } catch (e) {}
  return m;
}
function b64ToBytes(s) { const bin = atob(String(s)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function poolKey(env) {
  if (!env.OUTBOUND_POOL_KEY) throw new Error("OUTBOUND_POOL_KEY missing");
  return crypto.subtle.importKey("raw", b64ToBytes(env.OUTBOUND_POOL_KEY), { name: "AES-GCM" }, false, ["decrypt"]);
}
async function decPass(env, row) {
  const sec = poolSecretMap(env)[row.id];
  if (sec && typeof sec.pass === "string") return sec.pass;
  if (!row.pass_enc) return "";
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(row.pass_enc); if (!m) throw new Error("bad pass_enc");
  const buf = b64ToBytes(m[1]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: new TextEncoder().encode("outbound:" + row.id) }, await poolKey(env), buf.slice(12));
  return new TextDecoder().decode(pt);
}
function buildOutboundUrl(row, pass) {
  const proto = /^(socks5|http|https)$/.test(row.protocol) ? row.protocol : "socks5";
  const auth = row.user ? encodeURIComponent(row.user) + (pass ? ":" + encodeURIComponent(pass) : "") + "@" : "";
  const host = /:/.test(row.host) ? "[" + row.host + "]" : row.host;
  return proto + "://" + auth + host + ":" + row.port;
}
// Rewrites ONLY config.outboundProxy in the cfnext KV config (all other keys preserved), then verifies by reading back.
async function setActiveOutbound(env, row) {
  const pass = await decPass(env, row);
  if (row.user && !pass) throw new Error("no password stored for " + row.id);
  if (!env.CFK) throw new Error("no CFK binding");
  // read twice and only write when the config is stable; verify uuid + every other key after the write.
  const raw1 = await env.CFK.get("config");
  const cfg = raw1 ? JSON.parse(raw1) : null;
  if (!cfg || typeof cfg !== "object" || !cfg.uuid) throw new Error("cfnext config unreadable");
  const raw2 = await env.CFK.get("config");
  if (raw2 !== raw1) throw new Error("config changed concurrently, retry next run");
  const before = Object.assign({}, cfg);
  await cvSnapshot(env, raw1, "定时检测到变化");
  cfg.outboundProxy = buildOutboundUrl(row, pass);
  const out = JSON.stringify(cfg);
  await env.CFK.put("config", out);
  await cvSnapshot(env, out, "出站代理自动切换");
  const back = await loadCfnextCfg(env);
  if (proxyHostPort(back.outboundProxy) !== (row.host + ":" + row.port).toLowerCase()) throw new Error("read-back mismatch");
  for (const k of Object.keys(before)) if (k !== "outboundProxy" && JSON.stringify(back[k]) !== JSON.stringify(before[k])) throw new Error("read-back mismatch: " + k);
  await env.DB.prepare("UPDATE outbound_pool SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END").bind(row.id).run();
}
const FAILBACK_STREAK = 3;
async function processProxyReport(env, body, source) {
  const r = cleanReport(body);
  const now = Date.now();
  const db = env.DB;
  const pool = (await db.prepare("SELECT * FROM outbound_pool ORDER BY created_at").all()).results || [];
  let cfg = null, cfgErr = "";
  try { cfg = await loadCfnextCfg(env); } catch (e) { cfgErr = String(e && e.message || e); }
  const activeHP = cfg ? proxyHostPort(cfg.outboundProxy) : "";
  const active = pool.find(x => (x.host + ":" + x.port).toLowerCase() === activeHP) || null;
  const outs = {}; for (const o of r.outbounds) outs[o.id] = o;
  const stmts = [];
  if (!r.simulated && !r.dry_run) {
    for (const x of pool) {
      const o = outs[x.id];
      if (!o) continue;
      stmts.push(db.prepare("UPDATE outbound_pool SET last_check_at = ?2, last_ok_at = CASE WHEN ?3 = 1 THEN ?2 ELSE last_ok_at END, last_fail_at = CASE WHEN ?3 = 1 THEN last_fail_at ELSE ?2 END, last_ms = ?4, last_ip = ?5, last_err = ?6, ok_streak = CASE WHEN ?3 = 1 THEN COALESCE(ok_streak, 0) + 1 ELSE 0 END WHERE id = ?1")
        .bind(x.id, now, o.ok ? 1 : 0, o.ms, o.ip, o.ok ? "" : o.err));
      x._streak = o.ok ? (Number(x.ok_streak) || 0) + 1 : 0;
    }
    if (active) stmts.push(db.prepare("UPDATE outbound_pool SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END").bind(active.id));
  }
  // ---- failover decision ----
  const activeRes = active ? outs[active.id] : null;
  let action = { kind: "none" };
  if (!cfg) action = { kind: "config_unreadable", reason: cfgErr };
  else if (!active) action = { kind: "unmanaged", reason: activeHP ? "当前出口 " + activeHP + " 不在出口池里" : "cfnext 未设置出站代理" };
  else if (activeRes && !activeRes.ok) {
    const cands = pool.filter(x => x.id !== active.id && x.enabled && outs[x.id] && outs[x.id].ok).sort((a, b) => outs[a.id].ms - outs[b.id].ms);
    if (!cands.length) action = { kind: "no_standby", from: active.id, reason: activeRes.err || "连接失败" };
    else {
      const to = cands[0];
      action = { kind: "failover", from: active.id, to: to.id, toHP: to.host + ":" + to.port, reason: activeRes.err || "连接失败" };
      if (r.simulated || r.dry_run) action.dry = true;
      else {
        try { await setActiveOutbound(env, to); action.ok = true; }
        catch (e) { action.ok = false; action.error = String(e && e.message || e).slice(0, 160); }
      }
    }
  } else if (activeRes && activeRes.ok && !r.simulated && !r.dry_run) {
    // 15: switch back to the primary exit once it has passed FAILBACK_STREAK consecutive checks (no email; daily report).
    const prim = pool.find(x => x.is_primary && x.enabled && x.id !== active.id);
    if (prim && outs[prim.id] && outs[prim.id].ok && (prim._streak || 0) >= FAILBACK_STREAK) {
      action = { kind: "failback", from: active.id, to: prim.id, toHP: prim.host + ":" + prim.port, reason: "主出口已连续 " + prim._streak + " 次检测正常" };
      try { await setActiveOutbound(env, prim); action.ok = true; } catch (e) { action.ok = false; action.error = String(e && e.message || e).slice(0, 160); }
    }
  }
  // ---- summary + state (email only when the state changes) ----
  const sampOk = r.samples.filter(x => x.ok).length, sampN = r.samples.length;
  const nodesOk = sampN > 0 && sampOk === sampN;
  const switched = (action.kind === "failover" || action.kind === "failback") && action.ok;
  const activeOk = switched ? true : activeRes ? activeRes.ok : null;
  const finalActive = switched ? action.to : (active ? active.id : "");
  const subOk = r.sub.ok && r.sub.nodes > 0;
  // GitHub runner IPs (and sometimes the outbound exit) get a Cloudflare challenge (Bot Fight Mode, Free plan) on the
  // subscription / node hostnames. That means "not measured", not "down": keep the previous sub/nodes state so it never alerts.
  const subUnk = !subOk && /challenge/i.test(r.sub.err);
  const nodesUnk = subUnk || (sampN > 0 && sampOk === 0 && r.samples.every(x => x.code === 403));
  if (subUnk) r.sub.via = "challenged";
  const prev = await db.prepare("SELECT state, alerted_state FROM proxy_health WHERE id = 1").first().catch(() => null);
  const prevState = prev ? prev.alerted_state : null;
  const prevParts = String(prevState || "").split("|");
  const subBad = !subUnk && !subOk, nodesBad = !nodesUnk && sampOk === 0, nodesPartial = !nodesUnk && sampOk > 0 && sampOk < sampN;
  const conclusion = activeOk === false || subBad || nodesBad ? "fail" : nodesPartial ? "warn" : "pass";
  const state = [subUnk ? (prevParts[0] && prevParts[0].indexOf("sub:") === 0 ? prevParts[0] : "sub:unk") : "sub:" + (subOk ? "ok" : "bad"),
    nodesUnk ? (prevParts[1] && prevParts[1].indexOf("nodes:") === 0 ? prevParts[1] : "nodes:unk") : "nodes:" + (nodesOk ? "ok" : sampOk ? "partial" : "bad"),
    "out:" + finalActive + ":" + (action.kind === "failover" && action.ok ? "switched" : activeOk === false ? "down" : activeOk ? "ok" : "unknown")].join("|");
  const changed = action.kind === "failover" || (prevState ? prevState !== state : conclusion !== "pass");
  // 21: at most one proxy email per hour per type; alerted_state stays the last MAILED state so a suppressed change is
  // re-evaluated (and mailed if still different) after the hour. A failback is never mailed (daily report only).
  let mayMail = false;
  if (changed && !r.dry_run && !(action.kind === "failback" && action.ok && !(prevState && prevState.split("|").slice(0, 2).join("|") !== state.split("|").slice(0, 2).join("|")))) {
    const typ = action.kind === "failover" ? "failover" : action.kind === "no_standby" ? "no_standby" : conclusion;
    mayMail = r.simulated ? true : await gateOk(env, "proxy:" + typ, now);
  }
  const alertedState = changed && !mayMail && !(action.kind === "failback") ? (prevState || null) : state;
  stmts.push(db.prepare("INSERT INTO proxy_health (id, run_at, t, conclusion, sub_ok, sub_code, sub_via, node_count, samples, outbounds, active_id, state, alerted_state, run_url, source, simulated, action, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?16, ?12, ?13, ?14, ?15, ?2) ON CONFLICT(id) DO UPDATE SET run_at=excluded.run_at, t=excluded.t, conclusion=excluded.conclusion, sub_ok=excluded.sub_ok, sub_code=excluded.sub_code, sub_via=excluded.sub_via, node_count=excluded.node_count, samples=excluded.samples, outbounds=excluded.outbounds, active_id=excluded.active_id, state=excluded.state, alerted_state=excluded.alerted_state, run_url=excluded.run_url, source=excluded.source, simulated=excluded.simulated, action=excluded.action, updated_at=excluded.updated_at")
    .bind(r.run_at || new Date(now).toISOString(), now, conclusion, subOk ? 1 : 0, r.sub.code, r.sub.via || "direct", r.sub.nodes, JSON.stringify(r.samples), JSON.stringify(r.outbounds), finalActive, state, r.run_url, source, r.simulated ? 1 : 0, JSON.stringify(action), alertedState));
  if (action.kind === "failover" || action.kind === "failback" || (action.kind === "no_standby" && changed)) {
    stmts.push(db.prepare("INSERT INTO proxy_failover_log (t, kind, from_id, to_id, reason, ok, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(now, (r.simulated ? "test_" : "") + action.kind + (action.dry ? "_dry" : ""), action.from || "", action.to || "", s40(action.error || action.reason, 160), action.kind === "failover" || action.kind === "failback" ? (action.ok ? 1 : 0) : 0, source + (r.simulated ? "(模拟)" : "")));
  }
  if (!r.dry_run) await db.batch(stmts);
  let mailed = false;
  if (mayMail) {
    try { await sendProxyMail(env, r, { conclusion, subOk, sampOk, sampN, active, activeRes, action, pool, outs, now }); mailed = true; }
    catch (e) { console.log("proxy mail failed: " + String(e && e.message || e)); }
  }
  return { conclusion, state, changed, mailed, suppressed: changed && !mayMail && action.kind !== "failback", action, active: active ? active.id : null };
}
function poolLabel(pool, id) { const x = pool.find(p => p.id === id); return x ? x.host + ":" + x.port : id; }
async function sendProxyMail(env, r, c) {
  if (!env.DB) throw new Error("no DB binding");
  const a = c.action;
  let head;
  if (a.kind === "failover") head = a.ok ? "出站代理已自动切换：" + poolLabel(c.pool, a.from) + " → " + a.toHP : a.dry ? "（演练）将会切换到 " + a.toHP : "出站代理切换失败：" + (a.error || "");
  else if (a.kind === "no_standby") head = "当前出站代理 " + poolLabel(c.pool, a.from) + " 不通，但没有可用的备用出口，无法自动切换";
  else if (c.conclusion === "pass") head = "代理体检已恢复正常";
  else head = "代理体检发现异常";
  const subject = (r.simulated ? "[测试] " : "") + "[代理体检] " + head;
  const L = [head, ""];
  L.push("订阅：" + (c.subOk ? "正常" : "异常") + "（HTTP " + r.sub.code + "，节点 " + r.sub.nodes + " 个" + (r.sub.via && r.sub.via !== "direct" ? "，经出口代理拉取" : "") + "）" + (r.sub.err ? " · " + r.sub.err : ""));
  L.push("节点 WebSocket 抽检：" + c.sampOk + " / " + c.sampN + " 个返回 101");
  for (const s of r.samples) L.push("  " + (s.ok ? "✔" : "✖") + " " + s.name + " " + s.host + ":" + s.port + " → " + (s.code || "无响应") + (s.ok ? " · " + s.ms + "ms" : ""));
  L.push("", "出站代理：");
  for (const p of c.pool) {
    const o = c.outs[p.id];
    L.push("  " + (p.id === (c.active && c.active.id) ? "[当前] " : p.enabled ? "[备用] " : "[停用] ") + p.protocol + "://" + p.host + ":" + p.port + " → " + (o ? (o.ok ? "通 · " + o.ms + "ms · 出口 IP " + o.ip : "不通 · " + (o.err || "")) : "未检测"));
  }
  if (a.kind === "no_standby") L.push("", "出口池里只有这一个出口（或备用出口也不通），所以没有切换，cfnext 配置保持不变。", "请在工作台「代理节点」页面添加备用 SOCKS5：https://panel.example.com/admin/proxy");
  if (a.kind === "unmanaged") L.push("", "注意：" + a.reason + "，自动切换不会接管它。");
  if (a.kind === "config_unreadable") L.push("", "注意：读不到 cfnext 配置（" + a.reason + "）。");
  L.push("", "时间：" + fmtCN(c.now), "来源：" + (r.simulated ? "模拟测试报告" : "GitHub Actions 每小时巡检") + (r.run_url ? " · " + r.run_url : ""), "查看：https://panel.example.com/status · https://panel.example.com/admin/proxy");
  const body = b64utf8(L.join("\r\n")).replace(/.{1,76}/g, "$&\r\n");
  const mime = ["From: =?UTF-8?B?" + b64utf8("面板监控") + "?= <" + ALERT_FROM + ">", "To: <" + ALERT_TO + ">", "Subject: =?UTF-8?B?" + b64utf8(subject) + "?=",
    "Date: " + new Date(c.now).toUTCString().replace("GMT", "+0000"), "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  await outboxMime(env, "proxy", mime);
}
async function proxyView(env) {
  if (!env.DB) return null;
  try {
    const [h, pool, fl] = await env.DB.batch([
      env.DB.prepare("SELECT run_at, t, conclusion, sub_ok, sub_code, sub_via, node_count, samples, outbounds, active_id, run_url, simulated, action FROM proxy_health WHERE id = 1"),
      env.DB.prepare("SELECT id, host, port, protocol, enabled, is_active, last_ok_at, last_fail_at, last_ms, last_check_at FROM outbound_pool ORDER BY is_active DESC, created_at"),
      env.DB.prepare("SELECT t, kind, from_id, to_id, reason, ok FROM proxy_failover_log ORDER BY t DESC LIMIT 1")
    ]);
    const row = (h.results || [])[0] || null;
    if (row) { for (const k of ["samples", "outbounds", "action"]) { try { row[k] = JSON.parse(row[k] || "null"); } catch (e) { row[k] = null; } } }
    return { health: row, pool: pool.results || [], lastFailover: (fl.results || [])[0] || null };
  } catch (e) { return null; }
}

// ======================================================================================================
// ---- 令牌异常自动处置 (Cloudflare audit-log guard) ----
// Runs from the existing 5-minute cron every 15 minutes (no new cron trigger) and on demand from the hourly GitHub
// monitor (POST /api/guard-scan, x-ci-key). Reads account audit logs since the D1 cursor with GUARD_TOKEN (least
// privilege: Audit Logs Read + Account Settings Read + DNS Read/Write on this zone only, expires 2027-10-10).
// Flags writes to DNS / tunnels / API tokens / zone settings / WAF made by the high-risk all-access token, by an
// unregistered token, or from a source IP that is not in the allowlist (D1 guard_allow + IPs that logged into the workbench).
// Auto-action (the ONLY write): a DNS A/AAAA/CNAME record on this zone that was just CREATED (<= 2 h ago) by the
// high-risk token or an unregistered token, from an IP that is NOT on the allowlist, whose name is not protected,
// and whose content is still what was created -> DELETE it, keep the full record in D1 and email; the status card has
// a 「恢复」 button that re-creates it. Records created by trusted tokens / the dashboard login are never touched.
const G_ACC = "YOUR_CF_ACCOUNT_ID", G_ZONE = "YOUR_CF_ZONE_ID", G_HOST = "panel.example.com";
const PARENT_DOMAIN = G_HOST.split(".").slice(-2).join("."); // 上级域名（用于域名健康检查文案）
const G_API = "https://api.cloudflare.com/client/v4";
const G_HIGH = { "8fff6f5082c0863517c62b81bdd6d80e": "all-access-permanent（交给云端 AI 工具的全权限令牌）" };
const G_TRUSTED = {
  "0a07a87c3847f56eefde308293bd6ed7": "max-admin-permanent（Grok Bot 部署）", "72cc628eb24371851641da5c1588b754": "proxy-admin（建令牌用）",
  "137bbce7df0bfba52651ce53c3a7cb9d": "admin-panel-readonly", "5fe8e509a2e825c13d54f4f44a09fd09": "guard-autoresponse（本功能）",
  "4b2c03206cada541b9b6da32eed0e74c": "github-actions-backup-readonly", "5e53ff62a3e9669c46856e24a66068af": "github-actions-monitor-readonly",
  "578ed7b9697bb33d089c88c389f7dc39": "status-analytics-readonly"
};
const G_PROTECTED = new Set([G_HOST, "_dmarc." + G_HOST, "cf2024-1._domainkey." + G_HOST]);
// Seed allowlist (editable on the status card). weak=1: shared egress (WARP) - fine for trusted tokens, but it never
// vouches for the high-risk / unknown tokens.
const G_SEED = [
  // 受信 IP 种子：把你自己的出口 IP 按下面格式加进来
  // ["203.0.113.", "示例：家宽出口", 0],
];
const G_EVERY_MS = 15 * 60000, G_DELETE_WINDOW_MS = 2 * 3600000;
async function gEnsure(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS guard_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT, last_scan INTEGER, last_ok INTEGER, last_err TEXT, last_n INTEGER, last_flagged INTEGER, source TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS guard_alerts (id TEXT PRIMARY KEY, t INTEGER, seen_at INTEGER, cat TEXT, action TEXT, actor TEXT, token_id TEXT, token_cls TEXT, ip TEXT, ip_label TEXT, target TEXT, reasons TEXT, auto TEXT, record TEXT, restored INTEGER DEFAULT 0, mailed INTEGER DEFAULT 0, baseline INTEGER DEFAULT 0)"),
    db.prepare("CREATE INDEX IF NOT EXISTS guard_alerts_seen ON guard_alerts(seen_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS guard_allow (ip TEXT PRIMARY KEY, label TEXT, weak INTEGER DEFAULT 0, added_at INTEGER, src TEXT)")
  ]);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM guard_allow").first();
  if (!n || !n.n) await db.batch(G_SEED.map(([ip, label, weak]) => db.prepare("INSERT OR IGNORE INTO guard_allow (ip, label, weak, added_at, src) VALUES (?1, ?2, ?3, ?4, 'seed')").bind(ip, label, weak, Date.now())));
}
// ---------- GitHub Actions runner IPs (「自家巡检」) + cloud-provider guess ----------
// Ranges come from https://api.github.com/meta ("actions" + "actions_macos"), fetched at most once per day and cached in
// D1 admin_cache (k='gh_actions'; shared by the admin + status workers). Parsed once per isolate.
const GH_TTL = 86400000;
let GH_MEM = null; // { t, v4: [[start,end],...] sorted, v6: [[BigInt net, BigInt mask],...] }
function ip4n(ip) { const p = String(ip).split("."); if (p.length !== 4) return -1; let n = 0; for (const x of p) { const v = Number(x); if (!/^\d{1,3}$/.test(x) || v > 255) return -1; n = n * 256 + v; } return n; }
function ip6n(ip) {
  ip = String(ip).toLowerCase().split("%")[0]; if (!ip.includes(":")) return null;
  let [h, t] = ip.split("::"); const hp = h ? h.split(":") : [], tp = t !== undefined ? (t ? t.split(":") : []) : [];
  if (t === undefined && hp.length !== 8) return null;
  const mid = new Array(8 - hp.length - tp.length).fill("0"); const all = [...hp, ...mid, ...tp]; if (all.length !== 8) return null;
  let n = 0n; for (const g of all) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; n = (n << 16n) + BigInt(parseInt(g, 16)); } return n;
}
function cidrParse(list) {
  const v4 = [], v6 = [];
  for (const c of list || []) {
    const [a, b] = String(c).split("/"); const len = Number(b);
    if (a.includes(":")) { const n = ip6n(a); if (n === null) continue; const mask = len ? ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - len)) - 1n) : 0n; v6.push([n & mask, mask]); }
    else { const n = ip4n(a); if (n < 0) continue; const size = 2 ** (32 - len); const s = Math.floor(n / size) * size; v4.push([s, s + size - 1]); }
  }
  v4.sort((x, y) => x[0] - y[0]);
  return { v4, v6 };
}
function cidrHas(m, ip) {
  if (!m) return false; ip = String(ip || "");
  if (ip.includes(":")) { const n = ip6n(ip); if (n === null) return false; for (const [net, mask] of m.v6) if ((n & mask) === net) return true; return false; }
  const n = ip4n(ip); if (n < 0) return false;
  let lo = 0, hi = m.v4.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (m.v4[mid][0] <= n) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  // ranges may nest/overlap: check a few candidates to the left
  for (let i = best; i >= 0 && i > best - 64; i--) if (n >= m.v4[i][0] && n <= m.v4[i][1]) return true;
  return false;
}
async function ghLoad(env) {
  const now = Date.now();
  if (GH_MEM && now - GH_MEM.t < GH_TTL) return GH_MEM;
  let row = null;
  try { row = await env.DB.prepare("SELECT t, v FROM admin_cache WHERE k='gh_actions'").first(); } catch (e) {}
  let list = null; try { list = row && row.v ? JSON.parse(row.v) : null; } catch (e) {}
  if (!row || now - Number(row.t) >= GH_TTL) {
    let fresh = null;
    try {
      const r = await fetch("https://api.github.com/meta", { headers: { "user-agent": "domain-guard-panel/1.0 (+https://panel.example.com)", "accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(6000) });
      if (r.ok) { const j = await r.json(); const a = [...(j.actions || []), ...(j.actions_macos || [])]; if (a.length > 100) fresh = a; }
    } catch (e) {}
    if (fresh) list = fresh;
    // on failure keep the old list and retry in ~1 hour (never more than that)
    const t = fresh ? now : now - GH_TTL + 3600000;
    try { await env.DB.prepare("INSERT OR REPLACE INTO admin_cache (k, t, v) VALUES ('gh_actions', ?1, ?2)").bind(t, JSON.stringify(list || [])).run(); } catch (e) {}
    row = { t };
  }
  const m = cidrParse(list || []);
  GH_MEM = { t: Math.min(Number(row.t) || now, now), n: (list || []).length, v4: m.v4, v6: m.v6 };
  return GH_MEM;
}
function isGhUa(ua) { ua = String(ua || ""); return /\+github-actions/i.test(ua) || /^domain-guard-/i.test(ua); }
function isGhIp(ip) { return cidrHas(GH_MEM, ip); }
async function gAllow(db) {
  try { await ghLoad({ DB: db }); } catch (e) {}
  const rows = (await db.prepare("SELECT ip, label, weak FROM guard_allow").all()).results || [];
  const logins = new Set();
  try { for (const r of ((await db.prepare("SELECT DISTINCT ip FROM admin_log WHERE type='login' AND t > ?1").bind(Date.now() - 30 * 86400000).all()).results || [])) if (r.ip) logins.add(r.ip); } catch (e) {}
  return { rows, logins };
}
// GitHub Actions runners (api.github.com/meta IP ranges only; the UA is just a hint) = 「自家巡检」. Classed "weak" like WARP:
// anyone can rent a GitHub runner, so it is not 陌生 for registered tokens but never vouches for the high-risk / unknown tokens.
function gIpClass(ip, allow, ua) {
  ip = String(ip || "").toLowerCase();
  if (!ip) return { k: "none", label: "（无 IP，平台内部）" + (isGhUa(ua) ? " · UA 自称巡检" : "") };
  let best = null;
  for (const r of allow.rows) {
    const p = String(r.ip).toLowerCase();
    const hit = /[.:]$/.test(p) || /^2a09:bac$/.test(p) ? ip.startsWith(p) : ip === p;
    if (hit && (!best || (best.weak && !r.weak))) best = r;
  }
  if (best) return { k: best.weak ? "weak" : "full", label: best.label };
  if (allow.logins.has(ip)) return { k: "full", label: "登录过工作台的 IP" };
  if (isGhIp(ip)) return { k: "weak", label: "自家巡检（GitHub Actions）" }; // M2: by GitHub IP ranges only, never by UA
  return { k: "unknown", label: "陌生 IP" + (isGhUa(ua) ? "（UA 自称 GitHub 巡检，但 IP 不在 GitHub 范围）" : "") };
}
function gCat(e) {
  const r = e.resource || {}, raw = e.raw || {};
  const uri = String(raw.uri || ""), prod = String(r.product || ""), rt = String(r.type || "");
  if (/^dns(_records)?$/.test(prod) || /\/dns_records/.test(uri)) return "dns";
  if (prod === "cfd_tunnel" || /\/cfd_tunnel|\/tunnels(\/|$)/.test(uri)) return "tunnel";
  if (/(^|\/)tokens(\/|$)/.test(uri) || rt === "tokens" || /token/i.test(prod)) return "token";
  if (/rulesets|firewall|waf|rate_limit|page_shield/.test(prod) || /\/(rulesets|firewall|rate_limits|filters|waf)(\/|$)/.test(uri)) return "waf";
  if (prod === "settings" || rt === "zone_settings" || /\/zones\/[0-9a-f]+\/settings(\/|$)/.test(uri)) return "zone";
  return "";
}
const G_CAT_CN = { dns: "DNS 记录", tunnel: "隧道", token: "API 令牌", waf: "WAF / 防火墙规则", zone: "域名设置" };
const G_ACT_CN = { create: "新建", update: "修改", delete: "删除" };
function gIsWrite(e) {
  const m = String((e.raw && e.raw.method) || "").toUpperCase(), t = String((e.action && e.action.type) || "").toLowerCase();
  if (m) return !/^(GET|HEAD|OPTIONS)$/.test(m);
  return /create|update|delete|edit|add|remove|rotate|roll|revoke/.test(t);
}
function gObj(v) { if (v && typeof v === "object") return v; try { return JSON.parse(String(v || "")); } catch (e) { return {}; } }
function gTarget(e) {
  const r = e.resource || {}, req = gObj(r.request), resp = gObj(r.response), raw = e.raw || {};
  const parts = [];
  const t = req.type || resp.type, n = resp.name || req.name, c = req.content || resp.content;
  if (t) parts.push(t); if (n) parts.push(n); if (c) parts.push("→ " + c);
  if (!parts.length && r.id) parts.push(String(r.id));
  if (!parts.length && raw.uri) parts.push(String(raw.uri).replace("/accounts/" + G_ACC, "/acc").replace("/zones/" + G_ZONE, "/zone"));
  return parts.join(" ").slice(0, 220);
}
function gClassify(e, allow) {
  const a = e.actor || {}, ac = e.action || {};
  if (String(a.type || "") === "system" || !gIsWrite(e)) return null;
  const cat = gCat(e); if (!cat) return null;
  const tok = a.token && a.token.id ? String(a.token.id) : "";
  if (tok === "5fe8e509a2e825c13d54f4f44a09fd09") return null; // this feature's own delete / restore calls (Cloudflare Worker egress IPs)
  const tokenCls = tok ? (G_HIGH[tok] ? "high" : G_TRUSTED[tok] ? "trusted" : "unknown") : (a.context === "dash" ? "dash" : "nokey");
  const ipc = gIpClass(a.ip_address, allow, e.raw && e.raw.user_agent);
  const reasons = [];
  if (tokenCls === "high") reasons.push("高风险令牌（交给云端 AI 工具的全权限令牌）");
  if (tokenCls === "unknown") reasons.push("未登记的 API 令牌");
  if (ipc.k === "unknown") reasons.push(tokenCls === "dash" ? "网页控制台从陌生 IP 登录操作" : "陌生来源 IP");
  if (ipc.k === "weak" && (tokenCls === "high" || tokenCls === "unknown")) reasons.push(/自家巡检/.test(ipc.label) ? "来自 GitHub Actions 共享机房（任何人都能租用）" : "来自共享 WARP 出口");
  if (!reasons.length) return null;
  const actor = tok ? ((a.token.name || "") + "（" + tok.slice(0, 8) + "）") : tokenCls === "dash" ? "网页控制台（" + (a.email || "账号登录") + "）" : "API（" + (a.context || "无令牌信息") + "）";
  return { id: String(e.id || ""), t: Date.parse(ac.time) || 0, cat, type: String(ac.type || "").toLowerCase(), action: String(ac.description || ac.type || "").slice(0, 120),
    ok: /success/i.test(String(ac.result || "")), actor: actor.slice(0, 160), tok, tokenCls, ip: String(a.ip_address || ""), ipc, target: gTarget(e), reasons };
}
async function gApi(env, path, init) {
  const r = await fetch(G_API + path, Object.assign({}, init || {}, { headers: Object.assign({ "authorization": "Bearer " + env.GUARD_TOKEN, "content-type": "application/json" }, (init && init.headers) || {}) }));
  let d; try { d = await r.json(); } catch (e) { d = { success: false, errors: [{ message: "HTTP " + r.status }] }; }
  d._status = r.status;
  return d;
}
// Auto-delete decision for one flagged event (see header). Returns {auto, record} ; auto: "" | "deleted" | "delete_failed" | "gone" | "changed" | "skip:<why>"
async function gAutoAction(env, f, e, now, opts) {
  if (f.cat !== "dns" || f.type !== "create" || !f.ok) return { auto: "" };
  if (!(f.tokenCls === "high" || f.tokenCls === "unknown")) return { auto: "" };
  if (!(f.ipc.k === "unknown" || f.ipc.k === "weak")) return { auto: "skip:来源 IP 在白名单" };
  const uri = String((e.raw && e.raw.uri) || "");
  if (uri.indexOf("/zones/" + G_ZONE + "/") < 0) return { auto: "skip:不是本域名" };
  const resp = gObj(e.resource && e.resource.response), req = gObj(e.resource && e.resource.request);
  const rid = String(resp.id || "");
  const type = String(resp.type || req.type || "").toUpperCase(), name = String(resp.name || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(rid)) return { auto: "skip:审计日志里没有记录 ID" };
  if (!/^(A|AAAA|CNAME)$/.test(type)) return { auto: "skip:只自动处理 A / AAAA / CNAME" };
  if (G_PROTECTED.has(name)) return { auto: "skip:受保护的记录名" };
  if (now - f.t > G_DELETE_WINDOW_MS && !opts.force) return { auto: "skip:超过 2 小时，只告警" };
  if (opts.dry) return { auto: "would_delete" };
  const cur = await gApi(env, "/zones/" + G_ZONE + "/dns_records/" + rid);
  if (cur._status === 404 || (cur.errors || []).some(x => x.code === 81044)) return { auto: "gone" };
  if (!cur.success || !cur.result) return { auto: "delete_failed", err: "读取记录失败" };
  const rec = cur.result;
  if (String(rec.type).toUpperCase() !== type || String(rec.name).toLowerCase() !== name || (resp.content && String(rec.content) !== String(resp.content))) return { auto: "changed", record: rec };
  const keep = { id: rec.id, type: rec.type, name: rec.name, content: rec.content, proxied: !!rec.proxied, ttl: rec.ttl || 1, comment: rec.comment || "" };
  const del = await gApi(env, "/zones/" + G_ZONE + "/dns_records/" + rid, { method: "DELETE" });
  if (!del.success) return { auto: "delete_failed", record: keep, err: ((del.errors || [])[0] || {}).message || ("HTTP " + del._status) };
  return { auto: "deleted", record: keep };
}
async function guardScan(env, opts) {
  opts = opts || {};
  if (!env.DB || !env.GUARD_TOKEN) return { ok: false, error: "GUARD_TOKEN / DB missing" };
  const db = env.DB, now = Date.now();
  await gEnsure(db);
  const st = await db.prepare("SELECT cursor, last_scan FROM guard_state WHERE id = 1").first().catch(() => null);
  if (opts.cron && st && st.last_scan && now - st.last_scan < G_EVERY_MS - 60000) return { ok: true, skipped: "not due" };
  const first = !(st && st.cursor);
  const sinceMs = opts.since ? Date.parse(opts.since) : first ? now - 24 * 3600000 : Date.parse(st.cursor) - 60000; // 1-min overlap, deduped by event id
  const since = new Date(sinceMs).toISOString().slice(0, 19) + "Z", before = new Date(now).toISOString().slice(0, 19) + "Z";
  const events = [];
  let cursor = "", pages = 0, err = "";
  do {
    const d = await gApi(env, "/accounts/" + G_ACC + "/logs/audit?since=" + since + "&before=" + before + "&limit=1000&direction=asc" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    if (!d.success) { err = ((d.errors || [])[0] || {}).message || ("HTTP " + d._status); break; }
    for (const e of d.result || []) events.push(e);
    cursor = (d.result_info && d.result_info.cursor) || "";
    pages++;
  } while (cursor && pages < 5);
  if (err) {
    if (!opts.dry) await db.prepare("INSERT INTO guard_state (id, cursor, last_scan, last_ok, last_err, last_n, last_flagged, source) VALUES (1, ?1, ?2, 0, ?3, 0, 0, ?4) ON CONFLICT(id) DO UPDATE SET last_scan=excluded.last_scan, last_ok=0, last_err=excluded.last_err, source=excluded.source").bind(st && st.cursor || null, now, String(err).slice(0, 200), opts.source || "cron").run();
    return { ok: false, error: err };
  }
  if (opts.inject) events.push(opts.inject); // test path only (POST /api/guard-scan {test_record_id}), clearly marked
  const allow = await gAllow(db);
  const flagged = [];
  let maxT = sinceMs;
  for (const e of events) {
    const t = Date.parse(e.action && e.action.time) || 0; if (t > maxT && !e._test) maxT = t;
    const f = gClassify(e, allow); if (!f || !f.id) continue;
    if (!opts.dry && !e._test) {
      // 16: atomic claim - the cron scan and the GitHub-triggered scan can overlap; only the run that inserts the row handles it.
      const c = await db.prepare("INSERT OR IGNORE INTO guard_alerts (id, t, seen_at, cat, action, auto, mailed, baseline) VALUES (?1, ?2, ?3, ?4, '处理中', 'claim', 0, 0)").bind(f.id, f.t, now, f.cat).run();
      if (!c.meta || !c.meta.changes) continue;
    }
    const act = await gAutoAction(env, f, e, now, { dry: opts.dry, force: !!e._test });
    f.auto = act.auto; f.record = act.record || null; f.autoErr = act.err || "";
    f.baseline = first && !e._test ? 1 : 0; // first run: last-24 h backlog is listed but not emailed
    f.test = !!e._test;
    flagged.push(f);
  }
  if (opts.dry) return { ok: true, dry: true, scanned: events.length, since, flagged };
  const toMail = flagged.filter(f => !f.baseline);
  let mailed = false;
  if (toMail.length) { try { await gMail(env, toMail, now); mailed = true; } catch (e) { console.log("guard mail failed: " + String(e && e.message || e)); } }
  const ins = db.prepare("INSERT OR REPLACE INTO guard_alerts (id, t, seen_at, cat, action, actor, token_id, token_cls, ip, ip_label, target, reasons, auto, record, restored, mailed, baseline) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?16)");
  const stmts = flagged.map(f => ins.bind(f.id, f.t, now, f.cat, (f.test ? "[测试] " : "") + (G_ACT_CN[f.type] || f.type) + " · " + f.action, f.actor, f.tok, f.tokenCls, f.ip, f.ipc.label, f.target, f.reasons.join("；"), f.auto + (f.autoErr ? ":" + f.autoErr : ""), f.record ? JSON.stringify(f.record) : null, mailed && !f.baseline ? 1 : 0, f.baseline));
  stmts.push(db.prepare("INSERT INTO guard_state (id, cursor, last_scan, last_ok, last_err, last_n, last_flagged, source) VALUES (1, ?1, ?2, ?2, '', ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor, last_scan=excluded.last_scan, last_ok=excluded.last_ok, last_err='', last_n=excluded.last_n, last_flagged=excluded.last_flagged, source=excluded.source")
    .bind(new Date(Math.max(maxT, sinceMs)).toISOString(), now, events.length, flagged.length, opts.source || "cron"));
  stmts.push(db.prepare("DELETE FROM guard_alerts WHERE seen_at < ?1").bind(now - 60 * 86400000));
  await db.batch(stmts);
  return { ok: true, scanned: events.length, since, flagged: flagged.length, mailed, deleted: flagged.filter(f => f.auto === "deleted").length,
    items: flagged.map(f => ({ id: f.id, cat: f.cat, type: f.type, tokenCls: f.tokenCls, ip: f.ip, ipk: f.ipc.k, target: f.target, auto: f.auto, baseline: f.baseline, test: f.test })) };
}
function gMime(subject, lines, now) {
  return ["From: =?UTF-8?B?" + b64utf8("面板监控") + "?= <" + ALERT_FROM + ">", "To: <" + ALERT_TO + ">", "Subject: =?UTF-8?B?" + b64utf8(subject) + "?=",
    "Date: " + new Date(now).toUTCString().replace("GMT", "+0000"), "Message-ID: <" + crypto.randomUUID() + "@" + G_HOST + ">", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64utf8(lines.join("\r\n")).replace(/.{1,76}/g, "$&\r\n")].join("\r\n");
}
async function gMail(env, list, now) {
  if (!env.DB) throw new Error("no DB binding");
  const del = list.filter(f => f.auto === "deleted").length, test = list.every(f => f.test);
  const subject = (test ? "[测试] " : "") + "[安全告警] Cloudflare 发现 " + list.length + " 条可疑操作" + (del ? "，已自动删除 " + del + " 条 DNS 记录" : "");
  const L = ["令牌异常自动处置：账户审计日志里出现了下面这些操作（DNS / 隧道 / 令牌 / 域名设置 / WAF）。", ""];
  list.slice(0, 25).forEach((f, i) => {
    L.push((i + 1) + ". " + (G_CAT_CN[f.cat] || f.cat) + " · " + (G_ACT_CN[f.type] || f.type) + " · " + f.action + (f.ok ? "" : "（失败）"));
    L.push("   时间：" + fmtCN(f.t));
    L.push("   操作者：" + f.actor);
    L.push("   来源 IP：" + (f.ip || "—") + "（" + f.ipc.label + "）");
    L.push("   对象：" + (f.target || "—"));
    L.push("   原因：" + f.reasons.join("；"));
    if (f.auto === "deleted") L.push("   ★ 已自动删除这条新建的 DNS 记录（" + f.record.type + " " + f.record.name + " → " + f.record.content + "）。如果是你自己建的，打开 https://" + G_HOST + "/status ，在「令牌异常自动处置」卡片里点「恢复」即可一键恢复。");
    else if (f.auto === "delete_failed") L.push("   ✖ 尝试自动删除失败：" + (f.autoErr || "") + "，请尽快人工检查。");
    else if (f.auto === "gone") L.push("   记录已经不存在，无需处理。");
    else if (f.auto === "changed") L.push("   记录内容已被再次修改，没有自动删除，请人工确认。");
    else if (String(f.auto).indexOf("skip:") === 0) L.push("   未自动处理：" + f.auto.slice(5));
    L.push("");
  });
  if (list.length > 25) L.push("……另外还有 " + (list.length - 25) + " 条，见状态面板。", "");
  L.push("处置规则：只有「高风险令牌或未登记令牌」从「不在白名单的 IP」新建的 A/AAAA/CNAME 记录会被自动删除；其他情况只发这封邮件。", "",
    "如果都是你本人或你授权的工具做的，可以忽略；如果不认识，请立刻到 Cloudflare 撤销对应令牌：https://dash.cloudflare.com/profile/api-tokens", "",
    "时间：" + fmtCN(now), "查看：https://" + G_HOST + "/status · https://" + G_HOST + "/admin/audit");
  await outboxMime(env, "token", gMime(subject, L, now));
}
async function guardRestore(env, id, who) {
  const db = env.DB;
  await gEnsure(db);
  const row = await db.prepare("SELECT id, auto, record, restored FROM guard_alerts WHERE id = ?1").bind(String(id || "").slice(0, 64)).first();
  if (!row || String(row.auto).indexOf("deleted") !== 0 || !row.record) return { ok: false, error: "找不到可恢复的记录" };
  if (row.restored) return { ok: false, error: "已经恢复过了" };
  const r = gObj(row.record);
  const body = { type: r.type, name: r.name, content: r.content, proxied: !!r.proxied, ttl: r.ttl || 1, comment: ("由面板「恢复」按钮恢复 " + fmtCN(Date.now())).slice(0, 100) };
  const d = await gApi(env, "/zones/" + G_ZONE + "/dns_records", { method: "POST", body: JSON.stringify(body) });
  if (!d.success) return { ok: false, error: "Cloudflare 拒绝：" + (((d.errors || [])[0] || {}).message || ("HTTP " + d._status)) };
  await db.prepare("UPDATE guard_alerts SET restored = ?2 WHERE id = ?1").bind(row.id, Date.now()).run();
  return { ok: true, record: { type: r.type, name: r.name, content: r.content }, by: who || "" };
}
async function guardView(env) {
  if (!env.DB) return null;
  try {
    await gEnsure(env.DB);
    const since = Date.now() - 86400000;
    const [st, al, agg, allow] = await env.DB.batch([
      env.DB.prepare("SELECT cursor, last_scan, last_ok, last_err, last_n, last_flagged, source FROM guard_state WHERE id = 1"),
      env.DB.prepare("SELECT id, t, seen_at, cat, action, actor, token_cls, ip, ip_label, target, reasons, auto, record, restored, mailed, baseline FROM guard_alerts ORDER BY t DESC LIMIT 15"),
      env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(auto LIKE 'deleted%'),0) AS del FROM guard_alerts WHERE seen_at >= ?1 AND baseline = 0 AND id NOT LIKE 'test-%'").bind(since),
      env.DB.prepare("SELECT ip, label, weak, src FROM guard_allow ORDER BY src DESC, added_at")
    ]);
    const alerts = (al.results || []).map(a => { let rec = null; try { rec = a.record ? JSON.parse(a.record) : null; } catch (e) {} delete a.record; a.rec = rec ? { type: rec.type, name: rec.name, content: rec.content } : null; return a; });
    return { configured: !!env.GUARD_TOKEN, state: (st.results || [])[0] || null, alerts, day: (agg.results || [])[0] || { n: 0, del: 0 }, allow: allow.results || [], every_min: 15 };
  } catch (e) { console.log("guardView: " + String(e && e.message || e)); return null; }
}
// Same-origin browser POSTs from the status card (via portal, gate session + x-svc-key already enforced).
function sameOrigin(request) {
  const o = request.headers.get("origin") || "";
  return o === "https://" + G_HOST && request.headers.get("x-guard") === "1";
}
async function guardApi(request, env, p) {
  if (request.method !== "POST" || !sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  let b; try { b = JSON.parse((await request.text()).slice(0, 4000)); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
  const ip = request.headers.get("cf-connecting-ip") || "";
  await gEnsure(env.DB);
  if (p === "/api/guard/restore") return json(await guardRestore(env, b && b.id, ip));
  if (p === "/api/guard/allow") {
    const v = String(b && b.ip || "").trim().toLowerCase();
    if (!/^([0-9]{1,3}\.){1,3}[0-9]{0,3}$/.test(v) && !/^[0-9a-f:]{2,39}$/.test(v)) return json({ ok: false, error: "IP 格式不对（可以写完整 IP，或以 . / : 结尾的前缀）" }, 400);
    if (/^([0-9]{1,3}\.){1}$/.test(v) || /^[0-9a-f]{1,4}:$/.test(v)) return json({ ok: false, error: "前缀太宽了" }, 400);
    const label = String(b && b.label || "").replace(/[<>]/g, "").trim().slice(0, 60) || "手动添加";
    await env.DB.prepare("INSERT OR REPLACE INTO guard_allow (ip, label, weak, added_at, src) VALUES (?1, ?2, 0, ?3, 'user')").bind(v, label, Date.now()).run();
    return json({ ok: true });
  }
  if (p === "/api/guard/allow-del") {
    await env.DB.prepare("DELETE FROM guard_allow WHERE ip = ?1").bind(String(b && b.ip || "").slice(0, 60)).run();
    return json({ ok: true });
  }
  return json({ ok: false, error: "not found" }, 404);
}
// POST /api/guard-scan (x-ci-key): {dry?, since?} -> run now ; {test_record_id} -> end-to-end test against a record we created
// ourselves (synthetic event marked [测试], attributed to the high-risk token from TEST-NET IP 203.0.113.9) ; {restore_id} -> restore.
async function guardScanApi(request, env) {
  if (!(await keyOk(request.headers.get("x-ci-key"), env.CI_REPORT_KEY)) && !(await writeKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  let b = {}; try { b = JSON.parse((await request.text()).slice(0, 4000) || "{}"); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
  try {
    if ((b.restore_id || b.test_record_id) && !(await writeKeyOk(request, env))) return json({ ok: false, error: "forbidden (write key required)" }, 403);
    if (b.restore_id) return json(await guardRestore(env, b.restore_id, "ci"));
    const opts = { dry: !!b.dry, since: b.since || null, source: String(b.source || "github-actions").slice(0, 40) };
    if (b.test_record_id) {
      const rid = String(b.test_record_id).replace(/[^0-9a-f]/g, "").slice(0, 32);
      const cur = await gApi(env, "/zones/" + G_ZONE + "/dns_records/" + rid);
      if (!cur.success || !/^guard-test-/.test(String(cur.result && cur.result.name))) return json({ ok: false, error: "test record must exist and be named guard-test-*" }, 400);
      const r = cur.result;
      opts.inject = { _test: true, id: "test-" + crypto.randomUUID(), action: { type: "create", description: "Create DNS Record", result: "success", time: new Date().toISOString() },
        actor: { type: "user", context: "api_token", ip_address: "203.0.113.9", token: { id: "8fff6f5082c0863517c62b81bdd6d80e", name: "all-access-permanent-20261008-2252" } },
        raw: { method: "POST", uri: "/zones/" + G_ZONE + "/dns_records", status_code: 200 },
        resource: { product: "dns_records", request: { type: r.type, name: r.name.split(".")[0], content: r.content }, response: { id: r.id, type: r.type, name: r.name, content: r.content } } };
    }
    return json(await guardScan(env, opts));
  } catch (e) { console.error("guard-scan error: " + String(e && e.stack || e)); return json({ ok: false, error: "internal error" }, 500); }
}

// ======================================================================================================
// ---- 每日报告 (daily digest) ----
// Triggered by GitHub Actions domain-guard `daily-report` (08:17 UTC+8) -> POST /api/daily-report (x-ci-key) with the open
// GitHub alert issues; this Worker gathers the rest from D1 + Cloudflare GraphQL and sends the email through MAIL.
// Uptime comes from D1 health_log (one row per service per 5-minute cron run, kept 30 days).
const D_SVC = [["portal", "入口 / 工作台"], ["cfnext", "cfnext 代理面板"], ["drive", "drive 网盘"], ["otp", "otp 验证码"]];
async function healthLog(env, cur, now) {
  if (!env.DB) return;
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS health_log (t INTEGER, svc TEXT, ok INTEGER, ms INTEGER)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS health_log_t ON health_log(t)").run();
  const st = db.prepare("INSERT INTO health_log (t, svc, ok, ms) VALUES (?1, ?2, ?3, ?4)");
  const rows = Object.entries(cur).map(([k, r]) => st.bind(now, k, r.ok ? 1 : 0, r.ms || 0));
  // retention: 30 days, pruned once a day (bPrune, 04:00 UTC+8)
  await db.batch(rows);
}
async function dGql(env, cfg, s, e) {
  if (!env.CF_ZONE_ID || !env.CF_ANALYTICS_TOKEN) return { err: "未配置分析令牌" };
  const path = cfg && cfg.path ? "/" + cfg.path : "";
  const q = `query($z:String!,$s:Time!,$e:Time!${path ? ",$sub:String!,$ws:String!" : ""}){viewer{zones(filter:{zoneTag:$z}){
 sec:httpRequestsAdaptiveGroups(limit:20,filter:{datetime_geq:$s,datetime_leq:$e,securityAction_neq:"unknown"},orderBy:[count_DESC]){count dimensions{securityAction securitySource}}
 tot:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$e}){count}
 ${path ? `sub:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$e,clientRequestPath_like:$sub}){count}
 ws:httpRequestsAdaptiveGroups(limit:5,filter:{datetime_geq:$s,datetime_leq:$e,clientRequestPath:$ws,edgeResponseStatus:101}){count sum{edgeResponseBytes}}` : ""}}}}`;
  const iso = t => new Date(t).toISOString().slice(0, 19) + "Z";
  const vars = { z: env.CF_ZONE_ID, s: iso(s), e: iso(e) };
  if (path) { vars.sub = path + "/sub%"; vars.ws = path; }
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { "Authorization": "Bearer " + env.CF_ANALYTICS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: vars }) });
    const d = await r.json();
    if (d.errors && d.errors.length) return { err: String(d.errors[0].message || "GraphQL 错误").slice(0, 160) };
    const z = d.data.viewer.zones[0] || {};
    const sec = {}; let blocked = 0, challenged = 0;
    for (const g of z.sec || []) { const a = g.dimensions.securityAction, src = g.dimensions.securitySource; sec[a + "/" + src] = g.count; if (/block/.test(a)) blocked += g.count; else if (/challenge/.test(a)) challenged += g.count; }
    const ws = z.ws || [];
    return { requests: ((z.tot || [])[0] || {}).count || 0, blocked, challenged, sec, subPulls: path ? (((z.sub || [])[0] || {}).count || 0) : null,
      wsConns: ws.reduce((a, g) => a + (g.count || 0), 0), wsBytes: ws.reduce((a, g) => a + ((g.sum || {}).edgeResponseBytes || 0), 0) };
  } catch (e) { return { err: "分析接口请求失败" }; }
}
function dBytes(n) { n = Number(n) || 0; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; }
async function buildDaily(env, b) {
  const db = env.DB, now = Date.now(), since = now - 86400000;
  try { await gEnsure(db); } catch (e) {}
  await db.prepare("CREATE TABLE IF NOT EXISTS health_log (t INTEGER, svc TEXT, ok INTEGER, ms INTEGER)").run();
  const q = (sql, ...a) => db.prepare(sql).bind(...a);
  const [up, first, logins, fails, ev, ph, bk, ci, ga] = await db.batch([
    q("SELECT svc, COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok, CAST(AVG(ms) AS INTEGER) AS ms FROM health_log WHERE t >= ?1 GROUP BY svc", since),
    q("SELECT MIN(t) AS t FROM health_log WHERE t >= ?1", since),
    q("SELECT COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM admin_log WHERE type = 'login' AND t >= ?1", since),
    q("SELECT COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM events WHERE type = 'auth' AND t >= ?1", since),
    q("SELECT COUNT(*) AS n, COALESCE(SUM(type = 'probe'),0) AS probes FROM events WHERE t >= ?1 AND " + SEC_OWN, since),
    db.prepare("SELECT run_at, t, conclusion, sub_ok, node_count, samples, active_id FROM proxy_health WHERE id = 1"),
    db.prepare("SELECT run_at, conclusion, workers, d1_rows, changed, commit_url FROM backup_status WHERE id = 1"),
    db.prepare("SELECT run_at, conclusion, passed, failed FROM ci_status WHERE id = 1"),
    q("SELECT COUNT(*) AS n, COALESCE(SUM(auto LIKE 'deleted%'),0) AS del FROM guard_alerts WHERE seen_at >= ?1 AND baseline = 0 AND id NOT LIKE 'test-%'", since)
  ]);
  const one = r => (r.results || [])[0] || null;
  // 21: things that no longer email individually are summarised here.
  const quiet = { subCopies: 0, manual: [], auto: [], newLogins: 0, suppressed: [] };
  try {
    const [sc, fl, nl, sg] = await db.batch([
      q("SELECT COUNT(*) AS n FROM admin_log WHERE type = 'admin_sub' AND t >= ?1", since),
      q("SELECT t, kind, from_id, to_id, ok FROM proxy_failover_log WHERE t >= ?1 AND kind NOT LIKE 'test_%' ORDER BY t", since),
      q("SELECT COUNT(*) AS n FROM seen_login WHERE first >= ?1", since),
      q("SELECT k, suppressed FROM alert_gate WHERE t >= ?1 AND suppressed > 0", since - 3600000)
    ]);
    quiet.subCopies = (one(sc) || {}).n || 0;
    for (const x of fl.results || []) (x.kind === "manual" ? quiet.manual : quiet.auto).push({ t: x.t, kind: x.kind, from: x.from_id, to: x.to_id, ok: !!x.ok });
    quiet.newLogins = (one(nl) || {}).n || 0;
    quiet.suppressed = (sg.results || []).map(x => ({ k: String(x.k), n: x.suppressed }));
  } catch (e) { console.log("daily quiet: " + String(e && e.message || e)); }
  let cfg = null; try { cfg = env.CFK ? JSON.parse(await env.CFK.get("config")) : null; } catch (e) {}
  const gql = await dGql(env, cfg, since, now);
  let leak = null;
  try { const l = await db.prepare("SELECT t, status, reasons, data, incident_at, mailed_at, err FROM leak_state WHERE id = 1").first(); if (l) { const d = JSON.parse(l.data || "{}"); leak = { t: l.t, status: l.status, reasons: JSON.parse(l.reasons || "[]"), other24: (d.h24 || {}).other || 0, dc24: (d.h24 || {}).dc || 0, self24: (d.h24 || {}).self || 0, incident_at: l.incident_at, err: l.err }; } } catch (e) {}
  let cfgv = null;
  try { cfgv = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(t >= ?1), 0) AS d FROM cfnext_config_versions").bind(since).first(); } catch (e) {}
  // Outlook mailbox reachable (MS token alive)? Uses the otp-panel /api/latest the workbench 「最新验证码」 card uses; no code is kept here.
  let otp = { ok: false, err: "" };
  try {
    const rr = await env.OTP.fetch("https://panel.example.com/api/latest", { headers: { "x-svc-key": env.SVC_KEY, "User-Agent": "status-daily" } });
    const j = await rr.json(); otp = { ok: !!(j && j.ok && !j.err), err: String((j && j.err) || (rr.ok ? "" : "HTTP " + rr.status)).slice(0, 120), recent: !!(j && j.fresh) };
  } catch (e) { otp = { ok: false, err: "请求失败" }; }
  // services
  const upMap = {}; for (const r of up.results || []) upMap[r.svc] = r;
  let cur = {}; try { for (const r of ((await db.prepare("SELECT svc, up FROM health").all()).results || [])) cur[r.svc] = !!r.up; } catch (e) {}
  const svcs = D_SVC.map(([k, name]) => { const r = upMap[k]; const pct = r && r.n ? Math.round(r.ok / r.n * 1000) / 10 : null; return { k, name, pct, n: r ? r.n : 0, ms: r ? r.ms : null, now: k in cur ? cur[k] : null }; });
  const proxy = one(ph), backup = one(bk), cist = one(ci), guard = one(ga) || { n: 0, del: 0 };
  let samp = []; try { samp = proxy ? JSON.parse(proxy.samples || "[]") : []; } catch (e) {}
  const issues = (Array.isArray(b.issues) ? b.issues : []).slice(0, 10).map(x => ({ title: String(x && x.title || "").slice(0, 120), url: ghUrl(x && x.url) }));
  const warn = [];
  for (const s of svcs) if (s.pct != null && s.pct < 99) warn.push(s.name + " 在线率 " + s.pct + "%");
  if (proxy && proxy.conclusion !== "pass") warn.push("代理体检：" + (proxy.conclusion === "warn" ? "部分异常" : "异常"));
  if (!proxy || now - Number(proxy.t || 0) > 3 * 3600000) warn.push("代理体检超过 3 小时没有新结果");
  if (backup && backup.conclusion !== "pass") warn.push("每日备份失败");
  if (!backup || now - Date.parse(backup.run_at) > 26 * 3600000) warn.push("超过 26 小时没有新备份");
  if (cist && cist.conclusion === "fail") warn.push("GitHub 巡检有 " + cist.failed + " 项失败");
  if (issues.length) warn.push("GitHub 有 " + issues.length + " 个未关闭的告警 Issue");
  if (guard.n) warn.push("令牌异常告警 " + guard.n + " 条" + (guard.del ? "（自动删除 " + guard.del + " 条 DNS）" : ""));
  const lf = one(fails) || { n: 0, ips: 0 }, lo = one(logins) || { n: 0, ips: 0 }, e2 = one(ev) || { n: 0, probes: 0 };
  if (!otp.ok) warn.push("验证码邮箱读取失败（" + (otp.err || "未知") + "），最新验证码卡片会不显示");
  if (lf.n >= 10) warn.push("登录失败 " + lf.n + " 次");
  if (leak && leak.status === "leak") warn.push("订阅泄露检测：" + leak.reasons.length + " 项异常（详见下方）");
  if (!leak || now - Number(leak.t || 0) > 3 * 3600000) warn.push("订阅泄露检测超过 3 小时没有新结果");
  let domain = null, ipopt = null, guests = null;
  try { domain = await domainView(env); } catch (e) {}
  try { ipopt = await ipOptView(env); } catch (e) {}
  try { guests = await db.prepare("SELECT (SELECT COUNT(*) FROM guest_invites WHERE revoked_at IS NULL AND expires_at > ?1) AS active, (SELECT COUNT(*) FROM guest_views WHERE t >= ?2) AS views, (SELECT COUNT(DISTINCT ip) FROM guest_views WHERE t >= ?2) AS ips").bind(now, since).first(); } catch (e) {}
  if (!domain || now - Number(domain.t || 0) > 26 * 3600000) warn.push("域名与证书检查超过 26 小时没有新结果");
  else if (domain.status === "bad") warn.push("域名 / 证书：" + domain.problems.slice(0, 2).join("；"));
  if (ipopt && now - Number(ipopt.t || 0) > 50 * 3600000) warn.push("节点优选 IP 超过 2 天没有新结果");
  const firstT = (one(first) || {}).t;
  return { domain: domain ? { status: domain.status, problems: domain.problems, notes: domain.notes, t: domain.t, certs: ((domain.data || {}).certs || []).map(c => ({ host: c.host, days: c.days, ok: c.ok })), rdap: (domain.data || {}).rdap || null } : null,
    ipopt: ipopt ? { t: ipopt.t, chosen_n: ipopt.chosen_n, ok_n: ipopt.ok_n, cand_n: ipopt.cand_n, err: ipopt.err, chosen: ipopt.chosen.slice(0, 5) } : null,
    guests: guests ? { active: Number(guests.active) || 0, views: Number(guests.views) || 0, ips: Number(guests.ips) || 0 } : null, t: now, date: new Date(now + 8 * 3600000).toISOString().slice(0, 10), warn, svcs, coverFrom: firstT || null,
    login: { ok: lo.n, okIps: lo.ips, fail: lf.n, failIps: lf.ips }, events: e2, gql,
    proxy: proxy ? { conclusion: proxy.conclusion, at: proxy.run_at, sub_ok: !!proxy.sub_ok, nodes: proxy.node_count, sampOk: samp.filter(x => x.ok).length, sampN: samp.length, active: proxy.active_id } : null,
    backup: backup ? { conclusion: backup.conclusion, at: backup.run_at, workers: backup.workers, d1_rows: backup.d1_rows, changed: !!backup.changed, commit_url: backup.commit_url } : null,
    otp, leak, cfgv: cfgv ? { n: Number(cfgv.n) || 0, day: Number(cfgv.d) || 0 } : null, ci: cist ? { conclusion: cist.conclusion, at: cist.run_at, passed: cist.passed, failed: cist.failed } : null, guard, issues, quiet };
}
function dailyText(r) {
  const L = [];
  const md = r.date.slice(5).replace("-", "月") + "日";
  L.push("panel.example.com 每日报告 · " + md + "（统计最近 24 小时）", "");
  L.push(r.warn.length ? "需要注意（" + r.warn.length + "）：" : "结论：一切正常 ✔");
  for (const w of r.warn) L.push("  ! " + w);
  L.push("", "【项目在线率】" + (r.coverFrom && r.t - r.coverFrom < 23 * 3600000 ? "（从 " + fmtCN(r.coverFrom) + " 开始统计）" : ""));
  for (const s of r.svcs) L.push("  " + (s.pct == null ? "–" : s.pct >= 99 ? "✔" : "✖") + " " + s.name + "：" + (s.pct == null ? "暂无数据" : s.pct + "%（" + s.n + " 次巡检" + (s.ms != null ? "，平均 " + s.ms + " ms" : "") + "）") + (s.now === false ? " · 当前离线" : ""));
  L.push("", "【工作台登录】成功 " + r.login.ok + " 次（" + r.login.okIps + " 个 IP）· 密码错误 " + r.login.fail + " 次（" + r.login.failIps + " 个 IP）");
  L.push("【本站可疑事件】" + r.events.n + " 条，其中探测 " + r.events.probes + " 条（不含你自己的代理流量）");
  const qz = r.quiet || {};
  L.push("【订阅链接被复制】" + (qz.subCopies || 0) + " 次（只记录，不再单独发邮件）");
  if (qz.newLogins) L.push("【新 IP / 新设备登录】" + qz.newLogins + " 个（每个都已单独发过邮件）");
  const fmtSw = x => fmtCN(x.t) + " " + x.from + " → " + x.to + (x.ok ? "" : "（失败）");
  if (qz.manual && qz.manual.length) L.push("【出站代理手动切换】" + qz.manual.length + " 次：" + qz.manual.slice(-3).map(fmtSw).join("；"));
  if (qz.auto && qz.auto.length) L.push("【出站代理自动切换】" + qz.auto.map(x => ({ failover: "故障切换", failback: "切回主出口", no_standby: "无备用出口" }[x.kind] || x.kind) + " " + fmtSw(x)).join("；"));
  if (qz.suppressed && qz.suppressed.length) L.push("【被合并的重复告警】" + qz.suppressed.map(x => ({ login_fail: "登录失败", "proxy:fail": "代理异常", "proxy:warn": "代理部分异常", "proxy:pass": "代理恢复", "proxy:failover": "代理切换", "backup:fail": "备份失败" }[x.k] || x.k.replace("svc_down:", "离线:")) + " ×" + x.n).join("，") + "（每类 1 小时最多 1 封）");
  const g = r.gql || {};
  if (g.err) L.push("【Cloudflare 防护 / 代理流量】读取失败：" + g.err);
  else {
    L.push("【Cloudflare 防护】总请求 " + g.requests + " · 拦截 " + g.blocked + " · 人机验证 " + g.challenged);
    L.push("【代理】订阅拉取 " + (g.subPulls == null ? "—" : g.subPulls) + " 次 · 代理连接 " + g.wsConns + " 次 · 流量 " + dBytes(g.wsBytes));
  }
  const p = r.proxy;
  L.push("【代理体检】" + (p ? ({ pass: "正常", warn: "部分异常", fail: "异常" }[p.conclusion] || p.conclusion) + " · 订阅" + (p.sub_ok ? "正常" : "未测到/异常") + "（" + p.nodes + " 个节点）· 节点抽检 " + p.sampOk + "/" + p.sampN + " · 上次 " + fmtCN(Date.parse(p.at)) : "暂无结果"));
  const bk = r.backup;
  L.push("【每日备份】" + (bk ? (bk.conclusion === "pass" ? "成功" : "失败") + " · " + fmtCN(Date.parse(bk.at)) + " · " + bk.workers + " 个 Worker、" + bk.d1_rows + " 行 D1" + (bk.changed ? "（有变化，已提交）" : "（无变化）") : "暂无结果"));
  L.push("【GitHub 巡检】" + (r.ci ? (r.ci.conclusion === "pass" ? "通过" : "异常") + " · " + r.ci.passed + " 项通过 / " + r.ci.failed + " 项失败 · 上次 " + fmtCN(Date.parse(r.ci.at)) : "暂无结果"));
  L.push("【验证码邮箱】" + (r.otp && r.otp.ok ? "读取正常（工作台顶部「最新验证码」可用）" : "读取失败：" + ((r.otp && r.otp.err) || "未知")));
  const lk = r.leak;
  L.push("【订阅泄露检测】" + (!lk ? "暂无结果" : lk.status === "leak" ? "⚠ 可能泄露（" + lk.reasons.join("；") + "）" : lk.status === "err" ? "检测失败：" + (lk.err || "未知") : "正常") + (lk && lk.status !== "err" ? " · 24 小时陌生网络 " + lk.other24 + " 个（机房 " + lk.dc24 + "）、你自己的 " + lk.self24 + " 个" : ""));
  if (r.cfgv) L.push("【CFNext 配置版本】24 小时内新增 " + r.cfgv.day + " 个版本，共保存 " + r.cfgv.n + " 个（可在 /admin/config-history 回滚）");
  const dm = r.domain;
  if (dm) {
    const cs = (dm.certs || []).filter(c => c.ok && c.days != null).map(c => c.days);
    L.push("【域名与证书】" + (dm.status === "bad" ? "⚠ " + dm.problems.join("；") : dm.status === "warn" ? "基本正常（" + dm.notes.slice(0, 2).join("；") + "）" : "正常") + (cs.length ? " · 证书还剩 " + Math.min(...cs) + " 天" : "") + (dm.rdap && dm.rdap.ok && dm.rdap.expires ? " · " + PARENT_DOMAIN + " " + String(dm.rdap.expires).slice(0, 10) + " 到期" : "") + " · 上次检查 " + fmtCN(dm.t));
  } else L.push("【域名与证书】暂无结果");
  const io = r.ipopt;
  L.push("【节点优选 IP】" + (io ? fmtCN(io.t) + " 测了 " + io.cand_n + " 个候选，" + io.ok_n + " 个通过本站握手验证，选出 " + io.chosen_n + " 个" + (io.chosen.length ? "（" + io.chosen.map(x => x.ip + " " + x.line + " " + x.ms + "ms").join("、") + "）" : "") + (io.err ? " · " + io.err : "") + "；只展示，没写入订阅" : "暂无结果"));
  if (r.guests) L.push("【访客】有效邀请 " + r.guests.active + " 个 · 24 小时访问 " + r.guests.views + " 次（" + r.guests.ips + " 个 IP）");
  L.push("【令牌异常处置】" + (r.guard.n ? r.guard.n + " 条告警，自动删除 " + r.guard.del + " 条 DNS 记录" : "无告警"));
  L.push("【未关闭的告警 Issue】" + (r.issues.length ? "" : "无"));
  for (const i of r.issues) L.push("  - " + i.title + (i.url ? " " + i.url : ""));
  L.push("", "详情：https://panel.example.com/status", "这封邮件每天 08:17（UTC+8）由 GitHub Actions 触发、面板 Worker 发送。");
  return L;
}
async function dailyApi(request, env) {
  if (!(await keyOk(request.headers.get("x-ci-key"), env.CI_REPORT_KEY))) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  let b = {}; try { b = JSON.parse((await request.text()).slice(0, 16000) || "{}"); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
  try {
    const r = await buildDaily(env, b);
    const text = dailyText(r);
    const subject = (b.test ? "[测试] " : "") + "[每日报告] " + r.date.slice(5).replace("-", "月") + "日 · " + (r.warn.length ? r.warn.length + " 项需要注意" : "一切正常");
    let mailed = false, mailErr = "";
    if (!b.dry) {
      try { await outboxMime(env, "daily", gMime(subject, text, r.t)); mailed = true; } catch (e) { mailErr = String(e && e.message || e).slice(0, 160); }
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_report (id INTEGER PRIMARY KEY CHECK(id=1), t INTEGER, date TEXT, subject TEXT, summary TEXT, mailed INTEGER, run_url TEXT)").run();
      await env.DB.prepare("INSERT INTO daily_report (id, t, date, subject, summary, mailed, run_url) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO UPDATE SET t=excluded.t, date=excluded.date, subject=excluded.subject, summary=excluded.summary, mailed=excluded.mailed, run_url=excluded.run_url")
        .bind(r.t, r.date, subject, JSON.stringify(r), mailed ? 1 : 0, ghUrl(b.run_url)).run();
    }
    return json({ ok: true, mailed, mailErr, subject, warn: r.warn, text: b.dry ? text : undefined });
  } catch (e) { console.error("daily-report error: " + String(e && e.stack || e)); return json({ ok: false, error: "internal error" }, 500); }
}
async function dailyView(env) {
  if (!env.DB) return null;
  try { const r = await env.DB.prepare("SELECT t, date, subject, summary, mailed, run_url FROM daily_report WHERE id = 1").first(); if (!r) return null; try { r.summary = JSON.parse(r.summary); } catch (e) { r.summary = null; } return r; }
  catch (e) { return null; }
}

// ======================= CFNext 配置版本 (shared by admin + status) =======================
// KV `config` snapshots in D1 cfnext_config_versions, AES-GCM encrypted with Worker secret CONFIG_KEY (the config holds the
// CFNext admin password, UUID, SOCKS credentials, API token). Dedup by HMAC(CONFIG_KEY, raw). Last 50 versions kept.
// `fields` = top-level key NAMES that changed vs the previous version (never values).
const CV_KEEP = 50;
const CV_TE = new TextEncoder();
function cvB64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function cvUnB64(s) { const bin = atob(String(s)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function cvKey(env, usage) {
  if (!env.CONFIG_KEY) throw new Error("CONFIG_KEY 未配置");
  return crypto.subtle.importKey("raw", cvUnB64(env.CONFIG_KEY), { name: "AES-GCM" }, false, [usage]);
}
async function cvHash(env, raw) {
  const k = await crypto.subtle.importKey("raw", CV_TE.encode("cfgver-hmac:" + env.CONFIG_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, CV_TE.encode(raw)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function cvEnc(env, raw) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: CV_TE.encode("cfnext-config:v1") }, await cvKey(env, "encrypt"), CV_TE.encode(raw)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return "v1:" + cvB64(out);
}
async function cvDec(env, s) {
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(s || "")); if (!m) throw new Error("密文格式不对");
  const buf = cvUnB64(m[1]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: CV_TE.encode("cfnext-config:v1") }, await cvKey(env, "decrypt"), buf.slice(12)));
}
function cvChanged(a, b) {
  a = a && typeof a === "object" ? a : {}; b = b && typeof b === "object" ? b : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
// Snapshot `raw` (the exact KV string) if it differs from the newest stored version. Returns { id } | { skipped } | { error }.
async function cvSnapshot(env, raw, source) {
  try {
    if (!env.DB || !env.CONFIG_KEY || typeof raw !== "string" || !raw) return { skipped: "unavailable" };
    let obj; try { obj = JSON.parse(raw); } catch (e) { return { skipped: "not json" }; }
    const h = await cvHash(env, raw);
    const last = await env.DB.prepare("SELECT id, hash, enc FROM cfnext_config_versions ORDER BY id DESC LIMIT 1").first();
    if (last && last.hash === h) return { skipped: "unchanged", id: last.id };
    let fields = null;
    if (last) { try { fields = cvChanged(JSON.parse(await cvDec(env, last.enc)), obj); } catch (e) { fields = null; } }
    const r = await env.DB.prepare("INSERT INTO cfnext_config_versions (t, hash, source, fields, enc) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id")
      .bind(Date.now(), h, String(source || "").slice(0, 80), fields ? JSON.stringify(fields) : null, await cvEnc(env, raw)).first();
    await env.DB.prepare("DELETE FROM cfnext_config_versions WHERE id NOT IN (SELECT id FROM cfnext_config_versions ORDER BY id DESC LIMIT ?1)").bind(CV_KEEP).run();
    return { id: r && r.id, fields };
  } catch (e) { console.log("config snapshot failed: " + String(e && e.message || e)); return { error: String(e && e.message || e) }; }
}

// ======================= 订阅泄露检测 =======================
// Hourly (from the 5-minute cron, when >= 55 min since the last scan) + on demand (POST /api/leak-scan, CI key).
// Reads Cloudflare GraphQL httpRequestsAdaptiveGroups for the proxy UUID path (/<uuid> and /<uuid>/*), path taken from the
// cfnext KV config at run time (never stored in a rule / log). Free plan: no ASN -> datacenter = CIDR / prefix guess.
// "Self" = guard allowlist (Grok Bot box, your home / VPN / Hako exits, proxy exit), IPs that logged into the workbench (30 d),
// GitHub Actions ranges, current outbound-pool exit IPs. Distinct = IPv4 address / IPv6 /64.
// Leak if: > LK_IPS distinct non-self networks in 24 h, or >= LK_DC non-self datacenter networks in 24 h, or
// last-hour bytes > LK_SPIKE x the 7-day hourly median AND >= LK_SPIKE_MIN. One email per incident, re-sent at most every 6 h.
const LK_IPS = 8, LK_DC = 3, LK_SPIKE = 5, LK_SPIKE_MIN = 50 * 1024 * 1024, LK_EVERY = 55 * 60000, LK_MAIL_GAP = 6 * 3600000;
const LK_DC_LIST = [["13.64.0.0/11", "Azure"], ["13.96.0.0/13", "Azure"], ["13.104.0.0/14", "Azure"], ["20.36.0.0/14", "Azure"], ["20.40.0.0/13", "Azure"], ["20.48.0.0/12", "Azure"], ["20.64.0.0/10", "Azure"], ["20.128.0.0/9", "Azure"],
  ["40.64.0.0/10", "Azure"], ["52.96.0.0/12", "Azure"], ["52.136.0.0/13", "Azure"], ["52.146.0.0/15", "Azure"], ["52.148.0.0/14", "Azure"], ["52.152.0.0/13", "Azure"], ["52.160.0.0/11", "Azure"], ["52.224.0.0/11", "Azure"], ["104.40.0.0/13", "Azure"], ["104.208.0.0/13", "Azure"],
  ["3.0.0.0/8", "AWS"], ["13.32.0.0/12", "AWS"], ["13.48.0.0/13", "AWS"], ["18.128.0.0/9", "AWS"], ["34.192.0.0/10", "AWS"], ["35.152.0.0/13", "AWS"], ["35.160.0.0/12", "AWS"], ["44.192.0.0/10", "AWS"], ["52.0.0.0/11", "AWS"], ["52.32.0.0/11", "AWS"], ["52.64.0.0/12", "AWS"], ["52.192.0.0/11", "AWS"], ["54.64.0.0/10", "AWS"], ["54.144.0.0/12", "AWS"], ["54.160.0.0/11", "AWS"], ["54.192.0.0/10", "AWS"],
  ["34.0.0.0/9", "Google Cloud"], ["34.128.0.0/10", "Google Cloud"], ["35.184.0.0/13", "Google Cloud"], ["35.192.0.0/12", "Google Cloud"], ["35.208.0.0/12", "Google Cloud"], ["35.224.0.0/12", "Google Cloud"],
  ["51.38.0.0/16", "OVH"], ["51.68.0.0/16", "OVH"], ["51.75.0.0/16", "OVH"], ["51.77.0.0/16", "OVH"], ["51.89.0.0/16", "OVH"], ["51.91.0.0/16", "OVH"], ["51.178.0.0/16", "OVH"], ["51.195.0.0/16", "OVH"], ["137.74.0.0/16", "OVH"], ["141.94.0.0/15", "OVH"], ["145.239.0.0/16", "OVH"], ["147.135.0.0/16", "OVH"], ["149.202.0.0/16", "OVH"], ["158.69.0.0/16", "OVH"], ["176.31.0.0/16", "OVH"], ["178.32.0.0/15", "OVH"], ["188.165.0.0/16", "OVH"], ["192.99.0.0/16", "OVH"],
  ["8.128.0.0/10", "阿里云"], ["8.208.0.0/12", "阿里云"], ["39.96.0.0/13", "阿里云"], ["47.74.0.0/15", "阿里云"], ["47.76.0.0/14", "阿里云"], ["47.80.0.0/12", "阿里云"], ["47.96.0.0/11", "阿里云"]];
const LK_DC_M = LK_DC_LIST.map(([c, n]) => [cidrParse([c]), n]);
const LK_DC_RE = [
  [/^(104\.131|104\.236|138\.68|138\.197|139\.59|142\.93|143\.110|143\.198|146\.190|157\.230|159\.65|159\.89|159\.203|161\.35|164\.90|164\.92|165\.22|165\.227|167\.71|167\.99|167\.172|170\.64|174\.138|178\.62|188\.166|206\.189|209\.97)\./, "DigitalOcean"],
  [/^(45\.32|45\.63|45\.76|45\.77|64\.176|66\.42|78\.141|95\.179|108\.61|136\.244|141\.164|144\.202|149\.28|149\.248|155\.138|207\.148|208\.167|216\.128)\./, "Vultr"],
  [/^(45\.33|45\.56|45\.79|50\.116|66\.175|96\.126|139\.144|139\.162|172\.104|172\.105|173\.255|192\.46|198\.58)\./, "Linode/Akamai"],
  [/^(5\.75|5\.161|23\.88|49\.12|49\.13|65\.108|65\.109|65\.21|78\.46|78\.47|88\.198|88\.99|91\.107|94\.130|95\.216|95\.217|116\.202|116\.203|128\.140|135\.181|136\.243|138\.201|142\.132|144\.76|148\.251|157\.90|159\.69|162\.55|167\.233|167\.235|168\.119|176\.9|178\.63|188\.34|188\.40|195\.201|213\.133|213\.239)\./, "Hetzner"],
  [/^(106\.75|152\.32|165\.154|101\.36|117\.50|128\.1)\./, "UCloud"],
  [/^(43\.1[2-6]\d|49\.51|62\.234|81\.68|82\.156|101\.32|101\.33|101\.34|106\.52|106\.53|106\.54|110\.40|111\.229|111\.230|118\.24|118\.25|119\.28|119\.29|119\.45|123\.206|124\.156|124\.220|124\.221|124\.222|129\.204|129\.211|129\.226|134\.175|150\.109|150\.158|162\.62|170\.106|175\.178|175\.24|182\.254|193\.112|203\.195|212\.64)\./, "腾讯云"],
  [/^(129\.146|129\.150|129\.151|129\.153|129\.154|129\.159|130\.61|130\.162|132\.145|132\.226|134\.65|134\.70|138\.2|138\.3|140\.238|141\.144|141\.145|141\.147|141\.148|143\.47|144\.21|144\.22|144\.24|146\.56|150\.136|150\.230|152\.67|152\.69|152\.70|155\.248|158\.101|158\.178|158\.179|158\.180|168\.75|168\.138|192\.9|193\.122|193\.123)\./, "Oracle Cloud"]];
const LK_DC_GENERIC = cidrParse(["4.0.0.0/8", "13.0.0.0/8", "15.0.0.0/8", "20.0.0.0/8", "34.0.0.0/8", "35.0.0.0/8", "40.0.0.0/8", "44.0.0.0/8", "51.0.0.0/8", "52.0.0.0/8", "54.0.0.0/8", "99.0.0.0/8", "130.211.0.0/16"]);
const LK_CF_EDGE = cidrParse(["2a06:98c0::/29", "172.64.0.0/13", "162.158.0.0/15", "104.16.0.0/13"]);
function lkDc(ip) {
  ip = String(ip || "");
  if (cidrHas(LK_CF_EDGE, ip)) return "Cloudflare";
  if (ip.includes(":")) return "";
  for (const [m, n] of LK_DC_M) if (cidrHas(m, ip)) return n;
  for (const [re, n] of LK_DC_RE) if (re.test(ip)) return n;
  return cidrHas(LK_DC_GENERIC, ip) ? "云服务器" : "";
}
function lkNet(ip) {
  ip = String(ip || "").toLowerCase();
  if (!ip.includes(":")) return ip;
  const n = ip6n(ip); if (n === null) return ip;
  const top = n >> 64n; const g = []; for (let i = 3; i >= 0; i--) g.push(((top >> BigInt(i * 16)) & 0xffffn).toString(16));
  return g.join(":") + "::/64";
}
function lkMedian(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const LK_GQL = `query($z:String!,$s24:Time!,$s1:Time!,$s7:Time!,$e:Time!,$p:String!,$pl:String!){viewer{zones(filter:{zoneTag:$z}){
 d24:httpRequestsAdaptiveGroups(limit:1000,filter:{datetime_geq:$s24,datetime_leq:$e,OR:[{clientRequestPath:$p},{clientRequestPath_like:$pl}]},orderBy:[count_DESC]){count sum{edgeResponseBytes} dimensions{clientIP clientCountryName}}
 d1:httpRequestsAdaptiveGroups(limit:500,filter:{datetime_geq:$s1,datetime_leq:$e,OR:[{clientRequestPath:$p},{clientRequestPath_like:$pl}]},orderBy:[count_DESC]){count sum{edgeResponseBytes} dimensions{clientIP clientCountryName}}
 h7:httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$s7,datetime_leq:$e,OR:[{clientRequestPath:$p},{clientRequestPath_like:$pl}]},orderBy:[datetimeHour_ASC]){count sum{edgeResponseBytes} dimensions{datetimeHour}}
}}}`;
async function leakScan(env, opts) {
  opts = opts || {};
  const db = env.DB, now = Date.now();
  if (!db) return { ok: false, error: "no DB" };
  const st = await db.prepare("SELECT t, status, incident_at, mailed_at FROM leak_state WHERE id = 1").first().catch(() => null);
  if (opts.cron && st && now - Number(st.t || 0) < LK_EVERY) return { ok: true, skipped: "not due" };
  const save = (status, reasons, data, err, incident, mailed) => db.prepare("INSERT INTO leak_state (id, t, status, reasons, data, incident_at, mailed_at, err) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET t = excluded.t, status = excluded.status, reasons = excluded.reasons, data = excluded.data, incident_at = excluded.incident_at, mailed_at = excluded.mailed_at, err = excluded.err")
    .bind(now, status, JSON.stringify(reasons || []), JSON.stringify(data || {}), incident || null, mailed || null, err || null).run();
  let cfg; try { cfg = await loadCfnextCfg(env); } catch (e) { if (!opts.dry) await save("err", [], {}, "读不到 cfnext 配置", st && st.incident_at, st && st.mailed_at); return { ok: false, error: "cfnext config unreadable" }; }
  const path = "/" + String(cfg.path || cfg.uuid);
  if (!env.CF_ZONE_ID || !env.CF_ANALYTICS_TOKEN) return { ok: false, error: "no analytics token" };
  const iso = t => new Date(t).toISOString().slice(0, 19) + "Z";
  let z;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Authorization": "Bearer " + env.CF_ANALYTICS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query: LK_GQL, variables: { z: env.CF_ZONE_ID, s24: iso(now - 86400000), s1: iso(now - 3600000), s7: iso(now - 7 * 86400000), e: iso(now), p: path, pl: path + "/%" } }) });
    const d = await r.json();
    if (d.errors && d.errors.length) throw new Error(String(d.errors[0].message || "GraphQL 错误").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "…").slice(0, 160));
    z = d.data.viewer.zones[0] || {};
  } catch (e) { const msg = String(e && e.message || e).slice(0, 160); if (!opts.dry) await save("err", [], {}, msg, st && st.incident_at, st && st.mailed_at); return { ok: false, error: msg }; }
  // self set
  const allow = await gAllow(db);
  const exits = new Set();
  try { for (const x of ((await db.prepare("SELECT last_ip, host FROM outbound_pool").all()).results || [])) { if (x.last_ip) exits.add(String(x.last_ip)); if (/^[0-9.]+$/.test(String(x.host))) exits.add(String(x.host)); } } catch (e) {}
  const cls = ip => {
    if (exits.has(ip)) return { self: true, label: "你的代理出口" };
    const c = gIpClass(ip, allow, "");
    if (c.k === "full" || c.k === "weak") return { self: true, label: c.label };
    const dc = lkDc(ip);
    return { self: false, dc, label: dc ? "陌生 · " + (dc === "云服务器" ? "云服务器" : "疑似 " + dc) : "陌生 IP" };
  };
  const agg = rows => {
    const nets = new Map(); let bytes = 0, req = 0; const cos = {};
    for (const g of rows || []) {
      const ip = g.dimensions.clientIP, b = (g.sum && g.sum.edgeResponseBytes) || 0; bytes += b; req += g.count;
      const c = cls(ip); const k = lkNet(ip);
      const cur = nets.get(k) || { net: k, ip, co: g.dimensions.clientCountryName, n: 0, b: 0, self: c.self, dc: c.dc || "", label: c.label };
      cur.n += g.count; cur.b += b; nets.set(k, cur);
      if (!c.self) cos[g.dimensions.clientCountryName || "?"] = (cos[g.dimensions.clientCountryName || "?"] || 0) + g.count;
    }
    const list = [...nets.values()];
    const other = list.filter(x => !x.self);
    return { req, bytes, nets: list.length, self: list.length - other.length, other: other.length, dc: other.filter(x => x.dc).length, cos, top: other.sort((a, b) => b.n - a.n).slice(0, 15) };
  };
  const a24 = agg(z.d24), a1 = agg(z.d1);
  // 7-day hourly bytes median (missing hours = 0), excluding the current hour
  const hours = new Map(); for (const g of z.h7 || []) hours.set(Date.parse(g.dimensions.datetimeHour), (g.sum && g.sum.edgeResponseBytes) || 0);
  const curH = Math.floor(now / 3600000) * 3600000; const series = [];
  for (let t = curH - 168 * 3600000; t < curH; t += 3600000) series.push(hours.get(t) || 0);
  const median = lkMedian(series);
  const reasons = [];
  if (a24.other > LK_IPS) reasons.push("24 小时内有 " + a24.other + " 个陌生网络（IPv6 按 /64 合并）在用你的订阅 / 节点路径（阈值 > " + LK_IPS + "）");
  if (a24.dc >= LK_DC) reasons.push("24 小时内有 " + a24.dc + " 个陌生机房 / 云服务器 IP（阈值 ≥ " + LK_DC + "）");
  if (a1.bytes >= LK_SPIKE_MIN && a1.bytes > LK_SPIKE * median) reasons.push("最近 1 小时流量 " + dBytes(a1.bytes) + "，是 7 天每小时中位数（" + dBytes(median) + "）的 " + (median ? Math.round(a1.bytes / median) + " 倍" : "很多倍") + "（阈值 > " + LK_SPIKE + " 倍且 ≥ " + dBytes(LK_SPIKE_MIN) + "）");
  const data = { h24: a24, h1: { req: a1.req, bytes: a1.bytes, other: a1.other, dc: a1.dc, top: a1.top.slice(0, 5) }, median, thresholds: { ips: LK_IPS, dc: LK_DC, spike: LK_SPIKE, spikeMin: LK_SPIKE_MIN }, uuid8: String(cfg.uuid || "").slice(0, 8) };
  const leak = reasons.length > 0;
  let incident = leak ? (st && st.status === "leak" && st.incident_at ? st.incident_at : now) : null;
  let mailed = leak ? (st && st.mailed_at && st.incident_at ? st.mailed_at : null) : null;
  let mailedNow = false, mailErr = "";
  if (leak && !opts.dry && (!mailed || now - mailed >= LK_MAIL_GAP)) {
    const lines = ["你的代理订阅 / 节点路径（UUID " + data.uuid8 + "…）可能泄露了：", "", ...reasons.map(r => "  ! " + r), "",
      "最近 24 小时：陌生网络 " + a24.other + " 个（其中机房 " + a24.dc + " 个）· 你自己的 " + a24.self + " 个 · 请求 " + a24.req + " 次 · 流量 " + dBytes(a24.bytes),
      "最近 1 小时：陌生网络 " + a1.other + " 个 · 流量 " + dBytes(a1.bytes), "", "陌生 IP（前 10）："];
    for (const x of a24.top.slice(0, 10)) lines.push("  " + x.ip + (x.net !== x.ip ? "（" + x.net + "）" : "") + " · " + (x.co || "?") + " · " + x.n + " 次 · " + dBytes(x.b) + " · " + x.label);
    lines.push("", "国家分布：" + Object.entries(a24.cos).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + " " + v).join("，"), "",
      "建议：先在 https://panel.example.com/admin/proxy 的「泄露检测」卡片确认这些 IP 不是你自己的设备 / VPN；如果确认不是，请让 Grok Bot 轮换 UUID（旧订阅链接会失效，客户端需要重新导入）。",
      "同一次泄露每 6 小时最多提醒 1 封；恢复正常后不另发邮件，记入每日报告。", "", "时间：" + fmtCN(now));
    try { await outboxMime(env, "leak", gMime("[面板告警] 订阅可能泄露：" + reasons.length + " 项异常", lines, now)); mailed = now; mailedNow = true; }
    catch (e) { mailErr = String(e && e.message || e).slice(0, 120); }
  }
  if (!opts.dry) await save(leak ? "leak" : "ok", reasons, data, mailErr || null, incident, mailed);
  return { ok: true, status: leak ? "leak" : "ok", reasons, mailed: mailedNow, mailErr, summary: { other24: a24.other, dc24: a24.dc, self24: a24.self, req24: a24.req, bytes24: a24.bytes, other1: a1.other, bytes1: a1.bytes, median } };
}
async function leakScanApi(request, env) {
  if (!(await keyOk(request.headers.get("x-ci-key"), env.CI_REPORT_KEY)) && !(await writeKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  let b = {}; try { b = JSON.parse((await request.text()).slice(0, 2000) || "{}"); } catch (e) { return json({ ok: false, error: "invalid json" }, 400); }
  try { return json(await leakScan(env, { dry: !!b.dry })); } catch (e) { console.error("leak-scan error: " + String(e && e.stack || e)); return json({ ok: false, error: "internal error" }, 500); }
}

// ======================= Batch B (2026-10): 节点优选 IP · 在线率历史 · 域名与证书 =======================
const B_TE = new TextEncoder();
const B_IP4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const bStr = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n || 80);
const bNum = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };
async function bReadJson(request, max) {
  const raw = await request.text();
  if (raw.length > max) return { err: json({ ok: false, error: "payload too large" }, 413) };
  try { const b = JSON.parse(raw); if (!b || typeof b !== "object" || Array.isArray(b)) throw 0; return { b }; } catch (e) { return { err: json({ ok: false, error: "invalid json" }, 400) }; }
}
async function reportKeyOk(request, env) { return (await keyOk(request.headers.get("x-ci-key"), env.CI_REPORT_KEY)) || (await writeKeyOk(request, env)); }

// ---- 节点优选 IP ----
// GitHub Actions `ip-opt` (daily 04:37 UTC+8, or queued by the workbench 「立即优选」 button via ip_opt_req; the hourly
// `monitor` job dispatches it). GET (write key) = sub URL + outbound pool, exactly like /api/proxy-health. POST (report key)
// = result. Nothing is written to the cfnext KV config: in the current CFNext delivery mode (optimizer.subMode '' +
// probeAlive) the 10 delivered nodes always come from the built-in 保底 IP list compiled into the cfnext Worker; KV
// config.preferredIPs is ignored (src.customPref off) and even when enabled is ordered behind the 保底 group and cut off by
// nodeLimitCount=10. Changing that would mean changing the delivery mode, which the user has not approved.
async function ipOptApi(request, env) {
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  try {
    if (request.method === "GET") {
      if (!(await writeKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
      const pool = (await env.DB.prepare("SELECT id, host, port, user, protocol, enabled, is_active, pass_enc FROM outbound_pool ORDER BY is_active DESC, created_at").all()).results || [];
      let sub_url = "";
      try { const c = await loadCfnextCfg(env); if (c.path || c.uuid) sub_url = "https://panel.example.com/" + String(c.path || c.uuid) + "/sub"; } catch (e) {}
      return json({ ok: true, pool, sub_url });
    }
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    if (!(await reportKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
    const { b, err } = await bReadJson(request, 98304); if (err) return err;
    const lines = o => { const r = {}; for (const k of ["移动", "联通", "电信"]) if (o && o[k] != null && bNum(o[k]) != null) r[k] = bNum(o[k]); return r; };
    const cand = (Array.isArray(b.candidates) ? b.candidates : []).filter(x => x && B_IP4.test(String(x.ip))).slice(0, 80).map(x => ({
      ip: String(x.ip), lines: lines(x.lines), best_cn: bNum(x.best_cn), colo: bStr(x.colo, 4).replace(/[^A-Z]/g, ""), srcs: (Array.isArray(x.srcs) ? x.srcs : []).slice(0, 3).map(s => bStr(s, 12)),
      loss: bNum(x.loss) || 0, tls_ok: !!x.tls_ok, ws_ok: !!x.ws_ok, code: Number(x.code) || 0, via: bStr(x.via, 10), tcp_ms: bNum(x.tcp_ms), tls_ms: bNum(x.tls_ms) }));
    const chosen = (Array.isArray(b.chosen) ? b.chosen : []).filter(x => x && B_IP4.test(String(x.ip))).slice(0, 20).map(x => ({
      ip: String(x.ip), for_line: ["移动", "联通", "电信"].includes(x.for_line) ? x.for_line : "", cn_ms: bNum(x.cn_ms), colo: bStr(x.colo, 4).replace(/[^A-Z]/g, ""), tcp_ms: bNum(x.tcp_ms), tls_ms: bNum(x.tls_ms), via: bStr(x.via, 10), srcs: (Array.isArray(x.srcs) ? x.srcs : []).slice(0, 3).map(s => bStr(s, 12)) }));
    const baseline = (Array.isArray(b.baseline) ? b.baseline : []).filter(x => x && B_IP4.test(String(x.ip))).slice(0, 30).map(x => ({ ip: String(x.ip), ws_ok: !!x.ws_ok, tls_ok: !!x.tls_ok, code: Number(x.code) || 0, tcp_ms: bNum(x.tcp_ms), tls_ms: bNum(x.tls_ms), via: bStr(x.via, 10) }));
    const sources = (Array.isArray(b.sources) ? b.sources : []).slice(0, 6).map(x => ({ name: bStr(x && x.name, 20), ok: !!(x && x.ok), n: Number(x && x.n) || 0, err: bStr(x && x.err, 120) }));
    const now = Date.now();
    const data = { sources, candidates: cand, chosen, baseline, top_n: Number(b.top_n) || chosen.length, note: bStr(b.note, 200) };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ip_opt (id, t, run_at, run_url, trigger, data, chosen_n, ok_n, err) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET t=excluded.t, run_at=excluded.run_at, run_url=excluded.run_url, trigger=excluded.trigger, data=excluded.data, chosen_n=excluded.chosen_n, ok_n=excluded.ok_n, err=excluded.err")
        .bind(now, bStr(b.run_at, 40), ghUrl(b.run_url), bStr(b.trigger, 30), JSON.stringify(data), chosen.length, cand.filter(x => x.ws_ok).length, bStr(b.error, 200)),
      env.DB.prepare("UPDATE ip_opt_req SET requested_at = NULL, done_at = ?1 WHERE id = 1").bind(now)
    ]);
    return json({ ok: true, stored: true, chosen: chosen.length });
  } catch (e) { console.error("ip-opt error: " + String(e && e.stack || e)); return json({ ok: false, error: "internal error" }, 500); }
}
// GET (report key) -> { pending } : the hourly monitor job dispatches the ip-opt workflow when the user pressed 「立即优选」.
// POST {dispatched:true} marks it handed over so the next hourly run does not dispatch again.
async function ipOptPendingApi(request, env) {
  if (!(await reportKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  const r = await env.DB.prepare("SELECT requested_at, dispatched_at FROM ip_opt_req WHERE id = 1").first().catch(() => null);
  const pending = !!(r && r.requested_at && !(r.dispatched_at && r.dispatched_at >= r.requested_at));
  if (request.method === "POST") {
    if (pending) await env.DB.prepare("UPDATE ip_opt_req SET dispatched_at = ?1 WHERE id = 1").bind(Date.now()).run();
    return json({ ok: true, pending: false, marked: pending });
  }
  return json({ ok: true, pending, requested_at: r ? r.requested_at : null });
}
async function ipOptView(env) {
  try {
    const r = await env.DB.prepare("SELECT t, run_at, run_url, chosen_n, ok_n, err, data FROM ip_opt WHERE id = 1").first();
    if (!r) return null;
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch (e) {}
    return { t: r.t, run_url: r.run_url, chosen_n: r.chosen_n, ok_n: r.ok_n, cand_n: (d.candidates || []).length, err: r.err, chosen: (d.chosen || []).slice(0, 10).map(x => ({ ip: x.ip, line: x.for_line, ms: x.cn_ms })) };
  } catch (e) { return null; }
}

// ---- 域名与证书 ----
// GitHub Actions `domain-check` (daily 07:47 UTC+8) -> POST /api/domain-check (report key). Evaluated here; email per
// problem kind at most once per 24 h (alert_gate). Problems: cert < 14 days / missing / wrong host, zone not active / paused,
// public resolvers or the parent-domain servers returning NS other than the zone's Cloudflare NS (or nothing),
// parent-domain RDAP hold / redemption / pending-delete / inactive status or expiring within 30 days.
const DM_CERT_DAYS = 14, DM_PARENT_DAYS = 30, DM_GAP = 86400000;
function dmEval(rep, now) {
  const problems = [], notes = [];
  const zns = rep.zone && rep.zone.ok && Array.isArray(rep.zone.ns) ? [...rep.zone.ns].sort().join(",") : "";
  for (const c of rep.certs || []) {
    if (!c.ok) problems.push(["cert_err:" + c.host, c.host + " 拿不到 TLS 证书：" + (c.err || "未知")]);
    else {
      if (c.days != null && c.days < DM_CERT_DAYS) problems.push(["cert_exp:" + c.host, c.host + " 的证书还剩 " + c.days + " 天就过期（" + String(c.not_after).slice(0, 10) + "）"]);
      if (c.covers === false) problems.push(["cert_san:" + c.host, c.host + " 返回的证书不包含这个域名"]);
    }
  }
  const z = rep.zone || {};
  if (!z.ok) notes.push("Cloudflare 域名状态读取失败：" + (z.err || "未知"));
  else if (z.status !== "active" || z.paused) problems.push(["zone", "Cloudflare 域名状态是「" + z.status + (z.paused ? "，已暂停" : "") + "」，不是 active"]);
  for (const r of rep.resolvers || []) {
    if (!r.ok) { notes.push(r.resolver + " 查询失败"); continue; }
    const got = [...(r.ns || [])].sort().join(",");
    if (!got) problems.push(["ns_pub", r.resolver + " 查不到 panel.example.com 的 NS 记录（rcode " + r.rcode + "），域名可能被上级收回"]);
    else if (zns && got !== zns) problems.push(["ns_pub", r.resolver + " 返回的 NS 是 " + got + "，不是 Cloudflare 分配的 " + zns]);
  }
  const p = rep.parent || {};
  const answered = (p.answers || []).filter(a => a.ok || a.status === "NXDOMAIN");
  for (const a of answered) {
    const got = [...(a.ns || [])].sort().join(",");
    if (a.status === "NXDOMAIN" || !got) problems.push(["ns_parent", "上级 " + PARENT_DOMAIN + " 的服务器 " + a.server + " 已经不再委派 " + G_HOST + "（" + (a.status || "无 NS") + "）"]);
    else if (zns && got !== zns) problems.push(["ns_parent", "上级 " + PARENT_DOMAIN + " 的服务器 " + a.server + " 把域名委派给了 " + got + "，不是 " + zns]);
  }
  if (!answered.length) notes.push(PARENT_DOMAIN + " 上级权威服务器这次没有响应（只记录，不告警）");
  const rd = rep.rdap || {};
  if (!rd.ok) notes.push(PARENT_DOMAIN + " 的 RDAP 注册信息查询失败：" + (rd.err || "未知"));
  else {
    const bad = (rd.status || []).filter(s => /hold|redemption|pending ?delete|inactive/i.test(s));
    if (bad.length) problems.push(["parent_status", "上级域名 " + PARENT_DOMAIN + " 处于异常状态：" + bad.join("、")]);
    const exp = Date.parse(rd.expires || "");
    if (Number.isFinite(exp) && exp - now < DM_PARENT_DAYS * 86400000) problems.push(["parent_exp", "上级域名 " + PARENT_DOMAIN + " 将在 " + String(rd.expires).slice(0, 10) + " 到期"]);
  }
  // de-duplicate kinds (one line per kind is enough for the email; all lines are shown on the page)
  return { status: problems.length ? "bad" : notes.length ? "warn" : "ok", problems, notes };
}
function dmClean(b) {
  const host = v => /^[a-z0-9.-]{1,80}$/i.test(String(v || "")) ? String(v).toLowerCase() : "";
  const nsl = a => (Array.isArray(a) ? a : []).slice(0, 8).map(host).filter(Boolean);
  return {
    run_at: bStr(b.run_at, 40), run_url: ghUrl(b.run_url),
    certs: (Array.isArray(b.certs) ? b.certs : []).slice(0, 4).map(c => ({ host: host(c && c.host), ok: !!(c && c.ok), not_after: bStr(c && c.not_after, 30), days: c && c.days != null ? Number(c.days) : null, issuer: bStr(c && c.issuer, 60), covers: c && c.covers === false ? false : true, err: bStr(c && c.err, 120) })),
    zone: b.zone && b.zone.ok ? { ok: true, status: bStr(b.zone.status, 20), paused: !!b.zone.paused, ns: nsl(b.zone.ns) } : { ok: false, err: bStr(b.zone && b.zone.err, 120) },
    packs: b.packs && b.packs.ok ? { ok: true, list: (Array.isArray(b.packs.list) ? b.packs.list : []).slice(0, 6).map(p => ({ type: bStr(p.type, 20), status: bStr(p.status, 30), expires: bStr(p.expires, 30) })) } : { ok: false, err: bStr(b.packs && b.packs.err, 120) },
    resolvers: (Array.isArray(b.resolvers) ? b.resolvers : []).slice(0, 5).map(r => ({ resolver: bStr(r && r.resolver, 30), ok: !!(r && r.ok), rcode: Number(r && r.rcode) || 0, ns: nsl(r && r.ns), err: bStr(r && r.err, 80) })),
    parent: { parent_ns: nsl(b.parent && b.parent.parent_ns), err: bStr(b.parent && b.parent.err, 80), answers: (Array.isArray(b.parent && b.parent.answers) ? b.parent.answers : []).slice(0, 4).map(a => ({ server: host(a && a.server), ok: !!(a && a.ok), status: bStr(a && a.status, 20), ns: nsl(a && a.ns) })) },
    rdap: b.rdap && b.rdap.ok ? { ok: true, status: (Array.isArray(b.rdap.status) ? b.rdap.status : []).slice(0, 10).map(s => bStr(s, 40)), expires: bStr(b.rdap.expires, 30), last_changed: bStr(b.rdap.last_changed, 30), ns: nsl(b.rdap.ns) } : { ok: false, err: bStr(b.rdap && b.rdap.err, 120) }
  };
}
async function domainCheckApi(request, env) {
  if (!(await reportKeyOk(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (!env.DB) return json({ ok: false, error: "storage unavailable" }, 503);
  try {
    const { b, err } = await bReadJson(request, 32768); if (err) return err;
    const now = Date.now(), rep = dmClean(b), ev = dmEval(rep, now);
    let mailed = false;
    const fresh = [];
    for (const [k, msg] of ev.problems) if (!fresh.some(x => x[0] === k) && await gateOk(env, "domain:" + k, now, DM_GAP)) fresh.push([k, msg]);
    if (fresh.length && !b.dry) {
      const lines = ["panel.example.com 的域名 / 证书检查发现问题：", "", ...ev.problems.map(x => "  ! " + x[1]), "",
        "可能的原因：免费域名被上级回收或需要续期、Cloudflare 把域名移出账号、证书没能自动续签。", "代理和工作台都依赖这个域名，请尽快登录注册商后台和 Cloudflare 检查。", "",
        "详情：https://panel.example.com/status （「域名与证书」卡片）", rep.run_url ? "运行记录：" + rep.run_url : "", "同一类问题 24 小时内最多提醒 1 次。"].filter(x => x !== "");
      try { await outboxMime(env, "domain", gMime("[告警] 域名 / 证书异常：" + fresh[0][1].slice(0, 40), lines, now)); mailed = true; } catch (e) { console.log("domain mail failed: " + String(e && e.message || e)); }
    }
    await env.DB.prepare("INSERT INTO domain_check (id, t, run_at, run_url, status, problems, notes, data, mailed_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET t=excluded.t, run_at=excluded.run_at, run_url=excluded.run_url, status=excluded.status, problems=excluded.problems, notes=excluded.notes, data=excluded.data, mailed_at=COALESCE(excluded.mailed_at, domain_check.mailed_at)")
      .bind(now, rep.run_at, rep.run_url, ev.status, JSON.stringify(ev.problems.map(x => x[1])), JSON.stringify(ev.notes), JSON.stringify(rep), mailed ? now : null).run();
    return json({ ok: true, status: ev.status, problems: ev.problems.map(x => x[1]), notes: ev.notes, mailed });
  } catch (e) { console.error("domain-check error: " + String(e && e.stack || e)); return json({ ok: false, error: "internal error" }, 500); }
}
async function domainView(env) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare("SELECT t, run_url, status, problems, notes, data, mailed_at FROM domain_check WHERE id = 1").first();
    if (!r) return null;
    const p = s => { try { return JSON.parse(s || "null"); } catch (e) { return null; } };
    return { t: r.t, run_url: r.run_url, status: r.status, problems: p(r.problems) || [], notes: p(r.notes) || [], data: p(r.data) || {}, mailed_at: r.mailed_at };
  } catch (e) { return null; }
}

// ---- 在线率历史 (D1 health_log, one row per service per 5-minute cron run; kept 30 days) ----
async function uptimeData(env) {
  if (!env.DB) return { ok: false, error: "storage unavailable" };
  const now = Date.now(), H = 3600000, D = 86400000, OFF = 8 * H;
  const s7 = Math.floor((now - 7 * D) / H) * H + H, s30 = Math.floor((now + OFF) / D) * D - OFF - 29 * D;
  const [h, d, f] = await env.DB.batch([
    env.DB.prepare("SELECT svc, t / 3600000 AS h, COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok, CAST(AVG(CASE WHEN ok = 1 AND ms > 0 THEN ms END) AS INTEGER) AS ms FROM health_log WHERE t >= ?1 GROUP BY svc, h").bind(s7),
    env.DB.prepare("SELECT svc, (t + 28800000) / 86400000 AS d, COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok, CAST(AVG(CASE WHEN ok = 1 AND ms > 0 THEN ms END) AS INTEGER) AS ms FROM health_log WHERE t >= ?1 GROUP BY svc, d").bind(s30),
    env.DB.prepare("SELECT MIN(t) AS t FROM health_log")
  ]);
  const hours = {}, days = {};
  for (const r of h.results || []) (hours[r.svc] = hours[r.svc] || []).push([Number(r.h), r.n, r.ok, r.ms == null ? null : r.ms]);
  for (const r of d.results || []) (days[r.svc] = days[r.svc] || []).push([Number(r.d), r.n, r.ok, r.ms == null ? null : r.ms]);
  return { ok: true, now, from7: s7, from30: s30, first: ((f.results || [])[0] || {}).t || null, svcs: D_SVC.map(([k, name]) => ({ k, name })), hours, days, keep_days: 30 };
}
// Daily housekeeping from the 5-minute cron (04:00-04:05 UTC+8): health_log 30 days, guest views 90 days, rate-limit rows.
async function bPrune(env, now) {
  if (!env.DB) return;
  const d = new Date(now); if (d.getUTCHours() !== 20 || d.getUTCMinutes() >= 5) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM health_log WHERE t < ?1").bind(now - 30 * 86400000),
    env.DB.prepare("DELETE FROM guest_views WHERE t < ?1").bind(now - 90 * 86400000),
    env.DB.prepare("DELETE FROM guest_rl WHERE win < ?1").bind(Math.floor(now / 600000) - 6)
  ]);
  console.log("daily prune done");
}

// 2FA 邮件投递确认 (2026-10-10): MAIL.send() 只代表 Cloudflare 收下了，收件方（Outlook）可能随后拒收。
// 这里查 Email Routing 的投递日志，返回 since 之后最新一封发往 ALERT_TO 的投递结果。仅经 portal（x-svc-key）可达。
async function mailDelivery(env, since) {
  if (!env.DB) return { state: "unknown", err: "no DB" };
  try {
    const r = await env.DB.prepare("SELECT id, status, sent_at, error FROM mail_outbox WHERE kind = '2fa' AND created_at >= ?1 ORDER BY id ASC LIMIT 1").bind(Math.max(0, (Number(since) || Date.now() - 600000) - 5000)).first();
    if (!r) return { state: "unknown" };
    return { state: r.status === "sent" ? "delivered" : r.status === "pending" ? "pending" : "failed", status: r.status, at: r.sent_at || null, detail: r.error || "" };
  } catch (e) { return { state: "unknown", err: String(e && e.message || e).slice(0, 160) }; }
}
async function mailDeliveryOld_unused(env, since) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_ID) return { state: "unknown", err: "no analytics token" };
  const s = new Date(Math.max(0, (since || Date.now() - 600000) - 5000)).toISOString().slice(0, 19) + "Z";
  const q = `query($z:String!,$s:Time!){viewer{zones(filter:{zoneTag:$z}){m:emailRoutingAdaptive(limit:5,filter:{datetime_geq:$s},orderBy:[datetime_DESC]){datetime to status errorDetail}}}}`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", signal: AbortSignal.timeout(8000), headers: { "Authorization": "Bearer " + env.CF_ANALYTICS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: { z: env.CF_ZONE_ID, s } }) });
    const d = await r.json();
    if (d.errors && d.errors.length) return { state: "unknown", err: String(d.errors[0].message || "graphql").slice(0, 160) };
    const rows = (((d.data || {}).viewer || {}).zones || [{}])[0].m || [];
    const row = rows.find(x => String(x.to || "").toLowerCase() === ALERT_TO.toLowerCase()) || null;
    if (!row) return { state: "pending" };
    const st = String(row.status || "");
    const detail = String(row.errorDetail || "").slice(0, 300);
    return { state: st === "delivered" ? "delivered" : /fail|reject|drop|bounce/i.test(st) ? "failed" : "other", status: st, at: row.datetime, spamhaus: /spamhaus/i.test(detail), detail };
  } catch (e) { return { state: "unknown", err: String(e && e.message || e).slice(0, 160) }; }
}

// ======================= Mail outbox (2026-10-10) =======================
// Outlook 拒收 Cloudflare send_email（发件域名进了 Spamhaus），所以所有提醒邮件不再走 MAIL binding，
// 而是写进 D1 mail_outbox（status = pending），由盒子上的 relay（/workspace/mailrelay/relay.py）每 ~5 分钟取出，
// 用 Grok Bot 邮箱 noreply@example.com 发到 Outlook，再标记 sent / failed / expired。MAIL binding 保留不动。
var OBX_SQL = "CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, html TEXT, status TEXT NOT NULL DEFAULT 'pending', sent_at INTEGER, error TEXT)";
function obxB64d(s) {
  const bin = atob(String(s || "").replace(/\s+/g, ""));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function obxParse(mime) {
  mime = String(mime || "");
  const i = mime.indexOf("\r\n\r\n");
  const head = i >= 0 ? mime.slice(0, i) : mime, body = i >= 0 ? mime.slice(i + 4) : "";
  const m = /^Subject: (.*)$/mi.exec(head);
  const subject = m ? m[1].trim().replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => obxB64d(b)) : "(无主题)";
  return { subject, text: /Content-Transfer-Encoding:\s*base64/i.test(head) ? obxB64d(body) : body };
}
async function outboxPut(env, kind, subject, text, html) {
  if (!env.DB) throw new Error("no DB binding");
  const ins = () => env.DB.prepare("INSERT INTO mail_outbox (created_at, kind, subject, text, html, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending') RETURNING id")
    .bind(Date.now(), String(kind || "alert").slice(0, 40), String(subject || "").slice(0, 300), String(text || "").slice(0, 20000), html ? String(html).slice(0, 60000) : null).first();
  let r;
  try { r = await ins(); }
  catch (e) {
    if (!/no such table/i.test(String(e && e.message || e))) throw e;
    await env.DB.prepare(OBX_SQL).run();
    r = await ins();
  }
  return r ? r.id : null;
}
async function outboxMime(env, kind, mime) {
  const p = obxParse(mime);
  return outboxPut(env, kind, p.subject, p.text, null);
}
