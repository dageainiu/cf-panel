import { EmailMessage } from "cloudflare:email";
import { connect } from "cloudflare:sockets";
// admin worker for panel.example.com workbench: /admin/tokens, /admin/audit, /admin/proxy
// No public route, workers.dev disabled. Reachable only via the portal service binding ADMIN (portal enforces the gate
// session; this worker enforces x-svc-key). Mostly read-only (the outbound pool on /admin/proxy is the only writer, see below): uses a least-privilege read token (ADMIN_RO_TOKEN), never renders
// secret values. Bindings: SVC_KEY, ADMIN_RO_TOKEN, OUTBOUND_POOL_JSON, OUTBOUND_POOL_KEY (secrets), DB (d1), MAIL (send_email),
// CFK (kv; only config.outboundProxy is ever written, by the outbound pool "set active" action), CFNEXT (service).
const ACC = "YOUR_CF_ACCOUNT_ID";
const ZONE = "YOUR_CF_ZONE_ID";
const HOST = "panel.example.com";
const API = "https://api.cloudflare.com/client/v4";

export default {
  async fetch(request, env, ctx) {
    try {
      const k = request.headers.get("x-svc-key") || "";
      if (!env.SVC_KEY || !(await ctEq(k, env.SVC_KEY))) return new Response("forbidden", { status: 403 });
      const url = new URL(request.url);
      const p = url.pathname.replace(/\/+$/, "") || "/";
      // State-changing routes: outbound pool, config rollback, (disabled) UUID rotate. All POST + CSRF bound to the gate session.
      if (request.method === "POST" && (p.startsWith("/admin/proxy/pool/") || p === "/admin/proxy/check" || p === "/admin/proxy/uuid-rotate" || p === "/admin/proxy/ip-opt-run")) return poolPost(request, env, ctx, url, p);
      if (request.method === "POST" && (p === "/admin/guests/create" || p === "/admin/guests/revoke")) return guestsPost(request, env, p);
      if (request.method === "POST" && p === "/admin/config-history/rollback") return configHistoryPost(request, env, ctx, p);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { "allow": "GET" } });
      const cfg = await loadCfg(env);
      if (p === "/admin/audit" || p === "/admin/proxy" || p === "/admin/tokens" || p === "/admin/config-history") await ghLoad(env).catch(() => null);
      const mask = s => maskAll(s, cfg);
      if (p === "/admin") return Response.redirect(new URL("/admin/tokens", url), 302);
      if (p === "/admin/tokens") return html(mask, await pageTokens(env, cfg));
      if (p === "/admin/audit") return html(mask, await pageAudit(env, cfg, url));
      if (p === "/admin/proxy") return html(mask, await pageProxy(env, cfg, url, request));
      if (p === "/admin/proxy/sub-url") return subUrl(request, env, ctx, cfg);
      if (p === "/admin/config-history") return html(mask, await pageConfigHistory(env, cfg, url, request));
      if (p === "/admin/guests") return html(mask, await pageGuests(env, request, url, null));
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("admin error: " + String(e && e.stack || e));
      return new Response("internal error", { status: 500 });
    }
  }
};

