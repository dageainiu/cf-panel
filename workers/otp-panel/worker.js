const SECH={"Strict-Transport-Security":"max-age=31536000; includeSubDomains","X-Content-Type-Options":"nosniff","X-Frame-Options":"SAMEORIGIN","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"geolocation=(), microphone=(), camera=()","Content-Security-Policy":"default-src \x27self\x27; img-src \x27self\x27 data:; style-src \x27self\x27 \x27unsafe-inline\x27; script-src \x27self\x27 \x27unsafe-inline\x27; connect-src \x27self\x27; frame-ancestors \x27self\x27; base-uri \x27self\x27; form-action \x27self\x27"};
const SVC_HARD = true; // phase flag: false=soft, true=hard (require x-svc-key)
async function ctEq(a, b) {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(String(a))), crypto.subtle.digest("SHA-256", e.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
export default {
  async fetch(request, env) {
    const _k = request.headers.get("x-svc-key");
    if (!env.SVC_KEY || _k === null || !(await ctEq(_k, env.SVC_KEY))) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/codes") return Response.json(await loadCodes(env), { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/api/latest") return Response.json(await latestCode(env), { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/api/message") return Response.json(await loadMessage(env, url.searchParams.get("id")), { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/api/translate" && request.method === "POST") {
        const body = await request.json();
        const r = await translate(body.text || "", body.to || "zh-CN", env);
        return Response.json(Object.assign({ ok: true }, r));
      }
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(PAGE, { headers: Object.assign({ "content-type": "text/html; charset=utf-8" }, SECH) });
    return new Response("not found", { status: 404 });
  },
  // Daily cron: refresh the Microsoft token so the rotated refresh_token (saved to OTP KV) never expires from inactivity.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(accessToken(env, true).then(() => console.log("ms token refreshed"), e => console.log("ms token refresh failed: " + String(e && e.message || e))));
  }
};

async function loadCodes(env) {
  const token = await accessToken(env);
  const res = await fetch("https://graph.microsoft.com/v1.0/me/messages?$top=15&$select=id,subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime%20desc", { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Graph " + res.status);
  const body = await res.json();
  return { ok: true, mailbox: "<EMAIL>", items: (body.value || []).map(extract) };
}

async function loadMessage(env, id) {
  if (!id) throw new Error("missing id");
  const token = await accessToken(env);
  const res = await fetch("https://graph.microsoft.com/v1.0/me/messages/" + encodeURIComponent(id) + "?$select=id,subject,from,receivedDateTime,body", { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Graph " + res.status);
  const msg = await res.json();
  const html = msg.body?.content || "";
  const text = msg.body?.contentType === "html" ? strip(html) : html;
  return { ok: true, item: { ...extract(msg), body: text.slice(0, 60000), truncated: text.length > 60000 } };
}

// Access token cached in-isolate and in KV (~50 min) so polling (/api/latest) does not refresh + rewrite KV every call.
let AT_MEM = null;
async function accessToken(env, force) {
  const now = Date.now();
  if (!force && AT_MEM && AT_MEM.exp > now + 60000) return AT_MEM.v;
  if (!force && env.OTP) {
    try { const c = await env.OTP.get("access_cache", { type: "json" }); if (c && c.v && c.exp > now + 60000) { AT_MEM = c; return c.v; } } catch (e) {}
  }
  const saved = env.OTP ? await env.OTP.get("refresh_token") : "";
  const form = new URLSearchParams();
  form.set("client_id", env.MS_CLIENT_ID);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", saved || env.MS_REFRESH_TOKEN);
  form.set("scope", "https://graph.microsoft.com/Mail.Read offline_access");
  const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "refresh failed");
  if (data.refresh_token && env.OTP) await env.OTP.put("refresh_token", data.refresh_token);
  const life = Math.min(Number(data.expires_in) || 3600, 3600) * 1000;
  AT_MEM = { v: data.access_token, exp: now + life - 300000 };
  if (env.OTP) { try { await env.OTP.put("access_cache", JSON.stringify(AT_MEM), { expirationTtl: Math.max(60, Math.floor((life - 300000) / 1000)) }); } catch (e) {} }
  return data.access_token;
}

// Source language: script detection first (CJK / kana / hangul / Cyrillic / Arabic / Thai ...), then a light stop-word vote
// for Latin-script languages; Google (sl=auto) is tried first when reachable, Workers AI m2m100 is the fallback.
const LATIN_HINTS = { en: ["the", "and", "you", "your", "for", "with", "this", "code", "is", "to"], es: ["el", "la", "los", "las", "de", "que", "y", "tu", "su", "para", "código"], fr: ["le", "la", "les", "de", "et", "vous", "votre", "pour", "est", "code"], de: ["der", "die", "das", "und", "sie", "ihr", "ist", "für", "mit", "code"], pt: ["o", "a", "os", "de", "que", "e", "seu", "sua", "para", "código", "você"], it: ["il", "la", "di", "che", "e", "per", "tuo", "codice", "è", "con"], nl: ["de", "het", "een", "en", "van", "je", "uw", "voor", "is", "code"], id: ["dan", "yang", "anda", "untuk", "kode", "ini", "dengan", "akun"], tr: ["ve", "bir", "bu", "için", "kodu", "hesabınız"], vi: ["của", "và", "là", "mã", "bạn", "tài", "khoản"] };
function detectLang(t) {
  t = String(t || "");
  const cnt = re => (t.match(re) || []).length;
  const n = Math.max(1, t.replace(/\s/g, "").length);
  if (cnt(/[\u3040-\u30ff]/g) / n > 0.05) return "ja";
  if (cnt(/[\uac00-\ud7af]/g) / n > 0.1) return "ko";
  if (cnt(/[\u4e00-\u9fff]/g) / n > 0.2) return "zh";
  if (cnt(/[\u0400-\u04ff]/g) / n > 0.2) return "ru";
  if (cnt(/[\u0600-\u06ff]/g) / n > 0.2) return "ar";
  if (cnt(/[\u0e00-\u0e7f]/g) / n > 0.2) return "th";
  if (cnt(/[\u0590-\u05ff]/g) / n > 0.2) return "he";
  if (cnt(/[\u0370-\u03ff]/g) / n > 0.2) return "el";
  const words = (t.toLowerCase().match(/[a-zà-ÿğışçöüạ-ỹ]+/g) || []).slice(0, 400);
  let best = "en", bs = 0;
  for (const [lang, list] of Object.entries(LATIN_HINTS)) { const set = new Set(list); let sc = 0; for (const w of words) if (set.has(w)) sc++; if (sc > bs) { bs = sc; best = lang; } }
  return best;
}
async function translate(text, to, env) {
  const q = String(text || "").slice(0, 2000);
  if (!q.trim()) return { text: "", from: "" };
  const tl = String(to || "zh").split("-")[0];
  const src = detectLang(q);
  if (src === tl) return { text: q, from: src, same: true };
  try {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(to) + "&dt=t&q=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept": "application/json" }, signal: AbortSignal.timeout(6000) });
    const raw = await res.text();
    if (res.ok && !raw.trim().startsWith("<")) {
      const data = JSON.parse(raw);
      const out = (data[0] || []).map(part => part[0]).join("");
      if (out) return { text: out, from: String(data[2] || src), engine: "google" };
    }
  } catch (e) {}
  if (env && env.AI) {
    const parts = [];
    for (const line of q.split(/\n/)) {
      if (!line.trim()) { parts.push(""); continue; }
      for (let i = 0; i < line.length; i += 400) parts.push(line.slice(i, i + 400));
    }
    const out = [];
    for (const part of parts) {
      if (!part.trim()) { out.push(""); continue; }
      try { const r = await env.AI.run("@cf/meta/m2m100-1.2b", { text: part, source_lang: src, target_lang: tl }); out.push((r && r.translated_text) || part); }
      catch (e) { out.push(part); }
    }
    return { text: out.join("\n"), from: src, engine: "workers-ai" };
  }
  throw new Error("翻译服务暂时不可用");
}

function extract(msg) {
  const text = (msg.subject || "") + "\n" + (msg.bodyPreview || "");
  return { id: msg.id, received: msg.receivedDateTime, from: msg.from?.emailAddress?.address || "", subject: msg.subject || "", code: findCode(text), preview: (msg.bodyPreview || "").slice(0, 140) };
}
// ---- OTP extraction (4-8 digits, labelled patterns first; years / dates / phone-like numbers are skipped) ----
const OTP_KW = "验证码|校验码|动态码|动态密码|确认码|安全码|登录码|登入码|激活码|驗證碼|認證碼|认证码|verification code|security code|one[- ]time (?:pass(?:code|word)|code)|login code|log-in code|sign[- ]in code|confirmation code|authentication code|access code|passcode|otp|code|pin|código|code de vérification|kode";
const OTP_RE_AFTER = new RegExp("(?:" + OTP_KW + ")(?:\\s*(?:is|为|是|:|：|=|-))?[^0-9]{0,24}(?:[A-Z]{1,3}-)?([0-9]{4,8}|[0-9]{3}[ -][0-9]{3})(?![0-9])", "i");
const OTP_RE_BEFORE = new RegExp("(?<![0-9A-Za-z])(?:[A-Z]{1,3}-)?([0-9]{4,8}|[0-9]{3} [0-9]{3})(?![0-9])[^0-9]{0,30}(?:" + OTP_KW + ")", "i");
const OTP_HINT = new RegExp(OTP_KW.replace("|code|pin", ""), "i");
function okCode(c) {
  c = String(c || "").replace(/[ -]/g, "");
  if (!/^[0-9]{4,8}$/.test(c)) return "";
  if (/^(19|20)[0-9]{2}$/.test(c)) return ""; // a year
  if (/^(19|20)[0-9]{2}(0[1-9]|1[0-2])([0-2][0-9]|3[01])$/.test(c)) return ""; // yyyymmdd
  return c;
}
function findCode(text) {
  text = String(text || "").replace(/\s+/g, " ");
  for (const re of [OTP_RE_AFTER, OTP_RE_BEFORE]) {
    const m = re.exec(text); const c = m && okCode(m[1]); if (c) return c;
  }
  if (OTP_HINT.test(text)) {
    const all = (text.match(/(?<![0-9.,:\/-])[0-9]{4,8}(?![0-9.,:\/-])/g) || []).map(okCode).filter(Boolean);
    if (all.length) return all[0];
  }
  return "";
}
// Latest verification code (last 15 min) for the workbench home card. Stores only code/from/subject/time in KV
// (never the body); KV is written only when the newest code changes (Free plan: 1000 KV writes/day).
const OTP_MAX_AGE = 10 * 60000;
// Panel's own mails (alerts / 2FA bind codes) must never show up as "latest code".
const OTP_SKIP_FROM = ["noreply@example.com", "alert@panel.example.com"];
function otpSkip(x) { const f = String(x && x.from || "").toLowerCase().trim(); const sj = String(x && x.subject || "").trim(); return OTP_SKIP_FROM.includes(f) || sj.startsWith("[\u9762\u677F]") || sj.startsWith("\u3010\u9762\u677F\u3011"); }
async function latestCode(env) {
  const now = Date.now();
  let cached = null;
  try { cached = env.OTP ? await env.OTP.get("otp_latest", { type: "json" }) : null; } catch (e) {}
  let found = null, err = "";
  try {
    const token = await accessToken(env);
    const since = new Date(now - OTP_MAX_AGE).toISOString().slice(0, 19) + "Z";
    const res = await fetch("https://graph.microsoft.com/v1.0/me/messages?$top=8&$select=id,subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime%20desc&$filter=receivedDateTime%20ge%20" + since, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error("Graph " + res.status);
    const body = await res.json();
    for (const m of body.value || []) {
      const x = extract(m);
      if (x.code && !otpSkip(x)) { found = { id: String(x.id || "").slice(-24), code: x.code, from: String(x.from).slice(0, 120), subject: String(x.subject).slice(0, 160), received: x.received, seen_at: now }; break; }
    }
  } catch (e) { err = String(e && e.message || e).slice(0, 120); }
  if (found && env.OTP && (!cached || cached.id !== found.id || cached.code !== found.code)) {
    try { await env.OTP.put("otp_latest", JSON.stringify(found), { expirationTtl: 86400 }); } catch (e) {}
  }
  const best = found || (cached && !otpSkip(cached) ? cached : null);
  if (!best) return { ok: true, code: null, err };
  const age = now - Date.parse(best.received || 0);
  if (!(age <= OTP_MAX_AGE)) return { ok: true, code: null, fresh: false, err };
  return { ok: true, id: best.id || "", code: best.code, from: best.from, subject: best.subject, received: best.received, age_ms: age, fresh: age <= OTP_MAX_AGE, err };
}
function strip(html) { return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Outlook 验证码</title>
<style>
:root{--bg:#09090b;--card:#18181b;--card2:#18181b;--line:#27272a;--txt:#fafafa;--muted:#a1a1aa;--brand:#8b5cf6;--brand2:#a78bfa;--ok:#22c55e}
*{box-sizing:border-box}
body{font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:radial-gradient(1000px 600px at 90% -10%,rgba(122,92,255,.16),transparent 60%),var(--bg);color:var(--txt);min-height:100vh}
main{max-width:780px;margin:auto;padding:34px 22px 72px}
h1{font-weight:650}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0));border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:12px 0;cursor:pointer;transition:.15s}
.card:hover{border-color:rgba(91,140,255,.45)}
code{font-size:24px;letter-spacing:3px;color:var(--brand);font-weight:700}
button{border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border-radius:10px;padding:9px 14px;cursor:pointer;font-weight:600;box-shadow:0 10px 24px rgba(91,140,255,.3)}
button.alt{background:rgba(255,255,255,.06);color:var(--txt);box-shadow:none;border:1px solid var(--line)}
small{color:var(--muted)}
pre{white-space:pre-wrap;font:15px/1.6 "Segoe UI",system-ui,sans-serif;color:var(--txt)}
a{color:var(--brand);text-decoration:none}
.bar{display:flex;align-items:center;gap:12px;color:var(--muted)}
</style>
<main><div style="display:flex;justify-content:space-between;align-items:flex-end"><h1>Outlook 验证码</h1><a href="/">返回工作台</a></div>
<p class="bar"><small id="meta">读取中…</small> <button onclick="load()">刷新</button></p>
<div id="list"></div>
</main>
<script>
let items=[],view="list",timer=null;
function t8(iso){const d=new Date(iso);if(isNaN(d))return "";return d.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});}
async function load(quiet){
  view="list";
  if(!quiet)document.getElementById("meta").textContent="读取中…";
  let data;
  try{ data=await (await fetch("/api/codes",{cache:"no-store"})).json(); }catch(e){ data={ok:false,error:"网络错误"}; }
  if(view!=="list")return;
  if(!data.ok){ document.getElementById("meta").textContent=data.error||"失败"; return; }
  items=data.items||[];
  document.getElementById("meta").textContent=data.mailbox+" · 时间为北京时间（UTC+8）· 每 30 秒自动刷新 · 更新于 "+new Date().toLocaleTimeString("zh-CN",{hour12:false});
  document.getElementById("list").innerHTML=items.map((item,i)=>'<div class="card" onclick="openMail('+i+')"><code>'+escapeHtml(item.code||"—")+'</code><div>'+escapeHtml(item.subject)+'</div><small>'+escapeHtml(item.from)+" · "+escapeHtml(t8(item.received))+'</small></div>').join("")||"<p>没有邮件</p>";
}
async function openMail(i){
  view="mail";
  const item=items[i];
  document.getElementById("list").innerHTML='<p><button class="alt" onclick="load()">返回</button> <button id="trb" onclick="translateOne()">翻译这封</button> <small id="trs"></small></p><div class="card"><code>'+escapeHtml(item.code||"—")+'</code><div id="subject">'+escapeHtml(item.subject)+'</div><small>'+escapeHtml(item.from)+" · "+escapeHtml(t8(item.received))+'</small><pre id="body">读取正文…</pre></div>';
  const data=await (await fetch("/api/message?id="+encodeURIComponent(item.id))).json();
  if(!data.ok){ document.getElementById("body").textContent=data.error||"读取失败"; return; }
  window.current=data.item;
  document.getElementById("body").textContent=(data.item.body||"")+(data.item.truncated?"\n\n（正文超过 6 万字，后面的部分没有显示）":"");
}
// Split long text at paragraph / sentence boundaries into <=1500-char chunks; translate sequentially up to 12000 chars,
// anything after that stays visible in the original language.
function chunks(text,max){const out=[];let cur="";for(const para of String(text).split(/(\n+)/)){if((cur+para).length<=max){cur+=para;continue;}if(cur)out.push(cur);cur="";if(para.length<=max){cur=para;continue;}const sents=para.split(/(?<=[.!?。！？])\s+/);for(const s of sents){if((cur+" "+s).length>max&&cur){out.push(cur);cur="";}if(s.length>max){for(let i=0;i<s.length;i+=max)out.push(s.slice(i,i+max));}else cur=cur?cur+" "+s:s;}}if(cur)out.push(cur);return out;}
const TR_LIMIT=12000;
async function translateOne(){
  const subject=document.getElementById("subject"), body=document.getElementById("body"), st=document.getElementById("trs"), btn=document.getElementById("trb");
  const originalSubject=window.current?.subject||subject.textContent;
  const originalBody=window.current?.body||body.textContent;
  btn.disabled=true;
  try{
    const s=await tr(originalSubject); subject.textContent=s.text;
    const head=originalBody.slice(0,TR_LIMIT), rest=originalBody.slice(TR_LIMIT);
    const parts=chunks(head,1500), out=[];
    let from="";
    for(let i=0;i<parts.length;i++){
      st.textContent="翻译中 "+(i+1)+" / "+parts.length+"…";
      if(!parts[i].trim()){out.push(parts[i]);continue;}
      const r=await tr(parts[i]); out.push(r.text); from=from||r.from;
      body.textContent=out.join("\n")+(i<parts.length-1?"\n\n……":"")+(rest?"":"");
    }
    body.textContent=out.join("\n")+(rest?"\n\n——（以下 "+rest.length+" 字太长，保留原文）——\n"+rest:"");
    st.textContent="已翻译"+(from?"（识别为 "+from+"）":"");
  }catch(err){
    subject.textContent=originalSubject; body.textContent=originalBody;
    st.textContent=(err&&err.message)||"翻译失败";
  }finally{btn.disabled=false;}
}
async function tr(text){
  const q=String(text||"");
  if(!q.trim()) return {text:q,from:""};
  const res=await fetch("/api/translate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:q,to:"zh-CN"})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||!data.ok) throw new Error((data&&data.error)||("翻译失败 "+res.status));
  return {text:data.text||q,from:data.from||""};
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
load();
setInterval(function(){ if(view==="list" && !document.hidden) load(true); },30000);
document.addEventListener("visibilitychange",function(){ if(!document.hidden && view==="list") load(true); });
</script>`;