// ---------- helpers ----------
async function ctEq(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(String(a))), crypto.subtle.digest("SHA-256", enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function t8(v) {
  if (!v) return "—";
  const ms = typeof v === "number" ? v : Date.parse(v);
  if (!ms) return "—";
  return new Date(ms + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}
function ago(v) {
  if (!v) return "";
  const ms = Date.now() - (typeof v === "number" ? v : Date.parse(v));
  if (ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " 分钟前"; const h = Math.round(m / 60); if (h < 48) return h + " 小时前"; return Math.round(h / 24) + " 天前";
}
function bytes(n) { n = Number(n) || 0; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; }
function short(id) { id = String(id || ""); return id.length > 12 ? id.slice(0, 8) + "…" : id; }
function badge(cls, text) { return `<span class="b ${cls}">${esc(text)}</span>`; }
async function loadCfg(env) {
  try { const raw = env.CFK ? await env.CFK.get("config", { cacheTtl: 60 }) : null; return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
// Mask the proxy UUID / trojan password everywhere in rendered output (defence in depth).
function maskAll(s, cfg) {
  for (const v of [cfg.uuid, cfg.path, cfg.trojanPassword]) {
    if (v && String(v).length >= 8) s = s.split(String(v)).join(String(v).slice(0, 8) + "…");
  }
  return s;
}
async function cfApi(env, path, init) {
  const r = await fetch(API + path, Object.assign({ signal: AbortSignal.timeout(9000) }, init || {}, { headers: Object.assign({ "authorization": "Bearer " + env.ADMIN_RO_TOKEN, "content-type": "application/json" }, (init && init.headers) || {}) }));
  let d; try { d = await r.json(); } catch (e) { d = { success: false, errors: [{ message: "HTTP " + r.status }] }; }
  return d;
}
function apiErr(d) { return (d && d.errors && d.errors.length) ? d.errors.map(e => (e.code ? e.code + " " : "") + (e.message || "")).join("; ") : "未知错误"; }

// Known sources (labels shown on audit / proxy pages).
const BOX_IPS = []; // 你的部署机器出口 IP（审计用，可空）
const KNOWN = {
  // "203.0.113.10": ["tool", "示例：你的云机器"],
  // "198.51.100.20": ["user", "示例：家庭宽带出口"]
};
// Classification (2026-10): 「自家巡检」 ONLY by GitHub Actions IP ranges (api.github.com/meta) - a UA can be forged, so a
// GitHub-looking UA from a non-GitHub IP stays 陌生 (the UA is only mentioned in the label). WARP egress is a shared public
// exit (yellow, never hidden by 「仅非本机来源」). Cloudflare Workers egress 2a06:98c0::/29 is 「自家（Workers）」 only when the
// actor is our own guard token (5fe8e509, 令牌异常自动处置).
const WARP_M = cidrParse(["2a09:bac0::/29", "104.28.0.0/16", "104.30.0.0/16"]);
const CFW_M = cidrParse(["2a06:98c0::/29"]);
const GUARD_TOKEN_ID = "5fe8e509";
function ipInfo(ip, userIps, ua, tokenId) {
  ip = String(ip || "");
  const ghUa = isGhUa(ua);
  if (!ip) return ghUa ? { k: "self", label: "自家巡检（无 IP）" } : { k: "none", label: "（无 IP，平台内部）" };
  if (BOX_IPS.includes(ip) || /^140\.248\.5[02]\./.test(ip) || /^2a04:4e41:/i.test(ip)) return { k: "box", label: "Grok Bot 机器" };
  if (KNOWN[ip]) return { k: KNOWN[ip][0], label: KNOWN[ip][1] };
  if (cidrHas(CFW_M, ip) && String(tokenId || "").startsWith(GUARD_TOKEN_ID)) return { k: "self", label: "自家（Workers）" };
  if (isGhIp(ip)) return { k: "self", label: "自家巡检（GitHub Actions）" };
  if (cidrHas(WARP_M, ip)) return { k: "warp", label: "WARP 公共出口" + (userIps && userIps.has(ip) ? " · 登录过工作台" : "") };
  if (userIps && userIps.has(ip)) return { k: "user", label: "登录过工作台的 IP" };
  const dc = cidrHas(CFW_M, ip) ? "Cloudflare Workers" : dcGuess(ip);
  return { k: "unknown", label: (dc === "云服务器" ? "陌生 · 云服务器" : dc ? "陌生 · 疑似" + dc : "陌生 IP") + (ghUa ? "（UA 自称 GitHub 巡检，但 IP 不在 GitHub 范围）" : "") };
}
function ipBadge(info) {
  const cls = info.k === "box" || info.k === "self" ? "gray" : info.k === "user" ? "grn" : info.k === "tool" || info.k === "warp" ? "yel" : info.k === "none" ? "gray" : "red";
  return badge(cls, info.label);
}
// Rough datacenter / VPS guess by well-known IPv4 prefixes (Free plan analytics has no ASN).
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
// Cloud guess: small, conservative CIDR list. Anything else inside big shared cloud /8s is just 「云服务器」.
const DC_LIST = [
  // Microsoft / Azure
  ["13.64.0.0/11", "Azure"], ["13.96.0.0/13", "Azure"], ["13.104.0.0/14", "Azure"], ["20.36.0.0/14", "Azure"], ["20.40.0.0/13", "Azure"], ["20.48.0.0/12", "Azure"], ["20.64.0.0/10", "Azure"], ["20.128.0.0/9", "Azure"],
  ["40.64.0.0/10", "Azure"], ["52.96.0.0/12", "Azure"], ["52.112.0.0/14", "Azure"], ["52.120.0.0/14", "Azure"], ["52.136.0.0/13", "Azure"], ["52.145.0.0/16", "Azure"], ["52.146.0.0/15", "Azure"],
  ["52.148.0.0/14", "Azure"], ["52.152.0.0/13", "Azure"], ["52.160.0.0/11", "Azure"], ["52.224.0.0/11", "Azure"], ["104.40.0.0/13", "Azure"], ["104.208.0.0/13", "Azure"],
  ["137.116.0.0/15", "Azure"], ["137.135.0.0/16", "Azure"], ["138.91.0.0/16", "Azure"], ["168.61.0.0/16", "Azure"], ["168.62.0.0/15", "Azure"], ["191.232.0.0/13", "Azure"],
  // AWS
  ["3.0.0.0/8", "AWS"], ["13.32.0.0/12", "AWS"], ["13.48.0.0/13", "AWS"], ["13.56.0.0/14", "AWS"], ["18.128.0.0/9", "AWS"], ["34.192.0.0/10", "AWS"],
  ["35.152.0.0/13", "AWS"], ["35.160.0.0/12", "AWS"], ["35.176.0.0/13", "AWS"], ["44.192.0.0/10", "AWS"],
  ["52.0.0.0/11", "AWS"], ["52.32.0.0/11", "AWS"], ["52.64.0.0/12", "AWS"], ["52.84.0.0/14", "AWS"], ["52.88.0.0/13", "AWS"], ["52.192.0.0/11", "AWS"],
  ["54.64.0.0/10", "AWS"], ["54.144.0.0/12", "AWS"], ["54.160.0.0/11", "AWS"], ["54.192.0.0/10", "AWS"], ["100.20.0.0/14", "AWS"], ["100.24.0.0/13", "AWS"],
  // Google Cloud
  ["34.0.0.0/9", "Google Cloud"], ["34.128.0.0/10", "Google Cloud"], ["35.184.0.0/13", "Google Cloud"], ["35.192.0.0/12", "Google Cloud"], ["35.208.0.0/12", "Google Cloud"],
  ["35.224.0.0/12", "Google Cloud"], ["35.240.0.0/13", "Google Cloud"],
  // OVH (only its well-known blocks; the rest of 51.x is NOT OVH)
  ["54.36.0.0/14", "OVH"], ["51.38.0.0/16", "OVH"], ["51.68.0.0/16", "OVH"], ["51.75.0.0/16", "OVH"], ["51.77.0.0/16", "OVH"], ["51.79.0.0/16", "OVH"], ["51.83.0.0/16", "OVH"],
  ["51.89.0.0/16", "OVH"], ["51.91.0.0/16", "OVH"], ["51.161.0.0/16", "OVH"], ["51.178.0.0/16", "OVH"], ["51.195.0.0/16", "OVH"], ["51.210.0.0/16", "OVH"], ["51.222.0.0/16", "OVH"],
  ["51.254.0.0/15", "OVH"], ["137.74.0.0/16", "OVH"], ["141.94.0.0/15", "OVH"], ["145.239.0.0/16", "OVH"], ["147.135.0.0/16", "OVH"], ["149.56.0.0/16", "OVH"], ["149.202.0.0/16", "OVH"],
  ["158.69.0.0/16", "OVH"], ["164.132.0.0/16", "OVH"], ["167.114.0.0/16", "OVH"], ["176.31.0.0/16", "OVH"], ["178.32.0.0/15", "OVH"], ["188.165.0.0/16", "OVH"], ["192.99.0.0/16", "OVH"],
  ["198.27.64.0/18", "OVH"], ["198.50.128.0/17", "OVH"], ["213.32.0.0/17", "OVH"], ["213.251.128.0/18", "OVH"],
  // 阿里云 (narrowed: 39.x / 47.x / 8.x are NOT all Alibaba)
  ["8.128.0.0/10", "阿里云"], ["8.208.0.0/12", "阿里云"], ["39.96.0.0/13", "阿里云"], ["39.104.0.0/14", "阿里云"], ["47.74.0.0/15", "阿里云"], ["47.76.0.0/14", "阿里云"],
  ["47.80.0.0/12", "阿里云"], ["47.96.0.0/11", "阿里云"],
  // Cloudflare edge (not WARP; WARP egress is labelled separately)
  ["172.64.0.0/13", "Cloudflare"], ["162.158.0.0/15", "Cloudflare"]
];
const DC_M = DC_LIST.map(([c, n]) => [cidrParse([c]), n]);
// big /8s shared by several clouds/hosters: if not matched above, say only 「云服务器」
const DC_GENERIC = cidrParse(["4.0.0.0/8", "13.0.0.0/8", "15.0.0.0/8", "20.0.0.0/8", "34.0.0.0/8", "35.0.0.0/8", "40.0.0.0/8", "44.0.0.0/8", "51.0.0.0/8", "52.0.0.0/8", "54.0.0.0/8", "99.0.0.0/8", "100.20.0.0/14", "130.211.0.0/16"]);

// Hoster guess for smaller providers by /16 (Free plan analytics has no ASN); big clouds use the CIDR list DC_LIST above.
const DC = [
  [/^(104\.131|104\.236|138\.68|138\.197|139\.59|142\.93|143\.110|143\.198|146\.190|157\.230|159\.65|159\.89|159\.203|161\.35|164\.90|164\.92|165\.22|165\.227|167\.71|167\.99|167\.172|170\.64|174\.138|178\.62|188\.166|206\.189|209\.97)\./, "DigitalOcean"],
  [/^(45\.32|45\.63|45\.76|45\.77|64\.176|66\.42|78\.141|95\.179|108\.61|136\.244|141\.164|144\.202|149\.28|149\.248|155\.138|207\.148|208\.167|216\.128)\./, "Vultr"],
  [/^(45\.33|45\.56|45\.79|50\.116|66\.175|96\.126|139\.144|139\.162|172\.104|172\.105|173\.255|192\.46|198\.58)\./, "Linode/Akamai"],
  [/^(5\.75|5\.161|23\.88|49\.12|49\.13|65\.108|65\.109|65\.21|78\.46|78\.47|88\.198|88\.99|91\.107|94\.130|95\.216|95\.217|116\.202|116\.203|128\.140|135\.181|136\.243|138\.201|142\.132|144\.76|148\.251|157\.90|159\.69|162\.55|167\.233|167\.235|168\.119|176\.9|178\.63|188\.34|188\.40|195\.201|213\.133|213\.239)\./, "Hetzner"],
  [/^(106\.75|152\.32|165\.154|101\.36|117\.50|128\.1)\./, "UCloud"],
  [/^(43\.1[2-6]\d|49\.51|62\.234|81\.68|82\.156|101\.32|101\.33|101\.34|106\.52|106\.53|106\.54|110\.40|111\.229|111\.230|118\.24|118\.25|119\.28|119\.29|119\.45|123\.206|124\.156|124\.220|124\.221|124\.222|129\.204|129\.211|129\.226|134\.175|150\.109|150\.158|162\.62|170\.106|175\.178|175\.24|182\.254|193\.112|203\.195|212\.64)\./, "腾讯云"],
  [/^(129\.146|129\.150|129\.151|129\.153|129\.154|129\.159|130\.61|130\.162|132\.145|132\.226|134\.65|134\.70|138\.2|138\.3|140\.238|141\.144|141\.145|141\.147|141\.148|143\.47|144\.21|144\.22|144\.24|146\.56|150\.136|150\.230|152\.67|152\.69|152\.70|155\.248|158\.101|158\.178|158\.179|158\.180|168\.75|168\.138|192\.9|193\.122|193\.123)\./, "Oracle Cloud"]
];
function dcGuess(ip) {
  if (/^2a09:bac/i.test(ip)) return "Cloudflare WARP";
  if (String(ip).includes(":")) return "";
  for (const [m, n] of DC_M) if (cidrHas(m, ip)) return n;
  for (const [re, n] of DC) if (re.test(ip)) return n;
  if (cidrHas(DC_GENERIC, ip)) return "云服务器";
  return "";
}
async function userIpSet(env) {
  const s = new Set();
  try {
    const r = await env.DB.prepare("SELECT DISTINCT ip FROM admin_log WHERE type='login' AND t > ?1").bind(Date.now() - 30 * 86400000).all();
    for (const x of (r.results || [])) if (x.ip) s.add(x.ip);
  } catch (e) {}
  return s;
}
function uaShort(ua) {
  ua = String(ua || "");
  if (!ua) return "（无）";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh|Darwin/.test(ua) ? "Mac/iOS" : /Linux/.test(ua) ? "Linux" : "";
  if (isGhUa(ua)) return "自称 GitHub 巡检脚本（以 IP 为准）";
  const app = /Hako/i.test(ua) ? "Hako" : /clash/i.test(ua) ? "Clash" : /sing-box/i.test(ua) ? "sing-box" : /v2ray|xray/i.test(ua) ? "V2Ray/Xray" : /shadowrocket/i.test(ua) ? "Shadowrocket" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : /CFNetwork/.test(ua) ? "iOS 系统网络" : /Go-http-client/.test(ua) ? "Go 程序" : /curl/i.test(ua) ? "curl" : /python/i.test(ua) ? "Python" : "";
  return [app, os].filter(Boolean).join(" · ") || ua.slice(0, 40);
}

// ---------- layout ----------
const CSS = `:root{--bg:#09090b;--card:#18181b;--card2:#18181b;--line:#27272a;--txt:#fafafa;--muted:#a1a1aa;--brand:#8b5cf6;--brand2:#a78bfa;--ok:#22c55e;--warn:#eab308;--err:#ef4444}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--txt);background:radial-gradient(1100px 650px at 88% -12%,rgba(122,92,255,.16),transparent 60%),radial-gradient(900px 600px at -5% 110%,rgba(91,140,255,.14),transparent 55%),var(--bg)}
a{color:#9db8ff}main{max-width:1180px;margin:auto;padding:28px 18px 72px}
.mark{letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:var(--muted);margin:0}
h1{font-weight:650;font-size:30px;margin:6px 0 4px}h2{font-size:18px;margin:0 0 12px;font-weight:620}.sub{color:var(--muted);margin:0 0 18px;line-height:1.6}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 22px}nav a{text-decoration:none;color:var(--txt);border:1px solid var(--line);background:var(--card);padding:8px 14px;border-radius:12px;font-size:14px}
nav a.on{background:linear-gradient(135deg,var(--brand),var(--brand2));border-color:transparent;box-shadow:0 10px 26px rgba(91,140,255,.35)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 12px rgb(0 0 0 / 0.2);padding:20px;margin-bottom:18px;transition:all 0.2s cubic-bezier(0.4,0,0.2,1)}
.card:hover{border-color:#3f3f46;box-shadow:0 8px 24px rgb(0 0 0 / 0.3);transform:translateY(-2px)}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:560;white-space:nowrap}
tr.hl td{background:rgba(255,107,107,.07)}tr.hy td{background:rgba(255,184,77,.06)}
.b{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;margin:1px 4px 1px 0;white-space:nowrap;border:1px solid transparent}
.b.red{background:rgba(255,107,107,.14);color:#ff9d9d;border-color:rgba(255,107,107,.3)}.b.yel{background:rgba(255,184,77,.13);color:#ffd08a;border-color:rgba(255,184,77,.3)}
.b.grn{background:rgba(56,211,159,.13);color:#7be8bf;border-color:rgba(56,211,159,.28)}.b.gray{background:rgba(255,255,255,.06);color:var(--muted)}.b.blue{background:rgba(91,140,255,.15);color:#a9c1ff}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}.muted{color:var(--muted)}.small{font-size:12px}
.kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:18px}.kpi{background:var(--card2);border:1px solid var(--line);border-radius:14px;padding:14px}.kpi b{display:block;font-size:22px;margin-top:4px}
.btn{display:inline-block;border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border-radius:11px;padding:9px 14px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;box-shadow:0 10px 24px rgba(91,140,255,.3)}
.btn.ghost{background:var(--card2);border:1px solid var(--line);box-shadow:none;color:var(--txt);font-weight:500}
form.f{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}select,input[type=text]{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;font-size:14px}
label.c{display:flex;gap:6px;align-items:center;font-size:14px;color:var(--txt)}.pg{display:flex;gap:10px;align-items:center;margin-top:12px}
.note{border-left:3px solid var(--warn);background:rgba(255,184,77,.06);padding:10px 14px;border-radius:8px;color:#f3d7a6;line-height:1.6;font-size:14px;margin:0 0 14px}
.bar{height:8px;border-radius:6px;background:linear-gradient(90deg,var(--brand),var(--brand2));min-width:2px}
.mt{margin-top:7px}.mt2{margin-top:20px}.errt{color:#ff9d9d}form.inl{display:inline}.kb{font-size:16px!important}.wh{min-width:170px}.wp{width:90px}.note.nok{border-left-color:var(--ok);background:rgba(56,211,159,.07);color:#bff2de}.note.nerr{border-left-color:var(--err);background:rgba(255,107,107,.07);color:#ffc4c4}input[type=password]{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;font-size:14px}#subbox{display:none;margin-top:10px}#subbox.show{display:block}progress{width:120px;accent-color:#7a5cff}#subbox input{width:100%}.wfull{width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}button[disabled]{opacity:.55;cursor:not-allowed}`;
function html(mask, page) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const nav = [["/admin/tokens", "令牌 / 密钥"], ["/admin/audit", "审计日志"], ["/admin/proxy", "代理节点"], ["/admin/config-history", "配置版本"], ["/admin/guests", "访客"]]
    .map(([h, t]) => `<a href="${h}"${page.active === h ? ' class="on"' : ""}>${t}</a>`).join("");
  let body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${esc(page.title)} · 工作台</title><style nonce="${nonce}">${CSS}</style></head><body><main><p class="mark">panel.example.com · 工作台</p><h1>${esc(page.title)}</h1><nav><a href="/">← 工作台</a>${nav}</nav>${page.body}<p class="muted small">生成于 ${esc(t8(Date.now()))}（UTC+8）· 数据实时从 Cloudflare 读取，不显示任何密钥值。</p></main>${page.script ? `<script nonce="${nonce}">${page.script}</script>` : ""}</body></html>`;
  body = mask(body);
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  return new Response(body, { status: page.status || 200, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private", "content-security-policy": csp,
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains", "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "cross-origin-opener-policy": "same-origin", "x-robots-tag": "noindex, nofollow" } });
}
function errCard(title, msg) { return `<div class="card"><h2>${esc(title)}</h2><p class="note">读取失败：${esc(msg)}</p></div>`; }

// ---------- PAGE 2: tokens / secrets ----------
const TOKEN_NOTES = {
  "0a07a87c": ["面板部署用（Grok Bot）", "Grok Bot 部署 Worker、改 DNS/WAF 用的。永久全权限（除建令牌外），只存放在 Grok Bot 机器上。建议日后不再频繁改动时，给它设个有效期或缩小到 Workers + DNS。"],
  "72cc628e": ["建令牌用（proxy-admin）", "唯一一个能「创建 / 删除令牌」的令牌，等同最高权限的钥匙。只在 Grok Bot 机器上，从不放进任何 Worker。平时不用时可以考虑撤销，需要时再建。"],
  "8fff6f50": ["交给云端 AI 工具", "你交给云端 AI 工具（沙箱）的永久全权限令牌。那个工具只需要管隧道和 DNS，建议换成只含 Tunnel + DNS 权限、只限本域名的新令牌，然后撤销这个。"],
  "137bbce7": ["本页面只读令牌 · ADMIN_RO_TOKEN", "管理页（本页面）专用，只读、1 年有效，存在 admin Worker 的加密变量里。正常。"],
  "578ed7b9": ["状态面板 · CF_ANALYTICS_TOKEN", "状态面板读流量分析用，只读、只限本域名。建议加一个有效期。"],
  "5e53ff62": ["GitHub 巡检（domain-guard）", "GitHub Actions 每小时巡检用，只读、只限本域名。建议加一个有效期。"],
  "4b2c0320": ["GitHub 每日备份 · CF_BACKUP_TOKEN", "GitHub Actions 每天 03:20 备份配置用，只读（Workers / DNS / 防火墙 / KV / D1 读取）。存在 domain-guard 仓库的加密变量里。正常，建议加一个有效期。"],
  "5fe8e509": ["令牌异常自动处置 · GUARD_TOKEN", "status Worker 的「令牌异常自动处置」用：读审计日志 + 只能改本域名 DNS（用于自动删除可疑记录和一键恢复），1 年有效。它的操作来自 Cloudflare Workers 出口 IP（2a06:98c0:…），面板里标为「自家（Workers）」。正常。"]
};
function tokenNote(id) { return TOKEN_NOTES[String(id).slice(0, 8)] || null; }
function scopeSummary(policies) {
  const out = new Set();
  for (const p of policies || []) for (const r of Object.keys(p.resources || {})) {
    if (r.startsWith("com.cloudflare.api.user.")) out.add("用户");
    else if (r === "com.cloudflare.api.account.zone.*") out.add("所有域名");
    else if (r.startsWith("com.cloudflare.api.account.zone.")) out.add(r.endsWith(ZONE) ? "本域名" : "其他域名");
    else if (r === "com.cloudflare.api.account.*") out.add("所有账户");
    else if (r.startsWith("com.cloudflare.api.account.")) out.add(r.endsWith(ACC) ? "本账户" : "其他账户");
    else out.add(r.slice(0, 30));
  }
  return [...out];
}
async function pageTokens(env, cfg) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19) + "Z", before = new Date().toISOString().slice(0, 19) + "Z";
  const [ut, at, sc, au, uips] = await Promise.all([
    cfApi(env, "/user/tokens?per_page=100").catch(e => ({ success: false, errors: [{ message: String(e) }] })),
    cfApi(env, `/accounts/${ACC}/tokens?per_page=100`).catch(e => ({ success: false, errors: [{ message: String(e) }] })),
    cfApi(env, `/accounts/${ACC}/workers/scripts`).catch(e => ({ success: false, errors: [{ message: String(e) }] })),
    cfApi(env, `/accounts/${ACC}/logs/audit?since=${since}&before=${before}&limit=1000&direction=desc`).catch(e => ({ success: false })),
    userIpSet(env)
  ]);
  // token id -> {ips:Map(ip->count), writes}
  const use = {};
  if (au && au.success) for (const e of au.result || []) {
    const tk = e.actor && e.actor.token; if (!tk || !tk.id) continue;
    const u = use[tk.id] || (use[tk.id] = { ips: new Map(), n: 0, last: "" });
    u.n++; const ip = e.actor.ip_address || ""; u.ips.set(ip, (u.ips.get(ip) || 0) + 1);
    const t = e.action && e.action.time; if (t && t > u.last) u.last = t;
  }
  let body = `<p class="sub">列出账户里所有 Cloudflare API 令牌和每个 Worker 保存的密钥<b>名称</b>（不含任何值），并按风险标注。</p>`;
  body += `<p class="note">撤销 / 轮换令牌需要「API Tokens Write」权限，而 Cloudflare 不允许把这种权限再细分给子令牌。为了不把能建令牌的钥匙放进网页后台，这里<b>不提供一键撤销</b>，按钮会打开 Cloudflare 官方的令牌页面，由你在那里操作（或者直接让 Grok Bot 做）。</p>`;
  const rows = [];
  const all = [];
  if (ut && ut.success) for (const t of ut.result || []) all.push(Object.assign({ _kind: "用户令牌" }, t));
  if (at && at.success) for (const t of at.result || []) all.push(Object.assign({ _kind: "账户令牌" }, t));
  all.sort((a, b) => String(b.last_used_on || "").localeCompare(String(a.last_used_on || "")));
  let nFull = 0, nNoExp = 0, nRisk = 0;
  for (const t of all) {
    const groups = (t.policies || []).reduce((n, p) => n + (p.permission_groups || []).length, 0);
    const names = [...new Set((t.policies || []).flatMap(p => (p.permission_groups || []).map(g => g.name)))];
    const tokWrite = names.some(n => /^API Tokens Write$|^Account API Tokens Write$/.test(n));
    const note = tokenNote(t.id);
    const b = [];
    let risk = 0;
    if (t.status !== "active") b.push(badge("gray", t.status === "disabled" ? "已停用" : t.status === "expired" ? "已过期" : t.status));
    if (groups >= 300) { b.push(badge("red", "全权限")); nFull++; risk = 2; }
    if (tokWrite) { b.push(badge("red", "可创建令牌")); risk = 2; }
    if (!t.expires_on) { b.push(badge("yel", "永不过期")); nNoExp++; risk = Math.max(risk, 1); }
    else { const left = Date.parse(t.expires_on) - Date.now(); if (left < 14 * 86400000) b.push(badge("yel", "即将过期")); }
    if (!t.last_used_on) b.push(badge("gray", "从未使用"));
    else if (Date.now() - Date.parse(t.last_used_on) > 30 * 86400000) b.push(badge("yel", "30 天未用"));
    const u = use[t.id];
    const foreign = [];
    if (u) for (const [ip, c] of u.ips) { const inf = ipInfo(ip, uips, "", t.id); if (inf.k === "unknown") foreign.push(ip); }
    if (foreign.length) { b.push(badge("red", "近 7 天有陌生 IP 写操作")); risk = 2; }
    if (t.condition && t.condition.request_ip) b.push(badge("grn", "限制来源 IP"));
    if (risk === 2) nRisk++;
    if (!b.length || (risk === 0 && t.status === "active")) b.push(badge("grn", "低风险"));
    const usage = u ? `<div class="small muted">近 7 天写操作 ${u.n} 次，来源：${[...u.ips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ip, c]) => `<span class="mono">${esc(ip || "—")}</span> ${ipBadge(ipInfo(ip, uips, "", t.id))}`).join(" ")}</div>` : `<div class="small muted">近 7 天无写操作记录</div>`;
    rows.push(`<tr class="${risk === 2 ? "hl" : risk === 1 ? "hy" : ""}"><td><b>${esc(t.name)}</b>${note ? `<div>${badge("blue", note[0])}</div>` : ""}<div class="small muted">${esc(t._kind)}</div></td>
<td class="mono">${esc(short(t.id))}</td><td>${t.status === "active" ? badge("grn", "有效") : badge("gray", t.status)}</td>
<td class="small">${esc(t8(t.issued_on))}</td><td class="small">${esc(t8(t.last_used_on))}<div class="muted">${esc(ago(t.last_used_on))}</div></td><td class="small">${t.expires_on ? esc(t8(t.expires_on)) : "永不"}</td>
<td class="small"><b>${groups}</b> 项权限 · ${esc(scopeSummary(t.policies).join("、"))}<div class="muted">${esc(names.slice(0, 4).join("、"))}${names.length > 4 ? " 等" : ""}</div></td>
<td>${b.join("")}${usage}<div class="small mt">${esc(note ? note[1] : (groups >= 300 ? "权限过大，确认用途后建议缩小权限或撤销。" : "面板没有登记这个令牌。请先确认是不是你自己（或 Grok Bot）新建的；确认不认识再撤销。"))}</div>
<div class="mt"><a class="btn ghost" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">撤销 / 轮换 ↗</a></div></td></tr>`);
  }
  body += `<div class="kpis"><div class="kpi"><span class="muted small">令牌总数</span><b>${all.length}</b></div><div class="kpi"><span class="muted small">全权限</span><b>${nFull}</b></div><div class="kpi"><span class="muted small">永不过期</span><b>${nNoExp}</b></div><div class="kpi"><span class="muted small">高风险</span><b>${nRisk}</b></div></div>`;
  if (!(ut && ut.success)) body += errCard("用户令牌", apiErr(ut));
  body += `<div class="card"><h2>API 令牌</h2><div class="tw"><table><thead><tr><th>名称</th><th>ID</th><th>状态</th><th>创建（UTC+8）</th><th>最后使用</th><th>到期</th><th>权限</th><th>风险与建议</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="8" class="muted">没有令牌</td></tr>`}</tbody></table></div>
<p class="small muted">${at && at.success ? `账户级令牌：${(at.result || []).length} 个。` : "账户级令牌：读取失败（" + esc(apiErr(at)) + "）。"} 「最后使用」由 Cloudflare 记录，精确到天级别的近似值；「来源」来自账户审计日志（只含写操作）。</p></div>`;

  // Worker secrets (names only)
  if (sc && sc.success) {
    const scripts = (sc.result || []).map(s => s.id).sort();
    const lists = await Promise.all(scripts.map(n => cfApi(env, `/accounts/${ACC}/workers/scripts/${encodeURIComponent(n)}/secrets`).catch(e => ({ success: false, errors: [{ message: String(e) }] }))));
    const SECRET_NOTES = { ADMIN_RO_TOKEN: "本页面只读令牌", CF_ANALYTICS_TOKEN: "状态面板分析令牌（只读）", SVC_KEY: "内部服务互信密钥", SESSION_SECRET: "工作台登录签名密钥", PASSWORD: "工作台登录密码", LLM_SSO_KEY: "AI 助手免密登录签名", SSO_KEY: "AI 助手免密登录签名", ALLM_PASSWORD: "AnythingLLM 登录密码", GH_TOKEN: "网盘用 GitHub 令牌", MS_REFRESH_TOKEN: "Outlook 读取授权", TURNSTILE_SECRET: "人机验证密钥", CI_REPORT_KEY: "GitHub 巡检回报密钥", PANEL: "代理面板路径（回退；实际以 KV config.path 为准）", ADMIN_SVC_KEY: "管理页内部互信密钥", CSRF_KEY: "管理页表单防伪签名密钥", CI_WRITE_KEY: "GitHub 巡检写操作密钥（出站切换 / 恢复 DNS）", GUARD_TOKEN: "令牌异常自动处置用令牌", OUTBOUND_POOL_JSON: "出站代理密码（加密）", OUTBOUND_POOL_KEY: "出站代理密码加密密钥", TOTP_KEY: "两步验证密钥（加密 TOTP 密钥 + 恢复码哈希）", CONFIG_KEY: "CFNext 配置版本加密密钥" };
    const srows = scripts.map((n, i) => {
      const d = lists[i];
      const names = d && d.success ? (d.result || []).map(x => x.name).sort() : null;
      return `<tr><td><b>${esc(n)}</b></td><td>${names === null ? `<span class="muted">读取失败：${esc(apiErr(d))}</span>` : names.length ? names.map(x => `<span class="b gray mono" title="${esc(SECRET_NOTES[x] || "")}">${esc(x)}</span>${SECRET_NOTES[x] ? `<span class="small muted">${esc(SECRET_NOTES[x])}</span> ` : ""}`).join(" ") : `<span class="muted">无</span>`}</td></tr>`;
    }).join("");
    body += `<div class="card"><h2>Worker 密钥（只显示名称）</h2><div class="tw"><table><thead><tr><th>Worker</th><th>保存的密钥</th></tr></thead><tbody>${srows}</tbody></table></div><p class="small muted">密钥值是加密存储的，Cloudflare 也不允许读回，这里只能看到名称。cfnext 的 UUID / 管理密码保存在 KV 配置里，不属于 Worker 密钥。</p></div>`;
  } else body += errCard("Worker 密钥", apiErr(sc));
  return { title: "令牌 / 密钥管理", active: "/admin/tokens", body };
}

// ---------- PAGE 3: audit ----------
const AI_TOKEN = "8fff6f50";
function v1ToV2(x) {
  return { id: x.id, action: { type: (x.action && x.action.type) || "", description: (x.action && (x.action.info || x.action.type)) || "", result: x.action && x.action.result ? "success" : "failure", time: x.when },
    actor: { email: x.actor && x.actor.email, ip_address: x.actor && x.actor.ip, context: x.interface || (x.actor && x.actor.type) || "" },
    resource: { product: x.resource && x.resource.type, id: x.resource && x.resource.id } };
}
function resDesc(e) {
  const r = e.resource || {}, req = r.request || {}, resp = r.response || {};
  const kind = [r.product, r.type].filter(Boolean).join(" / ");
  let name = "";
  if (typeof req.name === "string") name = req.name; else if (typeof resp.name === "string") name = resp.name;
  if (r.product === "dns" || r.product === "dns_records") { const t = req.type || resp.type; name = [t, req.name || resp.name, req.content || resp.content].filter(x => typeof x === "string" && x).join(" "); }
  try { const mr = r.value && r.value.new && r.value.new.modified_rules; if (Array.isArray(mr) && mr[0] && mr[0].description) name = "规则：" + mr[0].description; } catch (x) {}
  if (!name && r.id) name = r.id;
  let uri = (e.raw && e.raw.uri) || "";
  uri = uri.replace("/accounts/" + ACC, "/acc").replace("/zones/" + ZONE, "/zone").split("?")[0];
  return { kind, kindCn: resCn(r.product, r.type) || kind, name: String(name).slice(0, 140), uri: uri.slice(0, 120) };
}
const RES_CN = { dns: "DNS 记录", dns_records: "DNS 记录", dns_settings: "DNS 设置", workers: "Worker", worker: "Worker", workers_scripts: "Worker 脚本", script: "Worker 脚本", scripts: "Worker 脚本",
  workers_kv: "KV 存储", kv: "KV 存储", kv_namespace: "KV 命名空间", d1: "D1 数据库", d1_database: "D1 数据库", cfd_tunnel: "隧道", tunnel: "隧道", tunnels: "隧道",
  tokens: "API 令牌", token: "API 令牌", api_tokens: "API 令牌", rulesets: "规则集（WAF / 限流）", ruleset: "规则集（WAF / 限流）", firewall: "防火墙", waf: "WAF", rate_limit: "限流",
  zone: "域名", zones: "域名", settings: "域名设置", zone_settings: "域名设置", email_routing: "邮件路由", email: "邮件", routes: "Worker 路由", route: "Worker 路由",
  account: "账户", members: "成员", member: "成员", user: "用户", login: "登录", ssl: "SSL 证书", certificates: "证书", page_rules: "页面规则", cache: "缓存",
  secrets: "Worker 密钥", secret: "Worker 密钥", subdomain: "workers.dev 子域", deployments: "Worker 部署", versions: "Worker 版本", analytics: "流量分析", logs: "日志",
  turnstile: "人机验证", bot_management: "机器人防护", access: "Zero Trust Access", gateway: "Zero Trust Gateway", r2: "R2 存储", pages: "Pages" };
function resCn(prod, typ) { const a = RES_CN[String(prod || "").toLowerCase()], b = RES_CN[String(typ || "").toLowerCase()]; return [a, b && b !== a ? b : ""].filter(Boolean).join(" / "); }
function isWrite(e) {
  const t = (e.action && e.action.type) || "", m = (e.raw && e.raw.method) || "";
  if (m) return !/^(GET|HEAD|OPTIONS)$/i.test(m) && !/Run a query|List keys/i.test((e.action && e.action.description) || "");
  return /create|update|delete|deploy|edit|add|remove|rotate|revoke|script_/i.test(t);
}
function qs(o) { return Object.entries(o).filter(([k, v]) => v !== "" && v != null && v !== false).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&"); }
async function pageAudit(env, cfg, url) {
  const tab = url.searchParams.get("tab") === "login" ? "login" : "cf";
  const pg = Math.max(1, Math.min(200, parseInt(url.searchParams.get("p") || "1", 10) || 1));
  const tabs = `<form class="f"><a class="btn ${tab === "cf" ? "" : "ghost"}" href="/admin/audit">Cloudflare 操作记录</a><a class="btn ${tab === "login" ? "" : "ghost"}" href="/admin/audit?tab=login">工作台登录记录</a></form>`;
  const uips = await userIpSet(env);
  if (tab === "login") return { title: "审计日志", active: "/admin/audit", body: tabs + await loginTab(env, uips, pg) };
  const w = url.searchParams.get("w") === "1", ext = url.searchParams.get("ext") === "1";
  const tok = String(url.searchParams.get("tok") || "").replace(/[^0-9a-f]/gi, "").slice(0, 32);
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19) + "Z", before = new Date().toISOString().slice(0, 19) + "Z";
  let src = "v2", list = [], err = "";
  const [d, ut, co] = await Promise.all([
    cfApi(env, `/accounts/${ACC}/logs/audit?since=${since}&before=${before}&limit=1000&direction=desc`).catch(e => ({ success: false, errors: [{ message: String(e) }] })),
    cfApi(env, "/user/tokens?per_page=100").catch(e => ({ success: false })),
    env.DB.prepare("SELECT ip, co FROM events WHERE t > ?1 GROUP BY ip").bind(Date.now() - 30 * 86400000).all().catch(() => ({ results: [] }))
  ]);
  if (d && d.success) list = d.result || [];
  else {
    err = apiErr(d); src = "v1";
    const d1 = await cfApi(env, `/accounts/${ACC}/audit_logs?since=${since}&per_page=1000&direction=desc`).catch(e => ({ success: false, errors: [{ message: String(e) }] }));
    if (d1 && d1.success) list = (d1.result || []).map(v1ToV2); else err += "；v1：" + apiErr(d1);
  }
  const tname = {}; if (ut && ut.success) for (const t of ut.result || []) tname[t.id] = t.name;
  const ipCo = {}; for (const r of (co.results || [])) if (r.ip && r.co) ipCo[r.ip] = r.co;
  const tokSeen = new Map();
  for (const e of list) { const t = e.actor && e.actor.token; if (t && t.id) tokSeen.set(t.id, t.name || tname[t.id] || short(t.id)); }
  let rows = list;
  if (w) rows = rows.filter(isWrite);
  const tokOf = e => (e.actor && e.actor.token && e.actor.token.id) || "";
  if (ext) rows = rows.filter(e => ipInfo(e.actor && e.actor.ip_address, uips, e.raw && e.raw.user_agent, tokOf(e)).k !== "box");
  if (tok) rows = rows.filter(e => e.actor && e.actor.token && String(e.actor.token.id).startsWith(tok));
  const total = rows.length, per = 50, pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(pg, pages);
  const view = rows.slice((cur - 1) * per, cur * per);
  const nAi = list.filter(e => e.actor && e.actor.token && String(e.actor.token.id).startsWith(AI_TOKEN)).length;
  const nUnknown = list.filter(e => ipInfo(e.actor && e.actor.ip_address, uips, e.raw && e.raw.user_agent, tokOf(e)).k === "unknown").length;
  let body = tabs + `<p class="sub">账户审计日志（最近 7 天，最新在前，来源 Cloudflare ${src === "v2" ? "v2" : "v1（v2 不可用时的备用接口）"}）。红色 = 交给云端 AI 工具的全权限令牌，或不在已知名单里的来源 IP。</p>`;
  if (err && src === "v1") body += `<p class="note">v2 审计接口读取失败（${esc(err)}），已改用 v1。</p>`;
  body += `<div class="kpis"><div class="kpi"><span class="muted small">7 天记录</span><b>${list.length}</b></div><div class="kpi"><span class="muted small">云端 AI 工具令牌</span><b>${nAi}</b></div><div class="kpi"><span class="muted small">陌生 IP 操作</span><b>${nUnknown}</b></div><div class="kpi"><span class="muted small">当前筛选</span><b>${total}</b></div></div>`;
  const opts = [...tokSeen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => `<option value="${esc(id.slice(0, 8))}"${tok && id.startsWith(tok) ? " selected" : ""}>${esc(n)}（${esc(id.slice(0, 8))}）</option>`).join("");
  body += `<div class="card"><form class="f" method="get" action="/admin/audit"><label class="c"><input type="checkbox" name="w" value="1"${w ? " checked" : ""}> 仅写操作</label><label class="c"><input type="checkbox" name="ext" value="1"${ext ? " checked" : ""}> 仅非本机来源</label><select name="tok"><option value="">全部令牌</option>${opts}</select><button class="btn" type="submit">筛选</button><a class="btn ghost" href="/admin/audit">清除</a></form>`;
  const tr = view.map(e => {
    const a = e.actor || {}, ac = e.action || {};
    const tk = a.token || null;
    const isAi = tk && String(tk.id || "").startsWith(AI_TOKEN);
    const inf = ipInfo(a.ip_address, uips, e.raw && e.raw.user_agent, tk && tk.id);
    const rd = resDesc(e);
    const who = tk ? `<b>${esc(tk.name || tname[tk.id] || "令牌")}</b> <span class="mono small muted">${esc(short(tk.id))}</span>${isAi ? " " + badge("red", "云端 AI 工具令牌") : ""}` : `<b>${esc(a.context === "dash" ? "网页控制台" : a.context || a.type || "—")}</b>`;
    const ok = /success/i.test(ac.result || "");
    const st = e.raw && e.raw.status_code;
    const typ = ac.type === "create" ? badge("grn", "新建") : ac.type === "delete" ? badge("red", "删除") : ac.type === "update" ? badge("blue", "修改") : ac.type ? badge("gray", ac.type) : "";
    const dash = a.context === "dash" && inf.k === "unknown";
    return `<tr class="${isAi || (inf.k === "unknown" && !dash) ? "hl" : dash ? "hy" : ""}"><td class="small">${esc(t8(ac.time))}</td><td>${who}<div class="small muted">${esc(a.email || "")}${e.raw && e.raw.user_agent ? " · " + esc(uaShort(e.raw.user_agent)) : ""}</div></td>
<td><span class="mono small">${esc(a.ip_address || "—")}</span> ${ipCo[a.ip_address] ? `<span class="small muted">${esc(ipCo[a.ip_address])}</span>` : ""}<div>${ipBadge(inf)}${dash ? badge("yel", "网页控制台，请确认是你本人") : ""}</div></td>
<td>${typ}${esc(ac.description || "")}</td><td><span class="small muted">${esc(rd.kindCn)}</span><div>${esc(rd.name)}</div>${rd.uri ? `<div class="mono small muted">${esc((e.raw && e.raw.method) || "")} ${esc(rd.uri)}</div>` : ""}</td>
<td>${ok ? badge("grn", "成功") : badge("red", ac.result || "失败")}${st ? `<span class="small muted">${esc(st)}</span>` : ""}</td></tr>`;
  }).join("");
  body += `<div class="tw"><table><thead><tr><th>时间（UTC+8）</th><th>操作者</th><th>来源 IP</th><th>动作</th><th>资源</th><th>结果</th></tr></thead><tbody>${tr || `<tr><td colspan="6" class="muted">没有符合条件的记录</td></tr>`}</tbody></table></div>`;
  const base = { w: w ? 1 : "", ext: ext ? 1 : "", tok };
  body += `<div class="pg">${cur > 1 ? `<a class="btn ghost" href="/admin/audit?${esc(qs(Object.assign({}, base, { p: cur - 1 })))}">上一页</a>` : ""}<span class="muted small">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>${cur < pages ? `<a class="btn ghost" href="/admin/audit?${esc(qs(Object.assign({}, base, { p: cur + 1 })))}">下一页</a>` : ""}</div>`;
  body += `<p class="small muted">已知来源：在下方「受信 IP」里维护；审计日志本身不带国家，国家栏只在该 IP 访问过工作台时显示。GitHub 巡检令牌只读，不产生审计记录。</p></div>`;
  return { title: "审计日志", active: "/admin/audit", body };
}
async function loginTab(env, uips, pg) {
  let r;
  try { r = await env.DB.prepare("SELECT t, type, ip, co, st, ua FROM (SELECT t, type, ip, co, st, ua FROM events WHERE type = 'auth' AND t > ?1 UNION ALL SELECT t, type, ip, co, 0 AS st, ua FROM admin_log WHERE t > ?1) ORDER BY t DESC LIMIT 500").bind(Date.now() - 30 * 86400000).all(); }
  catch (e) { return errCard("工作台登录记录", "D1 查询失败"); }
  const rows = r.results || [];
  const per = 50, pages = Math.max(1, Math.ceil(rows.length / per)), cur = Math.min(pg, pages);
  const nOk = rows.filter(x => x.type === "login").length, nFail = rows.filter(x => x.type === "auth").length;
  let body = `<p class="sub">工作台登录记录（最近 30 天，来自 D1）。登录成功和「复制订阅链接」从本次更新起开始记录；密码错误 / 锁定记录一直都有。</p>`;
  body += `<div class="kpis"><div class="kpi"><span class="muted small">登录成功</span><b>${nOk}</b></div><div class="kpi"><span class="muted small">密码错误 / 锁定</span><b>${nFail}</b></div><div class="kpi"><span class="muted small">不同 IP</span><b>${new Set(rows.map(x => x.ip)).size}</b></div></div>`;
  const tr = rows.slice((cur - 1) * per, cur * per).map(x => {
    const res = x.type === "login" ? badge("grn", "登录成功") : x.type === "admin_sub" ? badge("blue", "复制订阅链接") : Number(x.st) === 429 ? badge("red", "已锁定") : badge("yel", "密码错误");
    const inf = ipInfo(x.ip, uips, x.ua);
    return `<tr class="${x.type === "auth" ? "hy" : ""}"><td class="small">${esc(t8(Number(x.t)))}</td><td>${res}</td><td><span class="mono small">${esc(x.ip || "—")}</span><div>${ipBadge(inf)}</div></td><td>${esc(x.co || "—")}</td><td>${esc(uaShort(x.ua))}<div class="small muted">${esc(String(x.ua || "").slice(0, 120))}</div></td></tr>`;
  }).join("");
  body += `<div class="card"><div class="tw"><table><thead><tr><th>时间（UTC+8）</th><th>结果</th><th>IP</th><th>国家</th><th>设备</th></tr></thead><tbody>${tr || `<tr><td colspan="5" class="muted">暂无记录</td></tr>`}</tbody></table></div>`;
  body += `<div class="pg">${cur > 1 ? `<a class="btn ghost" href="/admin/audit?tab=login&amp;p=${cur - 1}">上一页</a>` : ""}<span class="muted small">第 ${cur} / ${pages} 页</span>${cur < pages ? `<a class="btn ghost" href="/admin/audit?tab=login&amp;p=${cur + 1}">下一页</a>` : ""}</div></div>`;
  return body;
}

// ---------- PAGE 4: proxy dashboard ----------
const GQL = `query($z:String!,$s:Time!,$e:Time!,$sub:String!,$ws:String!){viewer{zones(filter:{zoneTag:$z}){
 subDaily:httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$s,datetime_leq:$e,OR:[{clientRequestPath_like:$sub},{clientRequestPath:$ws,edgeResponseStatus_neq:101}]},orderBy:[datetimeHour_ASC]){count dimensions{datetimeHour}}
 subClients:httpRequestsAdaptiveGroups(limit:25,filter:{datetime_geq:$s,datetime_leq:$e,OR:[{clientRequestPath_like:$sub},{clientRequestPath:$ws,edgeResponseStatus_neq:101}]},orderBy:[count_DESC]){count dimensions{clientIP clientCountryName userAgent}}
 wsDaily:httpRequestsAdaptiveGroups(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e,clientRequestPath:$ws},orderBy:[datetimeHour_ASC]){count sum{edgeResponseBytes} dimensions{datetimeHour edgeResponseStatus}}
 wsIps:httpRequestsAdaptiveGroups(limit:30,filter:{datetime_geq:$s,datetime_leq:$e,clientRequestPath:$ws,edgeResponseStatus:101},orderBy:[count_DESC]){count sum{edgeResponseBytes} dimensions{clientIP clientCountryName}}
}}}`;
async function proxyStats(env, cfg) {
  const e = new Date(), s = new Date(Date.now() - 7 * 86400000);
  const iso = d => d.toISOString().slice(0, 19) + "Z";
  const r = await fetch(API + "/graphql", { method: "POST", signal: AbortSignal.timeout(9000), headers: { "authorization": "Bearer " + env.ADMIN_RO_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ query: GQL, variables: { z: ZONE, s: iso(s), e: iso(e), sub: "/" + cfg.path + "/sub%", ws: "/" + cfg.path } }) });
  const d = await r.json();
  if (d.errors && d.errors.length) throw new Error(d.errors.map(x => x.message).join("; ").slice(0, 200));
  return d.data.viewer.zones[0];
}
function parseNodes(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^(vless|trojan|vmess|ss|hysteria2?|tuic):\/\/[^@\s]*@(\[[^\]]+\]|[^:\/?#\s]+):(\d+)([^#\s]*)(?:#(.*))?$/i.exec(line.trim());
    if (!m) continue;
    let q = {}; try { q = Object.fromEntries(new URLSearchParams((m[4].split("?")[1]) || "")); } catch (e) {}
    let name = m[5] || ""; try { name = decodeURIComponent(name); } catch (e) {}
    out.push({ proto: m[1].toLowerCase(), host: m[2].replace(/^\[|\]$/g, ""), port: Number(m[3]), type: q.type || "", sec: q.security || "", sni: q.sni || "", name: name.slice(0, 60) });
  }
  return out.slice(0, 40);
}
function b64dec(t) { try { const bin = atob(String(t).replace(/\s+/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch (e) { return ""; } }
async function tcpProbe(host, port) {
  const t0 = Date.now(); let s;
  try {
    s = connect({ hostname: host, port: Number(port) || 443 });
    await Promise.race([s.opened, new Promise((_, rej) => setTimeout(() => rej(new Error("3 秒超时")), 3000))]);
    const ms = Date.now() - t0; try { s.close(); } catch (e) {}
    return { tcp: true, ms };
  } catch (e) { try { s && s.close(); } catch (x) {} return { tcp: false, ms: Date.now() - t0, err: String(e && e.message || e).slice(0, 120) }; }
}
async function wsProbe(env, cfg) {
  const t0 = Date.now();
  try {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const r = await env.CFNEXT.fetch(`https://${HOST}/${cfg.path}?ed=2048`, { headers: { "upgrade": "websocket", "connection": "Upgrade", "sec-websocket-key": key, "sec-websocket-version": "13", "user-agent": "admin-health-probe" } });
    const ms = Date.now() - t0;
    if (r.webSocket) { try { r.webSocket.accept(); r.webSocket.close(1000, "probe"); } catch (e) {} }
    return { status: r.status, ms, ok: r.status === 101 };
  } catch (e) { return { status: 0, ms: Date.now() - t0, ok: false, err: String(e && e.message || e).slice(0, 120) }; }
}
async function nodeHealth(env, cfg, force) {
  const now = Date.now();
  let cached = null;
  try { cached = await env.DB.prepare("SELECT t, v FROM admin_cache WHERE k='health'").first(); } catch (e) {}
  if (cached && (now - cached.t < (force ? 15000 : 60000))) { try { return Object.assign(JSON.parse(cached.v), { cached: true }); } catch (e) {} }
  const work = (async () => {
    const out = { at: now, nodes: [], e2e: null, err: "" };
    const e2eP = wsProbe(env, cfg);
    try {
      const r = await env.CFNEXT.fetch(`https://${HOST}/${cfg.path}/api/sub`, { headers: { "cookie": "luma_auth=" + md5hex(String(cfg.admin || "")), "user-agent": "Mozilla/5.0 (admin-health)" } });
      const j = await r.json();
      if (j && j.ok) { let t = String(j.body || ""); if (!/:\/\//.test(t)) t = b64dec(t); out.nodes = parseNodes(t); if (!out.nodes.length) out.err = "订阅里没有可解析的节点"; }
      else out.err = "订阅生成失败（HTTP " + r.status + "）";
    } catch (e) { out.err = "读取订阅失败"; }
    const tcp = await Promise.all(out.nodes.map(n => tcpProbe(n.host, n.port)));
    out.nodes = out.nodes.map((n, i) => Object.assign({}, n, tcp[i]));
    out.e2e = await e2eP;
    return out;
  })();
  let timer;
  const cap = new Promise(r => { timer = setTimeout(() => r({ at: now, nodes: [], e2e: null, err: "探测超过 10 秒，已中止（稍后刷新重试）", timeout: true }), 10000); });
  const out = await Promise.race([work, cap]); clearTimeout(timer);
  try { await env.DB.prepare("INSERT OR REPLACE INTO admin_cache (k, t, v) VALUES ('health', ?1, ?2)").bind(now, JSON.stringify(out)).run(); } catch (e) {}
  return out;
}
function hostPort(u) {
  u = String(u || "").trim(); if (!u) return "";
  const m = /^(?:[a-z0-9+.-]+:\/\/)?(?:[^@\/]*@)?(\[[^\]]+\]|[^:\/?#]+)(?::(\d+))?/i.exec(u);
  return m ? (u.match(/^([a-z0-9+.-]+):\/\//i) ? u.match(/^([a-z0-9+.-]+):\/\//i)[1] + "://" : "") + m[1] + (m[2] ? ":" + m[2] : "") : "";
}
function onoff(v) { return v ? badge("grn", "开") : badge("gray", "关"); }
async function pageProxy(env, cfg, url, request) {
  if (!cfg.path) return { title: "代理节点", active: "/admin/proxy", body: errCard("代理配置", "读不到 cfnext 的 KV 配置") };
  const force = url.searchParams.get("refresh") === "1";
  const [st, hl, uips] = await Promise.all([proxyStats(env, cfg).catch(e => ({ _err: String(e && e.message || e) })), nodeHealth(env, cfg, force), userIpSet(env)]);
  const masked = String(cfg.path).slice(0, 8) + "…";
  let body = `<p class="sub">代理面板（CFNext）的订阅拉取、代理流量、节点健康和当前配置。数据来自 Cloudflare 流量分析（最近 7 天，按北京时间 UTC+8 日期分组），UUID 只显示前 8 位。</p>`;
  body += `<div class="card"><h2>订阅链接</h2><p><span class="mono">https://${esc(HOST)}/${esc(masked)}/sub</span></p><button class="btn" id="cp" type="button">复制订阅链接</button> <span id="cpst" class="small muted"></span><div id="subbox"><input type="text" id="subin" readonly></div>
<p class="note mt">订阅内容每次请求实时生成（no-store），没有需要手动清的缓存。UUID 轮换见下方「UUID 轮换」卡片；配置回滚见 <a href="/admin/config-history">配置版本</a>。</p></div>`;
  body += await poolSection(env, request, url);
  body += await leakSection(env);
  body += await ipOptSection(env, request, url);
  body += await uuidRotateSection(env, request);
  if (st._err) body += errCard("流量统计", st._err);
  else {
    const days = {};
    const day = d => days[d] || (days[d] = { sub: 0, ws: 0, other: 0, bytes: 0 });
    const d8 = h => new Date(Date.parse(h) + 8 * 3600000).toISOString().slice(0, 10); // UTC+8 calendar date
    for (const x of st.subDaily || []) day(d8(x.dimensions.datetimeHour)).sub += x.count;
    let ws7 = 0, bytes7 = 0;
    for (const x of st.wsDaily || []) { const d = day(d8(x.dimensions.datetimeHour)); if (x.dimensions.edgeResponseStatus === 101) { d.ws += x.count; d.bytes += x.sum.edgeResponseBytes; ws7 += x.count; bytes7 += x.sum.edgeResponseBytes; } else if (x.dimensions.edgeResponseStatus !== 200) d.other += x.count; }
    const sub7 = (st.subDaily || []).reduce((n, x) => n + x.count, 0);
    const ipsN = (st.wsIps || []).length;
    const flagged = (st.wsIps || []).filter(x => ipInfo(x.dimensions.clientIP, uips).k === "unknown").length;
    body += `<div class="kpis"><div class="kpi"><span class="muted small">7 天订阅拉取</span><b>${sub7}</b></div><div class="kpi"><span class="muted small">7 天代理连接（101）</span><b>${ws7}</b></div><div class="kpi"><span class="muted small">7 天代理流量（下行）</span><b>${esc(bytes(bytes7))}</b></div><div class="kpi"><span class="muted small">代理客户端 IP</span><b>${ipsN}${ipsN >= 30 ? "+" : ""}</b></div><div class="kpi"><span class="muted small">陌生 / 机房 IP</span><b>${flagged}</b></div></div>`;
    const dk = Object.keys(days).sort().reverse();
    const maxWs = Math.max(1, ...dk.map(k => days[k].ws));
    body += `<div class="card"><h2>每日统计</h2><div class="tw"><table><thead><tr><th>日期（UTC+8）</th><th>订阅拉取</th><th>代理连接（101）</th><th></th><th>被拒 / 出错</th><th>流量</th></tr></thead><tbody>${dk.map(k => { const d = days[k]; const pct = Math.max(1, Math.round(d.ws / maxWs * 100)); return `<tr><td>${esc(k)}</td><td>${d.sub}</td><td>${d.ws}</td><td><progress max="100" value="${pct}"></progress></td><td>${d.other ? badge("yel", d.other) : "0"}</td><td>${esc(bytes(d.bytes))}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">7 天内无数据</td></tr>`}</tbody></table></div></div>`;
    body += `<div class="card"><h2>谁在拉订阅</h2><div class="tw"><table><thead><tr><th>IP</th><th>国家</th><th>客户端</th><th>次数</th></tr></thead><tbody>${(st.subClients || []).map(x => { const inf = ipInfo(x.dimensions.clientIP, uips, x.dimensions.userAgent); return `<tr class="${inf.k === "unknown" ? "hl" : ""}"><td><span class="mono small">${esc(x.dimensions.clientIP)}</span><div>${ipBadge(inf)}</div></td><td>${esc(x.dimensions.clientCountryName)}</td><td>${esc(uaShort(x.dimensions.userAgent))}<div class="small muted">${esc(String(x.dimensions.userAgent || "").slice(0, 110))}</div></td><td>${x.count}</td></tr>`; }).join("") || `<tr><td colspan="4" class="muted">无</td></tr>`}</tbody></table></div><p class="small muted">包括 /…/sub 和非浏览器直接请求 UUID 路径（部分客户端这样拉订阅）。</p></div>`;
    body += `<div class="card"><h2>代理连接来源（前 30）</h2><div class="tw"><table><thead><tr><th>IP</th><th>国家</th><th>连接数</th><th>流量</th></tr></thead><tbody>${(st.wsIps || []).map(x => { const inf = ipInfo(x.dimensions.clientIP, uips); return `<tr class="${inf.k === "unknown" ? "hl" : ""}"><td><span class="mono small">${esc(x.dimensions.clientIP)}</span><div>${ipBadge(inf)}</div></td><td>${esc(x.dimensions.clientCountryName)}</td><td>${x.count}</td><td>${esc(bytes(x.sum.edgeResponseBytes))}</td></tr>`; }).join("") || `<tr><td colspan="4" class="muted">7 天内无代理连接</td></tr>`}</tbody></table></div><p class="small muted">免费版流量分析不提供 ASN，「疑似 xx」是按云厂商公布的 IP 段推测的，拿不准时只写「云服务器」；GitHub Actions 机房 IP 标为「自家巡检」（灰色），不计入陌生。旧 UUID 曾泄露给几百个 VPS IP，如果这里出现大量红色机房 IP，说明新 UUID 也泄露了，请让 Grok Bot 轮换。</p></div>`;
  }
  // node health
  const e2e = hl.e2e;
  const blocked = (hl.nodes || []).filter(n => !n.tcp && /cloudflare|proxy request|not allowed|prohibited/i.test(n.err || "")).length;
  body += `<div class="card"><h2>节点健康</h2><p class="sub">${hl.cached ? "缓存结果（60 秒内）" : "刚刚探测"} · ${esc(t8(hl.at))} <a class="btn ghost" href="/admin/proxy?refresh=1">重新探测</a></p>`;
  if (hl.err) body += `<p class="note">${esc(hl.err)}</p>`;
  body += `<p>服务端 WebSocket 握手（UUID 路径，经内部服务绑定）：${e2e ? (e2e.ok ? badge("grn", "正常 101") : badge("red", "异常 " + (e2e.status || "无响应"))) + ` <span class="small muted">${e2e.ms} ms</span>` : badge("gray", "未完成")}</p>`;
  const nrows = (hl.nodes || []).map(n => `<tr><td>${esc(n.name)}</td><td>${badge("blue", n.proto)} <span class="small muted">${esc(n.type)}${n.sec ? " · " + esc(n.sec) : ""}</span></td><td class="mono small">${esc(n.host)}:${esc(n.port)}</td><td>${n.tcp ? badge("grn", "可连") : /cloudflare|proxy request|not allowed|prohibited/i.test(n.err || "") ? badge("gray", "Worker 不能直连 Cloudflare IP") : badge("red", "不通") + (n.err ? `<div class="small muted">${esc(n.err)}</div>` : "")}</td><td>${n.tcp ? esc(n.ms) + " ms" : "—"}</td></tr>`).join("");
  body += `<div class="tw"><table><thead><tr><th>节点</th><th>协议</th><th>地址</th><th>TCP 443</th><th>延迟</th></tr></thead><tbody>${nrows || `<tr><td colspan="5" class="muted">没有节点数据</td></tr>`}</tbody></table></div>`;
  body += `<p class="small muted">这些节点都是 Cloudflare 优选 IP，连到同一个 Worker。${blocked ? "Cloudflare 不允许 Worker 直连自家 IP，所以逐个节点的探测做不了；" : ""}上面的 WebSocket 握手测的是服务端本身，101 = 正常。各节点对你的实际延迟请用客户端（Hako 等）测速。</p></div>`;
  // config
  const hw = Array.isArray(cfg.homeWanNodes) ? cfg.homeWanNodes.length : 0;
  const pd = String(cfg.preferredDomains || "");
  const items = [
    ["VLESS", onoff(cfg.enableVless)], ["Trojan", onoff(cfg.enableTrojan)], ["xhttp（enableXhttp）", onoff(cfg.enableXhttp)],
    ["家宽节点（homeWan）", onoff(cfg.homeWan) + (hw ? ` <span class="small muted">${hw} 个</span>` : "")],
    ["轮询下发（polling）", onoff(cfg.polling)], ["节点数量限制", cfg.nodeLimit ? badge("blue", "最多 " + (cfg.nodeLimitCount || "?") + " 个") : badge("gray", "不限")],
    ["负载均衡", onoff(cfg.loadBalance)], ["存活探测", onoff(cfg.probeAlive)], ["配额自动调节", onoff(cfg.quotaAuto)], ["仅 TLS", onoff(cfg.tlsOnly)], ["ECH", onoff(cfg.ech)],
    ["IPv6", esc(cfg.ipv6Mode || "off")],
    ["出站代理", cfg.outboundProxy ? `<span class="mono small">${esc(hostPort(cfg.outboundProxy))}</span> <span class="small muted">模式 ${esc(cfg.outboundMode || "")}，账号密码已隐藏</span>` : badge("gray", "未设置")],
    ["ProxyIP", cfg.proxyIP ? `<span class="mono small">${esc(hostPort(cfg.proxyIP))}</span>` : badge("gray", "未设置")],
    ["优选 IP", esc((Array.isArray(cfg.preferredIPs) ? cfg.preferredIPs.length : 0) + " 条")], ["优选域名来源", pd ? `<span class="mono small">${esc(hostPort(pd.split(/[\s,]+/)[0]))}</span>` : badge("gray", "无")],
    ["本次订阅节点数", esc((hl.nodes || []).length + " 个")]
  ];
  body += `<div class="card"><h2>当前配置（只读）</h2><div class="tw"><table><tbody>${items.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table></div><p class="small muted">改配置请到「代理面板」。</p></div>`;
  const script = `(function(){var b=document.getElementById('cp'),s=document.getElementById('cpst');b.addEventListener('click',function(){s.textContent='获取中…';fetch('/admin/proxy/sub-url',{headers:{'x-admin-req':'1'},credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(!j||!j.ok)throw new Error((j&&j.error)||'失败');var done=function(){s.textContent='已复制到剪贴板'};var fail=function(){var box=document.getElementById('subbox'),i=document.getElementById('subin');i.value=j.url;box.className='show';i.focus();i.select();s.textContent='浏览器不允许自动复制，请手动复制下面的链接'};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(j.url).then(done,fail)}else fail()}).catch(function(e){s.textContent='获取失败：'+e.message})})})();`;
  return { title: "代理节点仪表盘", active: "/admin/proxy", body, script };
}
async function subUrl(request, env, ctx, cfg) {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  const sfs = request.headers.get("sec-fetch-site");
  if (request.headers.get("x-admin-req") !== "1" || (sfs && sfs !== "same-origin")) return new Response(JSON.stringify({ ok: false, error: "bad request" }), { status: 400, headers: h });
  if (!cfg.path) return new Response(JSON.stringify({ ok: false, error: "读不到配置" }), { status: 500, headers: h });
  const p = (async () => {
    const ip = request.headers.get("cf-connecting-ip") || "", ua = request.headers.get("user-agent") || "";
    try { await env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, 'admin_sub', ?2, ?3, ?4)").bind(Date.now(), ip, request.headers.get("x-client-co") || (request.cf && request.cf.country) || "", ua.slice(0, 120)).run(); } catch (e) {}
    // 2026-10: no email any more - logged to admin_log only and summarised in the daily report.
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return new Response(JSON.stringify({ ok: true, url: `https://${HOST}/${cfg.path}/sub` }), { headers: h });
}
const LA_FROM = "alert@panel.example.com", LA_TO = "<OWNER_EMAIL>";
function laB64(str) { const bytes = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
function buildMime(subject, lines) {
  const body = laB64(lines.join("\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return ["From: =?UTF-8?B?" + laB64("面板监控") + "?= <" + LA_FROM + ">", "To: <" + LA_TO + ">", "Subject: =?UTF-8?B?" + laB64(subject) + "?=",
    "Date: " + new Date().toUTCString().replace("GMT", "+0000"), "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
}
// MD5 (copied from CFNext) for its luma_auth token
const TE = new TextEncoder();
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];
function rotl32(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }
function md5hex(str) {
  const bytes = TE.encode(String(str));
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const sum = (a + f + MD5_K[j] + M[g]) >>> 0;
      const nb = (b + rotl32(sum, MD5_S[j])) >>> 0;
      a = d; d = c; c = b; b = nb;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let hex = '';
  for (const v of [a0, b0, c0, d0]) {
    hex += (v & 255).toString(16).padStart(2, '0');
    hex += ((v >>> 8) & 255).toString(16).padStart(2, '0');
    hex += ((v >>> 16) & 255).toString(16).padStart(2, '0');
    hex += ((v >>> 24) & 255).toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------- outbound pool (SOCKS5 / HTTP failover) on /admin/proxy ----------
// Writes (POST + CSRF, gate session enforced by portal): add standby, set active, enable/disable, delete, run check now.
// Passwords are never rendered: seeded entries live in Worker secret OUTBOUND_POOL_JSON (mirrored in GitHub Actions secrets),
// panel-added entries are stored in D1 only as AES-GCM ciphertext (key = Worker/Actions secret OUTBOUND_POOL_KEY).
// "Set active" rewrites ONLY config.outboundProxy in the cfnext KV config; the cfnext Worker itself is never redeployed.
const POOL_PROTOS = ["socks5", "http"];
function gateCookie(request) { const m = /(?:^|;\s*)gate=([0-9]+\.[0-9a-f]+)/.exec(request.headers.get("cookie") || ""); return m ? m[1] : ""; }
async function hmacHexA(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function csrfToken(request, env, scope) { const g = gateCookie(request); return g ? hmacHexA(env.CSRF_KEY || env.SVC_KEY, "csrf:" + (scope || "admin-proxy") + ":" + g) : ""; }
function csrfFail(request, msg) {
  const p = new URL(request.url).pathname;
  const back = p.startsWith("/admin/guests") ? "/admin/guests" : p.startsWith("/admin/config-history") ? "/admin/config-history" : p === "/admin/proxy/ip-opt-run" ? "/admin/proxy#ipopt" : "/admin/proxy";
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请刷新</title><body style="margin:0;min-height:100vh;background:#070b16;color:#e7ecf5;font-family:system-ui,-apple-system,'PingFang SC',sans-serif"><main style="max-width:520px;margin:auto;padding:12vh 20px"><p style="color:#ff9d9d;font-size:18px">${msg ? esc(msg) : "页面已过期或请求来源不对，操作没有执行。"}</p><p><a href="${back}" style="display:inline-block;padding:12px 18px;border-radius:11px;background:linear-gradient(135deg,#5b8cff,#7a5cff);color:#fff;text-decoration:none;font-weight:600">↻ 重新打开页面再试一次</a></p></main>`, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
}
async function csrfOk(request, env, given, scope) {
  const origin = request.headers.get("origin"), sfs = request.headers.get("sec-fetch-site");
  // "Origin: null" is what browsers send from no-referrer pages; the per-session token below is the real check.
  if (origin && origin !== "null" && origin !== "https://" + HOST) return false;
  if (sfs && sfs !== "same-origin") return false;
  const want = await csrfToken(request, env, scope);
  return !!want && !!given && await ctEq(given, want);
}
function pB64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function pUnB64(s) { const bin = atob(String(s)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function poolKeyA(env, usage) {
  if (!env.OUTBOUND_POOL_KEY) throw new Error("OUTBOUND_POOL_KEY 未配置");
  return crypto.subtle.importKey("raw", pUnB64(env.OUTBOUND_POOL_KEY), { name: "AES-GCM" }, false, [usage]);
}
async function encPass(env, id, pass) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("outbound:" + id) }, await poolKeyA(env, "encrypt"), new TextEncoder().encode(pass)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "v1:" + pB64(out);
}
function poolSecrets(env) { const m = {}; try { for (const x of JSON.parse(env.OUTBOUND_POOL_JSON || "[]")) if (x && x.id) m[String(x.id)] = x; } catch (e) {} return m; }
async function decPassA(env, row) {
  const sec = poolSecrets(env)[row.id];
  if (sec && typeof sec.pass === "string") return sec.pass;
  if (!row.pass_enc) return "";
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(row.pass_enc); if (!m) throw new Error("密文格式不对");
  const buf = pUnB64(m[1]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: new TextEncoder().encode("outbound:" + row.id) }, await poolKeyA(env, "decrypt"), buf.slice(12)));
}
function obHostPort(u) {
  const m = /^(?:[a-z0-9+.-]+:\/\/)?(?:[^@\/]*@)?(\[[^\]]+\]|[^:\/?#@]+)(?::(\d+))?/i.exec(String(u || "").trim());
  return m ? (m[1].replace(/^\[|\]$/g, "") + ":" + (m[2] || "1080")).toLowerCase() : "";
}
function obUrl(row, pass) {
  const proto = POOL_PROTOS.includes(row.protocol) ? row.protocol : "socks5";
  const auth = row.user ? encodeURIComponent(row.user) + (pass ? ":" + encodeURIComponent(pass) : "") + "@" : "";
  return proto + "://" + auth + (/:/.test(row.host) ? "[" + row.host + "]" : row.host) + ":" + row.port;
}
async function poolRows(env) { return (await env.DB.prepare("SELECT * FROM outbound_pool ORDER BY is_active DESC, created_at").all()).results || []; }
async function activateOutbound(env, row) {
  const pass = await decPassA(env, row);
  if (row.user && !pass) throw new Error("这个出口没有保存密码");
  if (!env.CFK) throw new Error("读不到 cfnext 配置");
  // read twice: only write if the config is stable (no concurrent writer), then verify every other key survived.
  const raw1 = await env.CFK.get("config");
  const cfg = raw1 ? JSON.parse(raw1) : null;
  if (!cfg || typeof cfg !== "object" || !cfg.uuid) throw new Error("读不到 cfnext 配置");
  const raw2 = await env.CFK.get("config");
  if (raw2 !== raw1) throw new Error("配置正在被其他程序修改，请稍后再试");
  const keys = Object.keys(cfg).sort().join(",");
  await cvSnapshot(env, raw1, "定时检测到变化");
  cfg.outboundProxy = obUrl(row, pass);
  const out = JSON.stringify(cfg);
  if (Object.keys(cfg).sort().join(",") !== keys && keys.split(",").includes("outboundProxy")) throw new Error("配置结构异常");
  await env.CFK.put("config", out);
  await cvSnapshot(env, out, "出站代理手动切换");
  const back = JSON.parse(await env.CFK.get("config"));
  if (obHostPort(back.outboundProxy) !== (row.host + ":" + row.port).toLowerCase() || back.uuid !== cfg.uuid) throw new Error("写入后校验不一致");
  // a manual switch makes this exit the new primary (the status cron switches back to the primary after it recovers)
  await env.DB.prepare("UPDATE outbound_pool SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END, is_primary = CASE WHEN id = ?1 THEN 1 ELSE 0 END, ok_streak = 0").bind(row.id).run();
}
// --- real end-to-end test from the Worker: SOCKS5 (RFC 1928/1929) or HTTP proxy -> http://api.ipify.org (exit IP) ---
function bufReader(sock) {
  const rd = sock.readable.getReader(); let buf = new Uint8Array(0);
  const pull = async () => { const { value, done } = await rd.read(); if (done) return false; const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb; return true; };
  return {
    async need(n) { while (buf.length < n) if (!(await pull())) throw new Error("代理提前断开连接"); const o = buf.slice(0, n); buf = buf.slice(n); return o; },
    async all(max) { while (buf.length < max && await pull()) {} const o = buf; buf = new Uint8Array(0); return o; }
  };
}
const SOCKS_REP = { 1: "代理服务器内部错误", 2: "规则不允许", 3: "网络不可达", 4: "主机不可达", 5: "目标拒绝连接", 6: "TTL 过期", 7: "不支持的命令", 8: "不支持的地址类型" };
// L2: never let the pool point the Worker at private / loopback / metadata ranges or mail/ssh-type ports.
const BAD_PORTS = new Set([0, 21, 22, 23, 25, 110, 111, 135, 137, 138, 139, 143, 445, 465, 587, 993, 995, 2049, 2375, 2376, 3306, 3389, 5432, 6379, 11211, 27017]);
function badTarget(host, port) {
  host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (BAD_PORTS.has(Number(port))) return true;
  if (host === "localhost" || /\.(local|localhost|internal|lan|home|arpa)$/.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some(x => Number(x) > 255)) return true;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (host.includes(":")) return host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(host) || /^::ffff:/.test(host) || /^64:ff9b:/.test(host);
  return false;
}
async function testOutbound(row, pass) {
  const t0 = Date.now(); let sock;
  if (badTarget(row.host, row.port)) return { ok: false, ms: 0, ip: "", err: "不允许的地址或端口（内网 / 本机 / 22、25 等）" };
  const work = (async () => {
    sock = connect({ hostname: row.host, port: Number(row.port) });
    await sock.opened;
    const w = sock.writable.getWriter(), r = bufReader(sock), te = new TextEncoder();
    const target = "api.ipify.org";
    if (row.protocol === "http") {
      const auth = row.user ? "Proxy-Authorization: Basic " + pB64(te.encode(row.user + ":" + pass)) + "\r\n" : "";
      await w.write(te.encode("GET http://" + target + "/ HTTP/1.1\r\nHost: " + target + "\r\n" + auth + "User-Agent: panel-outbound-check\r\nConnection: close\r\n\r\n"));
    } else {
      await w.write(new Uint8Array(row.user ? [5, 2, 0, 2] : [5, 1, 0]));
      const g = await r.need(2);
      if (g[0] !== 5) throw new Error("不是 SOCKS5 服务");
      if (g[1] === 2) {
        const u = te.encode(row.user || ""), p = te.encode(pass || "");
        await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
        const a = await r.need(2); if (a[1] !== 0) throw new Error("SOCKS5 用户名或密码错误");
      } else if (g[1] !== 0) throw new Error("SOCKS5 不接受认证方式");
      const h = te.encode(target);
      await w.write(new Uint8Array([5, 1, 0, 3, h.length, ...h, 0, 80]));
      const rep = await r.need(4);
      if (rep[1] !== 0) throw new Error("SOCKS5 连接目标失败：" + (SOCKS_REP[rep[1]] || rep[1]));
      const at = rep[3]; await r.need(at === 1 ? 6 : at === 4 ? 18 : (await r.need(1))[0] + 2);
      await w.write(te.encode("GET / HTTP/1.1\r\nHost: " + target + "\r\nUser-Agent: panel-outbound-check\r\nConnection: close\r\n\r\n"));
    }
    const txt = new TextDecoder().decode(await r.all(4096));
    const st = /^HTTP\/1\.[01] (\d{3})/.exec(txt);
    if (!st) throw new Error("没有收到 HTTP 响应");
    if (st[1] === "407") throw new Error("HTTP 代理认证失败（407）");
    if (st[1] !== "200") throw new Error("出口返回 HTTP " + st[1]);
    const ip = (/\r\n\r\n([0-9a-fA-F:.]{3,45})\s*$/.exec(txt) || [])[1] || "";
    return { ok: true, ms: Date.now() - t0, ip };
  })();
  let timer;
  try {
    return await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("10 秒超时")), 10000); })]);
  } catch (e) { return { ok: false, ms: Date.now() - t0, ip: "", err: String(e && e.message || e).slice(0, 140) }; }
  finally { clearTimeout(timer); try { sock && sock.close(); } catch (e) {} }
}
async function poolPost(request, env, ctx, url, p) {
  const back = (m, anchor) => new Response(null, { status: 303, headers: { "location": "/admin/proxy?m=" + encodeURIComponent(m) + "#" + (anchor || "pool"), "cache-control": "no-store" } });
  let form; try { form = await request.formData(); } catch (e) { return back("err_form"); }
  if (!(await csrfOk(request, env, String(form.get("csrf") || "")))) return csrfFail(request);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const audit = (what) => env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, ?2, ?3, ?4, ?5)").bind(Date.now(), "admin_pool", ip, request.headers.get("x-client-co") || "", String(what).slice(0, 120)).run().catch(() => {});
  if (p === "/admin/proxy/ip-opt-run") return ipOptRun(request, env, back);
  const rows = await poolRows(env);
  const byId = id => rows.find(x => x.id === String(id || ""));
  if (p === "/admin/proxy/pool/add") {
    const host = String(form.get("host") || "").trim().replace(/^\[|\]$/g, ""), port = parseInt(String(form.get("port") || ""), 10);
    const user = String(form.get("user") || ""), pass = String(form.get("password") || ""), protocol = String(form.get("protocol") || "socks5");
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]{2,45}$/i.test(host)) return back("err_host");
    if (!(port >= 1 && port <= 65535)) return back("err_port");
    if (badTarget(host, port)) return back("err_target");
    if (!POOL_PROTOS.includes(protocol)) return back("err_proto");
    if (user.length > 255 || pass.length > 255 || /[\r\n]/.test(user + pass)) return back("err_cred");
    if (rows.length >= 10) return back("err_full");
    if (rows.some(x => (x.host + ":" + x.port).toLowerCase() === (host + ":" + port).toLowerCase())) return back("err_dup");
    const id = "ob-" + [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, "0")).join("");
    const pe = pass ? await encPass(env, id, pass) : null;
    await env.DB.prepare("INSERT INTO outbound_pool (id, host, port, user, protocol, enabled, is_active, pass_enc, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6, 'panel', ?7)").bind(id, host, port, user, protocol, pe, Date.now()).run();
    await audit("add " + id + " " + host + ":" + port);
    // immediate test of the new entry so the user sees whether it works
    const r = await testOutbound({ host, port, user, protocol }, pass);
    await env.DB.prepare("UPDATE outbound_pool SET last_check_at = ?2, last_ok_at = CASE WHEN ?3 = 1 THEN ?2 ELSE last_ok_at END, last_fail_at = CASE WHEN ?3 = 1 THEN last_fail_at ELSE ?2 END, last_ms = ?4, last_ip = ?5, last_err = ?6 WHERE id = ?1").bind(id, Date.now(), r.ok ? 1 : 0, r.ms, r.ip || "", r.ok ? "" : r.err || "").run();
    return back(r.ok ? "added_ok" : "added_fail");
  }
  if (p === "/admin/proxy/pool/activate") {
    const row = byId(form.get("id")); if (!row) return back("err_id");
    if (row.is_active) return back("already");
    if (!row.enabled) return back("err_disabled");
    const prev = rows.find(x => x.is_active);
    try { await activateOutbound(env, row); } catch (e) { return back("err_activate"); }
    await env.DB.prepare("INSERT INTO proxy_failover_log (t, kind, from_id, to_id, reason, ok, source) VALUES (?1, 'manual', ?2, ?3, '工作台手动切换', 1, 'admin-panel')").bind(Date.now(), prev ? prev.id : "", row.id).run();
    await audit("activate " + row.id);
    // 2026-10: no email for manual switches (logged in proxy_failover_log + admin_log; listed in the daily report).
    return back("activated");
  }
  if (p === "/admin/proxy/pool/toggle") {
    const row = byId(form.get("id")); if (!row) return back("err_id");
    if (row.is_active && row.enabled) return back("err_active");
    await env.DB.prepare("UPDATE outbound_pool SET enabled = ?2 WHERE id = ?1").bind(row.id, row.enabled ? 0 : 1).run();
    await audit((row.enabled ? "disable " : "enable ") + row.id);
    return back("toggled");
  }
  if (p === "/admin/proxy/pool/delete") {
    const row = byId(form.get("id")); if (!row) return back("err_id");
    if (row.is_active) return back("err_active");
    await env.DB.prepare("DELETE FROM outbound_pool WHERE id = ?1 AND is_active = 0").bind(row.id).run();
    await audit("delete " + row.id);
    return back("deleted");
  }
  if (p === "/admin/proxy/uuid-rotate") {
    return csrfFail(request, "UUID 一键轮换未通过安全验证，已禁用。需要轮换请找 Grok Bot。");
  }
  if (p === "/admin/proxy/check") {
    const list = rows.filter(x => x.enabled);
    const res = await Promise.all(list.map(async x => { let pass = ""; try { pass = await decPassA(env, x); } catch (e) { return { ok: false, ms: 0, ip: "", err: "解不开密码" }; } return testOutbound(x, pass); }));
    const now = Date.now();
    if (list.length) await env.DB.batch(list.map((x, i) => env.DB.prepare("UPDATE outbound_pool SET last_check_at = ?2, last_ok_at = CASE WHEN ?3 = 1 THEN ?2 ELSE last_ok_at END, last_fail_at = CASE WHEN ?3 = 1 THEN last_fail_at ELSE ?2 END, last_ms = ?4, last_ip = ?5, last_err = ?6 WHERE id = ?1").bind(x.id, now, res[i].ok ? 1 : 0, res[i].ms, res[i].ip || "", res[i].ok ? "" : res[i].err || "")));
    try { await env.DB.prepare("INSERT OR REPLACE INTO admin_cache (k, t, v) VALUES ('poolcheck', ?1, ?2)").bind(now, JSON.stringify(list.map((x, i) => Object.assign({ id: x.id }, res[i])))).run(); } catch (e) {}
    try { const cfg = await loadCfg(env); await nodeHealth(env, cfg, true); } catch (e) {}
    await audit("check");
    return back("checked");
  }
  return new Response("not found", { status: 404 });
}
const POOL_MSG = {
  added_ok: ["grn", "已添加备用出口，测试通过。"], added_fail: ["yel", "已添加备用出口，但这次测试没通过，请检查地址 / 账号密码。它不会被自动切换过去，直到检查通过。"],
  activated: ["grn", "已切换出站代理，cfnext 大约 1 分钟内生效。"], already: ["gray", "它已经是当前出口。"], toggled: ["grn", "已更新。"], deleted: ["grn", "已删除。"],
  checked: ["grn", "检查完成（由 Worker 直接经出口访问 api.ipify.org），结果见下表。"],
  err_host: ["red", "地址格式不对（填 IP 或域名）。"], err_port: ["red", "端口要在 1–65535 之间。"], err_target: ["red", "不允许内网 / 本机地址，也不允许 22、25 等端口。"], err_proto: ["red", "协议只支持 socks5 / http。"], err_cred: ["red", "用户名或密码太长 / 含换行。"],
  err_full: ["red", "出口池最多 10 个。"], err_dup: ["red", "这个地址:端口已经在出口池里了。"], err_id: ["red", "找不到这个出口。"], err_disabled: ["red", "已停用的出口不能设为当前，先启用。"],
  err_active: ["red", "当前正在使用的出口不能停用或删除，先切换到别的出口。"], err_activate: ["red", "切换失败，cfnext 配置没有改动。"], err_form: ["red", "表单读取失败。"]
};
async function poolSection(env, request, url) {
  let rows = [], health = null, flog = [], pc = null;
  try {
    const [a, b, c, d] = await env.DB.batch([
      env.DB.prepare("SELECT id, host, port, user, protocol, enabled, is_active, last_ok_at, last_fail_at, last_ms, last_ip, last_err, last_check_at, source, (pass_enc IS NOT NULL) AS has_enc FROM outbound_pool ORDER BY is_active DESC, created_at"),
      env.DB.prepare("SELECT run_at, t, conclusion, sub_ok, node_count, run_url, simulated, action FROM proxy_health WHERE id = 1"),
      env.DB.prepare("SELECT t, kind, from_id, to_id, reason, ok, source FROM proxy_failover_log ORDER BY t DESC LIMIT 8"),
      env.DB.prepare("SELECT t FROM admin_cache WHERE k = 'poolcheck'")
    ]);
    rows = a.results || []; health = (b.results || [])[0] || null; flog = c.results || []; pc = (d.results || [])[0] || null;
  } catch (e) { return errCard("出站代理池", "D1 读取失败"); }
  const csrf = await csrfToken(request, env);
  const sec = poolSecrets(env);
  const cfg = await loadCfg(env);
  const liveHP = obHostPort(cfg.outboundProxy);
  const act = rows.find(x => x.is_active);
  const lbl = id => { const x = rows.find(r => r.id === id); return x ? x.host + ":" + x.port : (id || "—"); };
  const m = POOL_MSG[url.searchParams.get("m") || ""];
  const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const st = x => !x.last_check_at ? badge("gray", "未检查") : (x.last_fail_at || 0) >= x.last_check_at ? badge("red", "不通") : badge("grn", "正常");
  let body = `<div class="card" id="pool"><h2>出站代理池 · 自动切换</h2>`;
  if (m) body += `<p class="note ${m[0] === "red" ? "nerr" : m[0] === "yel" ? "" : "nok"}">${esc(m[1])}</p>`;
  const lf = flog[0];
  body += `<div class="kpis"><div class="kpi"><span class="muted small">当前出口</span><b class="mono kb">${esc(liveHP || "未设置")}</b>${act ? st(act) : badge("yel", "不在出口池里")}</div>
<div class="kpi"><span class="muted small">上次自动检查（GitHub Actions）</span><b class="kb">${health ? esc(ago(health.t) || "刚刚") : "还没有"}</b><span class="small muted">${health ? esc(t8(health.t)) + (health.simulated ? " · 模拟测试" : "") : "每小时一次"}</span></div>
<div class="kpi"><span class="muted small">备用出口</span><b>${rows.filter(x => !x.is_active && x.enabled).length}</b>${rows.filter(x => !x.is_active && x.enabled).length ? "" : badge("yel", "没有备用，无法自动切换")}</div>
<div class="kpi"><span class="muted small">上次切换</span><b class="kb">${lf ? esc(ago(lf.t) || "刚刚") : "从未"}</b><span class="small muted">${lf ? esc(lf.kind === "manual" ? "手动 " + lbl(lf.from_id) + " → " + lbl(lf.to_id) : lf.kind === "failover" ? "自动 " + lbl(lf.from_id) + " → " + lbl(lf.to_id) + (lf.ok ? "" : "（失败）") : /no_standby/.test(lf.kind) ? "当前出口不通但无备用" + (/^test_/.test(lf.kind) ? "（模拟测试）" : "") : lf.kind) : ""}</span></div></div>`;
  const tr = rows.map(x => {
    const ops = [];
    if (!x.is_active && x.enabled) ops.push(`<form method="post" action="/admin/proxy/pool/activate" class="inl">${hid}<input type="hidden" name="id" value="${esc(x.id)}"><button class="btn" type="submit">设为当前出口</button></form>`);
    if (!x.is_active) ops.push(`<form method="post" action="/admin/proxy/pool/toggle" class="inl">${hid}<input type="hidden" name="id" value="${esc(x.id)}"><button class="btn ghost" type="submit">${x.enabled ? "停用" : "启用"}</button></form>`);
    if (!x.is_active) ops.push(`<form method="post" action="/admin/proxy/pool/delete" class="inl">${hid}<input type="hidden" name="id" value="${esc(x.id)}"><button class="btn ghost" type="submit">删除</button></form>`);
    const pw = sec[x.id] ? "已保存（加密变量）" : x.has_enc ? "已保存（加密存储）" : x.user ? "缺失" : "无需";
    return `<tr class="${x.is_active && (x.last_fail_at || 0) >= (x.last_check_at || 1) ? "hl" : ""}"><td>${x.is_active ? badge("blue", "当前") : x.enabled ? badge("grn", "备用") : badge("gray", "停用")}<div class="small muted mono">${esc(x.id)}</div></td>
<td class="mono">${esc(x.protocol)}://${esc(x.host)}:${esc(x.port)}</td><td class="small">${x.user ? esc(String(x.user).slice(0, 3)) + "…" : "—"}<div class="muted">密码：${esc(pw)}</div></td>
<td>${st(x)}<div class="small muted">${x.last_check_at ? esc(t8(x.last_check_at)) : ""}</div>${x.last_err && (x.last_fail_at || 0) >= (x.last_check_at || 1) ? `<div class="small errt">${esc(x.last_err)}</div>` : ""}</td>
<td class="small">${x.last_ms ? esc(x.last_ms) + " ms" : "—"}<div class="muted mono">${esc(x.last_ip || "")}</div></td><td class="small">${x.last_ok_at ? esc(t8(x.last_ok_at)) : "—"}</td><td>${ops.join(" ")}</td></tr>`;
  }).join("");
  body += `<div class="tw"><table><thead><tr><th>状态</th><th>出口</th><th>账号</th><th>最近检查</th><th>延迟 / 出口 IP</th><th>上次正常</th><th>操作</th></tr></thead><tbody>${tr || `<tr><td colspan="7" class="muted">出口池是空的</td></tr>`}</tbody></table></div>`;
  body += `<form class="f mt" method="post" action="/admin/proxy/check">${hid}<button class="btn" type="submit">立即检查</button><span class="small muted">由 Worker 直接经每个出口访问 api.ipify.org，约 10 秒内出结果${pc ? "（上次手动检查 " + esc(ago(pc.t) || "刚刚") + "）" : ""}。</span></form>`;
  body += `<h2 class="mt2">添加备用出口</h2><form class="f" method="post" action="/admin/proxy/pool/add" autocomplete="off">${hid}
<select name="protocol"><option value="socks5">socks5</option><option value="http">http</option></select>
<input type="text" name="host" placeholder="IP 或域名" required maxlength="253" class="wh"><input type="text" name="port" placeholder="端口" required inputmode="numeric" maxlength="5" class="wp">
<input type="text" name="user" placeholder="用户名（可空）" maxlength="255" autocomplete="off"><input type="password" name="password" placeholder="密码（可空）" maxlength="255" autocomplete="new-password">
<button class="btn" type="submit">添加并测试</button></form>
<p class="small muted">密码只加密保存在服务器端（D1 里是 AES-GCM 密文，密钥在 Worker / GitHub 的加密变量里），页面上永远不显示。新加的出口默认是「备用」，不会改动当前出口。</p>`;
  body += `<p class="note">怎么自动切换：GitHub Actions 每小时用 curl 经每个出口访问 api.ipify.org。如果<b>当前出口不通</b>、而某个<b>启用的备用出口是通的</b>，就自动把 cfnext 的出站代理改成延迟最低的那个，并发邮件告诉你；如果没有能用的备用，只发邮件提醒，不改配置。cfnext Worker 本身不会被重新部署，只改 KV 配置里的 outboundProxy 一项。</p>`;
  if (flog.length) body += `<h2 class="mt2">切换记录</h2><div class="tw"><table><thead><tr><th>时间（UTC+8）</th><th>类型</th><th>从</th><th>到</th><th>说明</th></tr></thead><tbody>${flog.map(f => `<tr><td class="small">${esc(t8(f.t))}</td><td>${f.kind === "manual" ? badge("blue", "手动") : f.kind === "failover" ? badge(f.ok ? "grn" : "red", f.ok ? "自动切换" : "自动切换失败") : /no_standby/.test(f.kind) ? badge("yel", "无备用") : badge("gray", f.kind)}${/^test_/.test(f.kind) ? badge("gray", "模拟测试") : ""}</td><td class="mono small">${esc(lbl(f.from_id))}</td><td class="mono small">${esc(f.to_id ? lbl(f.to_id) : "—")}</td><td class="small">${esc(f.reason || "")}</td></tr>`).join("")}</tbody></table></div>`;
  body += `</div>`;
  return body;
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

// ======================= /admin/config-history · CFNext 配置版本 =======================
const CV_SRC = { "定时检测到变化": "定时检测", "出站代理自动切换": "出站自动切换", "出站代理手动切换": "出站手动切换", "一键回滚": "一键回滚", "UUID 轮换": "UUID 轮换", "面板保存": "面板保存" };
const CV_SENS = new Set(["admin", "uuid", "path", "trojanPassword", "outboundProxy", "cfApiToken", "proxyIP", "subUrl"]);
const CV_LABEL = { admin: "管理密码", uuid: "UUID", path: "面板路径", trojanPassword: "Trojan 密码", outboundProxy: "出站代理", cfApiToken: "CF API 令牌", cfAccountId: "CF 账号 ID",
  proxyIP: "ProxyIP", preferredIPs: "优选 IP", preferredDomains: "优选域名", homeWanNodes: "家宽节点", enableVless: "VLESS", enableTrojan: "Trojan", enableXhttp: "xhttp",
  outboundMode: "出站模式", host: "域名", tlsOnly: "仅 TLS", ech: "ECH", ipv6Mode: "IPv6", nodeLimit: "节点数量限制", nodeLimitCount: "节点上限", loadBalance: "负载均衡",
  probeAlive: "存活探测", quotaAuto: "配额调节", polling: "轮询下发", homeWan: "家宽", optimizer: "优选器", alpn: "ALPN", filter: "过滤", src: "源", echDns: "ECH DNS", echHost: "ECH Host", adminInit: "已初始化" };
function cvField(k) { return CV_LABEL[k] || k; }
function cvMaskVal(k, v) {
  if (v == null) return "（无）";
  if (CV_SENS.has(k)) {
    if (k === "outboundProxy") return hostPort(v) || "（已设置）";
    const s = String(v); return s ? s.slice(0, 4) + "…" + "（" + s.length + " 字符）" : "（空）";
  }
  if (Array.isArray(v)) return "[" + v.length + " 项]";
  if (typeof v === "object") return "{…}";
  if (typeof v === "boolean") return v ? "开" : "关";
  return String(v).slice(0, 120);
}
async function pageConfigHistory(env, cfg, url, request) {
  if (!env.CONFIG_KEY) return { title: "配置版本", active: "/admin/config-history", body: errCard("配置版本", "服务端还没配置 CONFIG_KEY，无法解密历史版本。") };
  const id = parseInt(url.searchParams.get("id") || "0", 10);
  const csrf = await csrfToken(request, env, "admin-config");
  const m = { rolled: ["grn", "已回滚到所选版本，cfnext 大约 30 秒内生效。"], err_id: ["red", "找不到这个版本。"], err_dec: ["red", "解不开这个版本（密钥可能被轮换过）。"], err_write: ["red", "回滚写入失败，当前配置没动。"], err_csrf: ["red", "页面已过期，请刷新后重试。"] }[url.searchParams.get("m") || ""];
  let body = `<p class="sub">CFNext KV 配置的加密历史版本（每 5 分钟检测变化时自动保存，出站切换 / 回滚也会立刻存一份）。最多保留最近 50 个。敏感字段只显示字段名和掩码，密钥值从不渲染。</p>`;
  if (m) body += `<p class="note ${m[0] === "red" ? "nerr" : "nok"}">${esc(m[1])}</p>`;
  if (id) {
    const row = await env.DB.prepare("SELECT id, t, source, fields, enc FROM cfnext_config_versions WHERE id = ?1").bind(id).first();
    if (!row) return { title: "配置版本", active: "/admin/config-history", body: errCard("配置版本", "找不到 #" + id) };
    let cur = {}, old = {};
    try { cur = cfg || {}; } catch (e) {}
    try { old = JSON.parse(await cvDec(env, row.enc)); } catch (e) { return { title: "配置版本", active: "/admin/config-history", body: errCard("配置版本", "解不开这个版本") }; }
    const keys = [...new Set([...Object.keys(cur), ...Object.keys(old)])].sort();
    const rows = keys.map(k => {
      const a = JSON.stringify(old[k]), b = JSON.stringify(cur[k]), ch = a !== b;
      return `<tr class="${ch ? "hy" : ""}"><th>${esc(cvField(k))}<div class="small muted mono">${esc(k)}</div></th><td>${esc(cvMaskVal(k, old[k]))}</td><td>${esc(cvMaskVal(k, cur[k]))}${ch ? " " + badge("yel", "有变化") : ""}</td></tr>`;
    }).join("");
    body += `<div class="card"><h2>版本 #${esc(row.id)} · ${esc(t8(row.t))}（UTC+8）</h2><p class="sub">${esc(CV_SRC[row.source] || row.source || "未知")} · 当时变化字段：${esc((JSON.parse(row.fields || "[]") || []).map(cvField).join("、") || "—")}</p>
<div class="tw"><table><thead><tr><th>字段</th><th>这个版本</th><th>当前</th></tr></thead><tbody>${rows}</tbody></table></div>
<form method="post" action="/admin/config-history/rollback" onsubmit="return confirm('确认回滚到版本 #${esc(row.id)}？\\n当前配置会先再存一份快照，然后用这个版本覆盖。敏感字段（密码 / UUID / 出站代理）也会一起恢复。')"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(row.id)}"><input type="hidden" name="confirm" value="确认回滚"><button class="btn" type="submit">回滚到此版本</button> <a class="btn ghost" href="/admin/config-history">← 返回列表</a></form></div>`;
    return { title: "配置版本 #" + row.id, active: "/admin/config-history", body };
  }
  const list = (await env.DB.prepare("SELECT id, t, source, fields, hash FROM cfnext_config_versions ORDER BY id DESC LIMIT 50").all()).results || [];
  const liveHash = cfg && env.CONFIG_KEY ? await cvHash(env, JSON.stringify(cfg)).catch(() => "") : "";
  // Note: live hash uses JSON.stringify(cfg) which may differ from the exact KV string order; mark "当前" by the newest id matching is approximate.
  const tr = list.map((x, i) => {
    const fields = (() => { try { return JSON.parse(x.fields || "[]"); } catch (e) { return []; } })();
    return `<tr><td class="mono">#${esc(x.id)}${i === 0 ? " " + badge("blue", "最新") : ""}</td><td class="small">${esc(t8(x.t))}</td><td>${esc(CV_SRC[x.source] || x.source || "未知")}</td>
<td class="small">${fields.length ? fields.map(f => badge("gray", cvField(f))).join(" ") : "—"}</td>
<td><a class="btn ghost" href="/admin/config-history?id=${esc(x.id)}">查看 / 回滚</a></td></tr>`;
  }).join("");
  body += `<div class="card"><h2>最近 50 个版本</h2><div class="tw"><table><thead><tr><th>版本</th><th>时间（UTC+8）</th><th>来源</th><th>变化字段</th><th></th></tr></thead><tbody>${tr || `<tr><td colspan="5" class="muted">还没有版本。状态面板每 5 分钟巡检时会自动存第一次。</td></tr>`}</tbody></table></div>
<p class="small muted">哈希前缀（最新）：${esc((list[0] && list[0].hash || "").slice(0, 12))}… · 当前配置哈希：${esc((liveHash || "").slice(0, 12))}…</p></div>`;
  return { title: "CFNext 配置版本", active: "/admin/config-history", body };
}
async function configHistoryPost(request, env, ctx, p) {
  const back = m => new Response(null, { status: 303, headers: { "location": "/admin/config-history?m=" + encodeURIComponent(m), "cache-control": "no-store" } });
  let form; try { form = await request.formData(); } catch (e) { return back("err_csrf"); }
  if (!(await csrfOk(request, env, String(form.get("csrf") || ""), "admin-config"))) return csrfFail(request);
  if (p !== "/admin/config-history/rollback") return new Response("not found", { status: 404 });
  if (String(form.get("confirm") || "") !== "确认回滚") return back("err_csrf");
  const id = parseInt(String(form.get("id") || ""), 10);
  const row = await env.DB.prepare("SELECT id, enc FROM cfnext_config_versions WHERE id = ?1").bind(id).first();
  if (!row) return back("err_id");
  let raw; try { raw = await cvDec(env, row.enc); JSON.parse(raw); } catch (e) { return back("err_dec"); }
  try {
    const cur = await env.CFK.get("config");
    if (cur) await cvSnapshot(env, cur, "一键回滚");
    await env.CFK.put("config", raw);
    const back2 = await env.CFK.get("config");
    if (back2 !== raw) throw new Error("verify failed");
    await cvSnapshot(env, raw, "一键回滚");
    await env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, 'admin_cfg_rollback', ?2, ?3, ?4)").bind(Date.now(), request.headers.get("cf-connecting-ip") || "", request.headers.get("x-client-co") || "", ("#" + id).slice(0, 120)).run();
    return back("rolled");
  } catch (e) { console.log("rollback failed: " + String(e && e.message || e)); return back("err_write"); }
}

// ======================= 泄露检测卡片 + UUID 轮换（按钮默认禁用） =======================
async function leakSection(env) {
  let st = null;
  try { st = await env.DB.prepare("SELECT t, status, reasons, data, incident_at, mailed_at, err FROM leak_state WHERE id = 1").first(); } catch (e) { return errCard("泄露检测", "D1 读取失败"); }
  if (!st) return `<div class="card" id="leak"><h2>泄露检测</h2><p class="muted">还没有结果。状态面板每小时自动扫一次；第一次大约要等 1 小时。</p></div>`;
  let reasons = [], data = {}; try { reasons = JSON.parse(st.reasons || "[]"); data = JSON.parse(st.data || "{}"); } catch (e) {}
  const h24 = data.h24 || {}, top = h24.top || [];
  const status = st.status === "leak" ? badge("red", "可能泄露") : st.status === "err" ? badge("yel", "检测失败") : badge("grn", "正常");
  let body = `<div class="card" id="leak"><h2>泄露检测 ${status}</h2><p class="sub">上次检测 ${esc(ago(st.t) || "刚刚")} · ${esc(t8(st.t))}（UTC+8）${st.incident_at ? " · 本次异常开始于 " + esc(t8(st.incident_at)) : ""}</p>`;
  if (st.err) body += `<p class="note nerr">${esc(st.err)}</p>`;
  if (reasons.length) body += `<p class="note nerr">${reasons.map(r => esc(r)).join("<br>")}</p>`;
  body += `<div class="kpis"><div class="kpi"><span class="muted small">24 小时陌生网络</span><b>${esc(h24.other || 0)}</b><span class="small muted">阈值 &gt; 8</span></div>
<div class="kpi"><span class="muted small">其中机房 / 云</span><b>${esc(h24.dc || 0)}</b><span class="small muted">阈值 ≥ 3</span></div>
<div class="kpi"><span class="muted small">你自己的网络</span><b>${esc(h24.self || 0)}</b></div>
<div class="kpi"><span class="muted small">24 小时流量</span><b>${esc(bytes(h24.bytes || 0))}</b></div>
<div class="kpi"><span class="muted small">最近 1 小时流量</span><b>${esc(bytes((data.h1 || {}).bytes || 0))}</b><span class="small muted">中位数 ${esc(bytes(data.median || 0))}</span></div></div>`;
  if (top.length) body += `<div class="tw"><table><thead><tr><th>陌生 IP / 网络</th><th>国家</th><th>次数</th><th>流量</th><th>标签</th></tr></thead><tbody>${top.map(x => `<tr class="hl"><td class="mono small">${esc(x.ip)}${x.net !== x.ip ? `<div class="muted">${esc(x.net)}</div>` : ""}</td><td>${esc(x.co || "?")}</td><td>${esc(x.n)}</td><td>${esc(bytes(x.b))}</td><td>${badge("red", x.label)}</td></tr>`).join("")}</tbody></table></div>`;
  body += `<p class="small muted">判定规则：24 小时陌生网络 &gt; 8 个，或陌生机房 IP ≥ 3 个，或最近 1 小时流量 &gt; 7 天每小时中位数的 5 倍且 ≥ 50 MB。自家（登录过工作台 / 出口池 / GitHub 巡检 / 白名单）不计入。同一次泄露每 6 小时最多提醒 1 封邮件。</p></div>`;
  return body;
}
async function uuidRotateSection(env, request) {
  // Proven-safe path on a throwaway worker was NOT found: uploading the live cfnext body to a new workers.dev name immediately
  // triggers Cloudflare error 1101 ("This Worker threw an exception" / "script has been killed") even for a 1-line hello
  // Worker under that same name. Live cfnext must not be redeployed; PATCH of plain_text U alone would also leave KV
  // config.uuid / config.path as the old value (KV overrides env.U). So the button stays disabled.
  const csrf = await csrfToken(request, env, "admin-proxy");
  return `<div class="card" id="uuidrot"><h2>UUID 轮换</h2><p class="note">按钮已禁用：在抛开的测试 Worker 上验证「只改绑定 / 只改 KV、不重新上传代码」时，新部署的测试副本一上传就被 Cloudflare 平台以 1101（Worker threw exception / script has been killed）杀掉，连 1 行 hello 都活不下来——跟上次把线上 cfnext 搞崩是同一种现象。线上 cfnext 不能重部署，只改 env.U 也不够（KV 里的 uuid/path 会覆盖它）。<b>UUID 轮换请找 Grok Bot</b>。</p>
<form method="post" action="/admin/proxy/uuid-rotate"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="confirm" value="确认轮换"><button class="btn" type="submit" disabled title="未通过安全验证，已禁用">轮换 UUID（已禁用）</button></form>
<p class="small muted">轮换成功后会：存配置版本 → 换新 UUID → 更新订阅路径 → 旧路径拒绝、新路径 101/200 → 把新订阅链接发到你的 Outlook。失败会自动回滚。</p></div>`;
}

// ======================= Batch B (2026-10): 优选 IP 卡片 · 访客邀请 =======================
// ---- 优选 IP (results from GitHub Actions ip-opt via status /api/ip-opt -> D1 ip_opt) ----
const IPO_RUN_UTC = { h: 20, m: 37 }; // 04:37 UTC+8
function nextDailyUtc(now, h, m) { const d = new Date(now); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m); if (t <= now) t += 86400000; return t; }
function nextHourUtc(now) { return Math.floor(now / 3600000) * 3600000 + 3600000; }
async function ipOptSection(env, request, url) {
  let r = null, q = null;
  try { [r, q] = await Promise.all([env.DB.prepare("SELECT t, run_at, run_url, trigger, data, chosen_n, ok_n, err FROM ip_opt WHERE id = 1").first(), env.DB.prepare("SELECT requested_at, dispatched_at, done_at FROM ip_opt_req WHERE id = 1").first()]); }
  catch (e) { return errCard("优选 IP", "D1 读取失败"); }
  const now = Date.now(), csrf = await csrfToken(request, env, "admin-proxy");
  const m = { ipopt_queued: ["nok", "已排队。GitHub 每小时整点的巡检会启动优选，结果大约在下一个整点后 5–15 分钟出现在这里。"], ipopt_wait: ["", "已经在排队了，不用重复点。"], ipopt_err: ["nerr", "排队失败（D1 写入出错），稍后再试。"] }[url.searchParams.get("m") || ""];
  let d = {}; try { d = JSON.parse((r && r.data) || "{}"); } catch (e) {}
  const pending = q && q.requested_at && !(q.done_at && q.done_at >= q.requested_at);
  let body = `<div class="card" id="ipopt"><h2>优选 IP</h2>`;
  if (m) body += `<p class="note ${m[0]}">${esc(m[1])}</p>`;
  body += `<div class="kpis"><div class="kpi"><span class="muted small">上次优选</span><b class="kb">${r ? esc(ago(r.t) || "刚刚") : "还没有"}</b><span class="small muted">${r ? esc(t8(r.t)) + (r.trigger === "workflow_dispatch" || r.trigger === "repository_dispatch" ? " · 手动" : r.trigger === "schedule" ? " · 定时" : "") : ""}</span></div>
<div class="kpi"><span class="muted small">候选 / 通过握手验证</span><b>${r ? esc((d.candidates || []).length) + " / " + esc(r.ok_n) : "—"}</b><span class="small muted">${esc((d.sources || []).map(s => s.name + (s.ok ? " " + s.n : " 失败")).join(" · "))}</span></div>
<div class="kpi"><span class="muted small">选出</span><b>${r ? esc(r.chosen_n) + " 个" : "—"}</b><span class="small muted">移动 / 联通 / 电信 轮流挑</span></div>
<div class="kpi"><span class="muted small">下次自动运行</span><b class="kb">${esc(t8(nextDailyUtc(now, IPO_RUN_UTC.h, IPO_RUN_UTC.m)).slice(5, 16))}</b><span class="small muted">每天 04:37（UTC+8）</span></div></div>`;
  if (r && r.err) body += `<p class="note nerr">${esc(r.err)}</p>`;
  const ch = d.chosen || [];
  if (ch.length) {
    body += `<div class="tw"><table><thead><tr><th>#</th><th>IP</th><th>适合线路</th><th>国内实测延迟</th><th>机房</th><th>本站握手</th><th>GitHub→IP（参考）</th><th>来源</th></tr></thead><tbody>${ch.map((x, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(x.ip)}</td><td>${badge(x.for_line === "移动" ? "grn" : x.for_line === "联通" ? "blue" : "yel", x.for_line || "?")}</td><td><b>${x.cn_ms != null ? esc(x.cn_ms) + " ms" : "—"}</b></td><td class="small">${esc(x.colo || "—")}</td><td>${badge("grn", "101")}${x.via === "outbound" ? `<div class="small muted">经出口代理验证</div>` : ""}</td><td class="small muted">${x.tcp_ms != null ? "TCP " + esc(x.tcp_ms) + " ms" : "—"}${x.tls_ms != null ? " · TLS " + esc(x.tls_ms) + " ms" : ""}</td><td class="small muted">${esc((x.srcs || []).join(" + "))}</td></tr>`).join("")}</tbody></table></div>`;
    const base = d.baseline || [];
    if (base.length) body += `<p class="small muted mt">对照：订阅现在下发的 20 个「内置·保底」IP，本站握手 101 通过 ${base.filter(x => x.ws_ok).length} / ${base.length} 个（它们不在国内测速榜单里，国内延迟没有公开数据）。</p>`;
  } else if (r) body += `<p class="muted">这次没有选出 IP。</p>`;
  body += `<form class="f mt" method="post" action="/admin/proxy/ip-opt-run"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn" type="submit"${pending ? " disabled" : ""}>${pending ? "已排队，等待运行…" : "立即优选"}</button><span class="small muted">${pending ? "排队于 " + esc(t8(q.requested_at)) + "，下一次整点巡检（约 " + esc(t8(nextHourUtc(now)).slice(11, 16)) + "）会启动，" : "点了之后由下一次整点巡检启动（约 " + esc(t8(nextHourUtc(now)).slice(11, 16)) + "，GitHub 定时任务常会晚几分钟），"}约 2 分钟跑完。</span></form>`;
  body += `<p class="note"><b>说实话的部分：</b>GitHub 和 Cloudflare 的服务器都不在国内，<b>没法替你测「从国内连过来」有多快</b>。这里的「国内实测延迟」来自 wetest.vip 和 hostmonit 这两个公开榜单（它们在国内三网机房测的）；我们这边只验证每个候选 IP 能不能正常完成 TLS 握手、能不能打通你的代理（WebSocket 101），然后按榜单延迟排序。「GitHub→IP」那列只是参考，跟你在国内的速度无关。<br><b>目前只测量和展示，不会改你的订阅：</b>CFNext 现在的下发模式里，10 个节点固定从程序里写死的 20 个「内置·保底」IP 中挑，配置里的「优选 IP」列表根本不参与下发；要让这里的结果真正进订阅，得改订阅模式（会去掉保底节点），这一步没有你的同意不会做。想试的话找 Grok Bot。</p>`;
  body += `</div>`;
  return body;
}
async function ipOptRun(request, env, back) {
  const now = Date.now(), ip = request.headers.get("cf-connecting-ip") || "";
  try {
    const q = await env.DB.prepare("SELECT requested_at, done_at FROM ip_opt_req WHERE id = 1").first();
    if (q && q.requested_at && !(q.done_at && q.done_at >= q.requested_at) && now - q.requested_at < 3 * 3600000) return back("ipopt_wait", "ipopt");
    await env.DB.prepare("INSERT INTO ip_opt_req (id, requested_at, ip, dispatched_at, done_at) VALUES (1, ?1, ?2, NULL, NULL) ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at, ip = excluded.ip, dispatched_at = NULL").bind(now, ip).run();
    await env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, 'admin_ipopt', ?2, ?3, ?4)").bind(now, ip, request.headers.get("x-client-co") || "", "queue ip-opt").run().catch(() => {});
    return back("ipopt_queued", "ipopt");
  } catch (e) { return back("ipopt_err", "ipopt"); }
}

// ---- 只读访客 (guest invites) ----
// Each invite = a long random token link https://panel.example.com/g/<token>. Only SHA-256("guest1:" + token) is stored
// (D1 guest_invites); the link is shown ONCE right after creation. The portal serves /g/<token> without any session:
// subscription URL + QR + basic node status, nothing else. Revocable, expiring, every view logged, first use emailed.
const G_DAYS = [1, 7, 30, 90], G_MAX_ACTIVE = 20;
function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function guestHash(tok) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", TE.encode("guest1:" + tok)))].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function guestsPost(request, env, p) {
  let form; try { form = await request.formData(); } catch (e) { form = null; }
  if (!form || !(await csrfOk(request, env, String(form.get("csrf") || ""), "admin-guests"))) return csrfFail(request);
  const back = m => new Response(null, { status: 303, headers: { "location": "/admin/guests?m=" + encodeURIComponent(m), "cache-control": "no-store" } });
  const ip = request.headers.get("cf-connecting-ip") || "", now = Date.now();
  const audit = what => env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, 'admin_guest', ?2, ?3, ?4)").bind(now, ip, request.headers.get("x-client-co") || "", String(what).slice(0, 120)).run().catch(() => {});
  if (p === "/admin/guests/create") {
    const name = String(form.get("name") || "").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim().slice(0, 30);
    const days = parseInt(String(form.get("days") || ""), 10);
    if (!name) return back("err_name");
    if (!G_DAYS.includes(days)) return back("err_days");
    const act = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_invites WHERE revoked_at IS NULL AND expires_at > ?1").bind(now).first();
    if (act && act.n >= G_MAX_ACTIVE) return back("err_full");
    const tok = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = "g-" + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT INTO guest_invites (id, name, token_h, created_at, expires_at, views, created_ip) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)").bind(id, name, await guestHash(tok), now, now + days * 86400000, ip).run();
    await audit("create " + id + " " + days + "d");
    // Show the link exactly once (POST response, no-store; never in a redirect URL or a log).
    return html(s => s, await pageGuests(env, request, new URL(request.url), { id, name, link: "https://" + HOST + "/g/" + tok, days }));
  }
  if (p === "/admin/guests/revoke") {
    const id = String(form.get("id") || "");
    const r = await env.DB.prepare("UPDATE guest_invites SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(id, now).run();
    if (!r.meta || !r.meta.changes) return back("err_id");
    await audit("revoke " + id);
    return back("revoked");
  }
  return new Response("not found", { status: 404 });
}
const GUEST_MSG = { revoked: ["nok", "已撤销，这个链接马上失效。注意：对方如果已经把订阅导入了客户端，还是能继续用，直到你换 UUID。"], err_name: ["nerr", "请填一个备注名（谁用的）。"], err_days: ["nerr", "有效期只能选 1 / 7 / 30 / 90 天。"], err_full: ["nerr", "有效的邀请最多 20 个，先撤销一些。"], err_id: ["nerr", "找不到这个邀请，或者已经撤销过了。"] };
async function pageGuests(env, request, url, created) {
  const now = Date.now(), csrf = await csrfToken(request, env, "admin-guests");
  let rows = [], views = [];
  try {
    const [a, b] = await env.DB.batch([
      env.DB.prepare("SELECT id, name, created_at, expires_at, revoked_at, first_used_at, last_used_at, views, last_ip FROM guest_invites ORDER BY created_at DESC LIMIT 60"),
      env.DB.prepare("SELECT v.t, v.gid, v.ip, v.co, v.ua, g.name FROM guest_views v LEFT JOIN guest_invites g ON g.id = v.gid ORDER BY v.t DESC LIMIT 40")
    ]);
    rows = a.results || []; views = b.results || [];
  } catch (e) { return { title: "访客", active: "/admin/guests", body: errCard("访客", "D1 读取失败") }; }
  const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const m = GUEST_MSG[url.searchParams.get("m") || ""];
  let body = `<p class="sub">给家人或朋友一个只读链接：他们只能看到代理订阅（链接 + 二维码）和节点是否在线，看不到工作台、代理面板、网盘、验证码、AI 助手、配置版本、令牌和审计日志。</p>`;
  body += `<p class="note nerr"><b>访客拿到的是和你一样的订阅，撤销访客不会自动换 UUID。</b>订阅链接里就带着 UUID，对方导入客户端后，撤销邀请只能让这个网页打不开，不能让他已经导入的订阅失效；要彻底收回只能换 UUID（找 Grok Bot）。只发给你信任的人。</p>`;
  if (m) body += `<p class="note ${m[0]}">${esc(m[1])}</p>`;
  let script = "";
  if (created) {
    body += `<div class="card"><h2>邀请已创建：${esc(created.name)}</h2><p class="note nok">下面这个链接<b>只显示这一次</b>（服务器只存了它的哈希），请现在复制发给对方。${esc(created.days)} 天后自动失效。</p><input type="text" id="glink" readonly value="${esc(created.link)}" class="wfull"> <button class="btn mt" id="gcp" type="button">复制链接</button> <span id="gcps" class="small muted"></span><p class="small muted mt">对方第一次打开时你会收到一封邮件；每次打开都会记录 IP。</p></div>`;
    script = `(function(){var b=document.getElementById('gcp'),i=document.getElementById('glink'),s=document.getElementById('gcps');b.addEventListener('click',function(){var ok=function(){s.textContent='已复制'};var no=function(){i.focus();i.select();s.textContent='请手动复制（Ctrl+C）'};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(i.value).then(ok,no);else no();});})();`;
  }
  body += `<div class="card"><h2>新建访客邀请</h2><form class="f" method="post" action="/admin/guests/create" autocomplete="off">${hid}<input type="text" name="name" placeholder="备注名，例如：老爸的手机" required maxlength="30" class="wh"><select name="days"><option value="1">1 天</option><option value="7" selected>7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><button class="btn" type="submit">生成邀请链接</button></form><p class="small muted">链接是 /g/ 加 43 位随机字符，猜不出来；每个链接 10 分钟内最多打开 60 次。最多同时 20 个有效邀请。</p></div>`;
  const st = x => x.revoked_at ? badge("gray", "已撤销") : x.expires_at <= now ? badge("gray", "已过期") : x.first_used_at ? badge("grn", "有效 · 已使用") : badge("blue", "有效 · 未打开");
  body += `<div class="card"><h2>邀请列表</h2><div class="tw"><table><thead><tr><th>备注</th><th>状态</th><th>创建</th><th>到期</th><th>打开次数</th><th>首次 / 最近打开</th><th></th></tr></thead><tbody>${rows.map(x => `<tr class="${!x.revoked_at && x.expires_at > now && x.views ? "hy" : ""}"><td>${esc(x.name)}<div class="small muted mono">${esc(x.id)}</div></td><td>${st(x)}</td><td class="small">${esc(t8(x.created_at))}</td><td class="small">${esc(t8(x.expires_at))}</td><td>${esc(x.views || 0)}</td><td class="small">${x.first_used_at ? esc(t8(x.first_used_at)) : "—"}${x.last_used_at ? `<div class="muted">${esc(ago(x.last_used_at))} · <span class="mono">${esc(x.last_ip || "")}</span></div>` : ""}</td><td>${!x.revoked_at && x.expires_at > now ? `<form method="post" action="/admin/guests/revoke" class="inl">${hid}<input type="hidden" name="id" value="${esc(x.id)}"><button class="btn ghost" type="submit">撤销</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">还没有邀请</td></tr>`}</tbody></table></div></div>`;
  body += `<div class="card"><h2>最近的访客访问</h2><div class="tw"><table><thead><tr><th>时间（UTC+8）</th><th>邀请</th><th>IP</th><th>国家</th><th>设备</th></tr></thead><tbody>${views.map(v => `<tr><td class="small">${esc(t8(v.t))}</td><td>${esc(v.name || v.gid)}</td><td class="mono small">${esc(v.ip)}</td><td>${esc(v.co || "")}</td><td class="small muted">${esc(uaShort(v.ua))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">还没有访问记录</td></tr>`}</tbody></table></div><p class="small muted">访问记录保留 90 天。</p></div>`;
  return { title: "访客", active: "/admin/guests", body, script };
}
