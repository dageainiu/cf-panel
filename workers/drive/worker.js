const SECH={"Strict-Transport-Security":"max-age=31536000; includeSubDomains","X-Content-Type-Options":"nosniff","X-Frame-Options":"SAMEORIGIN","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"geolocation=(), microphone=(), camera=()","Content-Security-Policy":"default-src \x27self\x27; img-src \x27self\x27 data:; style-src \x27self\x27 \x27unsafe-inline\x27; script-src \x27self\x27 \x27unsafe-inline\x27; connect-src \x27self\x27; frame-ancestors \x27self\x27; base-uri \x27self\x27; form-action \x27self\x27"};
const SVC_HARD = true; // phase flag: false=soft (allow missing header), true=hard (require x-svc-key)
const OWNER="YOUR_GITHUB_USER"; // 网盘文件存放的 GitHub 用户名
const REPO="YOUR_DRIVE_REPO"; // 网盘文件存放的私有仓库名
// Measured 2026-10-10 on the Free plan: the old in-Worker base64 path died (error 1102) at 30 MB; the browser now does the
// base64 itself and the Worker only wraps the text into the GitHub blob JSON, which passed 30 MB end-to-end in tests.
// Stated limit is 20 MB to keep a safety margin under the 128 MB Worker memory limit.
const MAX=20*1024*1024;
async function ctEq(a, b) {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(String(a))), crypto.subtle.digest("SHA-256", e.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
export default {
  async fetch(request, env) {
    const _k = request.headers.get("x-svc-key");
    if (!env.SVC_KEY || _k === null || !(await ctEq(_k, env.SVC_KEY))) return new Response("forbidden", { status: 403 });
    const url=new URL(request.url);
    try {
      if (url.pathname==="/api/list") return Response.json(await list(env));
      if (url.pathname==="/api/file" && request.method==="GET") return await download(env, url.searchParams.get("path"));
      if (url.pathname==="/api/file" && request.method==="PUT") return await upload(request, env);
      if (url.pathname==="/api/file" && request.method==="DELETE") return await remove(request, env);
      if (url.pathname==="/" || url.pathname==="/index.html") return new Response(PAGE, {headers:Object.assign({"content-type":"text/html; charset=utf-8"}, SECH)});
      return new Response("not found", {status:404});
    } catch (err) {
      // Validation messages meant for the user are returned as 400; anything else stays server-side only.
      if (err instanceof UserError) return Response.json({ok:false, error:err.message}, {status:400});
      console.error("drive worker error: " + String(err && err.stack || err));
      return Response.json({ok:false, error:"服务器错误，请稍后再试"}, {status:500});
    }
  }
};
class UserError extends Error {}
function ghHeaders(env){return {"Authorization":"Bearer "+env.GH_TOKEN,"Accept":"application/vnd.github+json","User-Agent":"cloud-drive"};}
async function list(env){
  const res=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/files`, {headers:ghHeaders(env)});
  if (res.status===404) return {ok:true, files:[]};
  if (!res.ok) throw new Error("GitHub "+res.status);
  const data=await res.json();
  const files=(Array.isArray(data)?data:[]).filter(x=>x.type==="file").map(x=>({name:x.name.replace(/^\d{13}-/,""), size:x.size, path:x.path, t:Number((/^(\d{13})-/.exec(x.name)||[])[1])||0})).sort((a,b)=>b.t-a.t);
  return {ok:true, files};
}
async function download(env, path){
  if (!path || !path.startsWith("files/") || path.includes("..") || path.slice(6).includes("/")) return new Response("bad path", {status:400});
  const res=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {headers:{...ghHeaders(env),"Accept":"application/vnd.github.raw"}});
  if (!res.ok) return new Response("missing", {status:404});
  const name=path.split("/").pop().replace(/^\d{13}-/,"");
  const ascii=name.replace(/[^\x20-\x7e]/g,"_").replace(/["\\]/g,"_");
  return new Response(res.body, {headers:{"content-type":"application/octet-stream","content-disposition":`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,"x-content-type-options":"nosniff","cache-control":"no-store"}});
}
// Upload: the browser sends the file already base64-encoded (text body) with the original name in x-file-name (URI-encoded).
// The Worker never decodes it: it checks the size / charset cheaply and wraps it into the GitHub git-blob JSON.
function safeName(n){
  n=String(n||"").normalize("NFC").replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g,"_").replace(/^[.\s]+/,"").trim().slice(0,120);
  return n||"file";
}
async function upload(request, env){
  let name=""; try{ name=decodeURIComponent(request.headers.get("x-file-name")||""); }catch(e){ throw new UserError("文件名无法解析"); }
  if (!name) throw new UserError("没有文件");
  const declared=Number(request.headers.get("content-length")||0);
  if (declared>Math.ceil(MAX/3)*4+16) throw new UserError("单文件上限 20MB");
  const b64=(await request.text()).trim();
  if (!b64) throw new UserError("空文件");
  if (b64.length>Math.ceil(MAX/3)*4) throw new UserError("单文件上限 20MB");
  if (b64.length%4!==0 || b64.indexOf('"')>=0 || b64.indexOf("\\")>=0 || /[^A-Za-z0-9+\/=]/.test(b64.slice(0,4096))) throw new UserError("文件编码不对，请刷新页面后重试");
  const size=Math.floor(b64.length*3/4)-(b64.endsWith("==")?2:b64.endsWith("=")?1:0);
  const safe=safeName(name);
  const path=`files/${Date.now()}-${safe}`;
  const blobRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/blobs`, {method:"POST", headers:{...ghHeaders(env),"Content-Type":"application/json"}, body:'{"encoding":"base64","content":"'+b64+'"}'});
  if (!blobRes.ok) throw new Error("blob 失败 "+blobRes.status);
  const blob=await blobRes.json();
  const refRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/ref/heads/main`, {headers:ghHeaders(env)});
  if (!refRes.ok) throw new Error("分支失败 "+refRes.status);
  const ref=await refRes.json();
  const commitRes=await fetch(ref.object.url, {headers:ghHeaders(env)});
  const commit=await commitRes.json();
  const treeRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees`, {method:"POST", headers:{...ghHeaders(env),"Content-Type":"application/json"}, body:JSON.stringify({base_tree:commit.tree.sha, tree:[{path, mode:"100644", type:"blob", sha:blob.sha}]})});
  if (!treeRes.ok) throw new Error("tree 失败 "+treeRes.status);
  const tree=await treeRes.json();
  const newCommitRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/commits`, {method:"POST", headers:{...ghHeaders(env),"Content-Type":"application/json"}, body:JSON.stringify({message:"upload "+safe, tree:tree.sha, parents:[ref.object.sha]})});
  if (!newCommitRes.ok) throw new Error("commit 失败 "+newCommitRes.status);
  const newCommit=await newCommitRes.json();
  const updateRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/refs/heads/main`, {method:"PATCH", headers:{...ghHeaders(env),"Content-Type":"application/json"}, body:JSON.stringify({sha:newCommit.sha})});
  if (!updateRes.ok) throw new Error("更新分支失败 "+updateRes.status);
  return Response.json({ok:true, path, size});
}
async function remove(request, env){
  const body=await request.json();
  const path=String(body.path||"");
  if (!path.startsWith("files/") || path.includes("..") || path.slice(6).includes("/")) throw new UserError("bad path");
  const enc=path.split("/").map(encodeURIComponent).join("/");
  const metaRes=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${enc}`, {headers:ghHeaders(env)});
  if (!metaRes.ok) throw new UserError("找不到文件");
  const meta=await metaRes.json();
  const res=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${enc}`, {method:"DELETE", headers:{...ghHeaders(env),"Content-Type":"application/json"}, body:JSON.stringify({message:"delete "+path, sha:meta.sha})});
  if (!res.ok) throw new Error("删除失败 "+res.status);
  return Response.json({ok:true});
}
const PAGE=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网盘</title>
<style>
:root{--bg:#09090b;--card:#18181b;--card2:#18181b;--line:#27272a;--txt:#fafafa;--muted:#a1a1aa;--brand:#8b5cf6;--brand2:#a78bfa;--ok:#22c55e}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--txt);background:radial-gradient(1000px 600px at 90% -10%,rgba(122,92,255,.16),transparent 60%),var(--bg);min-height:100vh}
main{max-width:820px;margin:auto;padding:34px 22px 72px}
a{color:var(--brand);text-decoration:none}
.top{display:flex;justify-content:space-between;align-items:flex-end}
.mark{letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:var(--muted)}
h1{margin:6px 0;font-weight:650}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0));border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:12px 0;display:flex;justify-content:space-between;gap:12px;align-items:center}
small{color:var(--muted)}
button,input{font:inherit}
button{border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border-radius:12px;padding:10px 16px;cursor:pointer;font-weight:600;box-shadow:0 10px 26px rgba(91,140,255,.32)}
button.ghost{background:rgba(255,255,255,.06);color:var(--txt);box-shadow:none;border:1px solid var(--line)}
input[type=file]{color:var(--muted);background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
form.card{align-items:center}
.pg{margin:6px 0 10px}.pgb{height:8px;border-radius:6px;background:var(--card2);overflow:hidden;border:1px solid var(--line)}.pgb i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--brand),var(--brand2));transition:width .2s}
</style>
<main><div class="top"><div><p class="mark">网盘</p><h1>文件</h1></div><a href="/">返回工作台</a></div><p><small>私有 GitHub 仓库存储，单文件上限 20MB（实测免费版可靠的大小），支持中文文件名。</small></p><form id="f" class="card"><input type="file" name="file" required> <button id="ub">上传</button></form><div id="pg" class="pg" hidden><div class="pgb"><i id="pgi"></i></div><small id="pgt"></small></div><p id="msg"></p><div id="list"></div></main>
<script>
var MAX=20*1024*1024;
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function hsize(n){n=Number(n)||0;var u=["B","KB","MB","GB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (i?n.toFixed(1):n)+" "+u[i];}
function msg(t){document.getElementById("msg").textContent=t;}
async function load(){const data=await (await fetch("/drive/api/list",{cache:"no-store"})).json(); if(!data.ok){msg(data.error||"失败"); return;} const files=data.files||[]; const list=document.getElementById("list"); list.innerHTML=files.map((f,i)=>'<div class="card"><div><b>'+esc(f.name)+'</b><br><small>'+esc(hsize(f.size))+(f.t?' · '+esc(new Date(f.t).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}))+'（UTC+8）':'')+'</small></div><div><a href="/drive/api/file?path='+esc(encodeURIComponent(f.path))+'">下载</a> <button class="ghost" data-i="'+i+'">删除</button></div></div>').join("")||"<p>空的</p>"; list.querySelectorAll("button[data-i]").forEach(b=>{b.onclick=()=>del(files[Number(b.dataset.i)]);});}
function prog(p,t){var g=document.getElementById("pg");g.hidden=p==null;if(p!=null){document.getElementById("pgi").style.width=Math.round(p*100)+"%";document.getElementById("pgt").textContent=t||"";}}
function readB64(file){return new Promise((ok,bad)=>{var r=new FileReader();r.onload=()=>{var s=String(r.result);ok(s.slice(s.indexOf(",")+1));};r.onerror=()=>bad(new Error("读取文件失败"));r.onprogress=e=>{if(e.lengthComputable)prog(e.loaded/e.total*0.15,"读取文件…");};r.readAsDataURL(file);});}
document.getElementById("f").onsubmit=async e=>{e.preventDefault(); const file=e.target.file.files[0]; if(!file)return;
  if(file.size>MAX){msg("文件太大："+hsize(file.size)+"，单文件上限 20MB");return;}
  if(file.size===0){msg("空文件不能上传");return;}
  const btn=document.getElementById("ub"); btn.disabled=true; msg("");
  try{
    const b64=await readB64(file);
    const data=await new Promise((ok,bad)=>{const x=new XMLHttpRequest();x.open("PUT","/drive/api/file");x.setRequestHeader("content-type","text/plain");x.setRequestHeader("x-file-name",encodeURIComponent(file.name));
      x.upload.onprogress=ev=>{if(ev.lengthComputable)prog(0.15+ev.loaded/ev.total*0.75,"上传中 "+Math.round(ev.loaded/ev.total*100)+"%");};
      x.upload.onload=()=>prog(0.92,"已上传，正在保存到仓库…");
      x.onload=()=>{try{ok(JSON.parse(x.responseText));}catch(err){ok({ok:false,error:"服务器返回 "+x.status});}};x.onerror=()=>bad(new Error("网络错误"));x.send(b64);});
    prog(data.ok?1:null,data.ok?"完成":""); msg(data.ok?"已上传："+file.name:(data.error||"失败")); if(data.ok){e.target.reset();load();setTimeout(()=>prog(null),1500);}
  }catch(err){prog(null);msg(err.message||"失败");}
  finally{btn.disabled=false;}
};
async function del(f){if(!confirm("确定删除「"+f.name+"」吗？删除后不能在网盘里恢复。"))return; msg("删除中…"); const r=await fetch("/drive/api/file",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({path:f.path})}); const d=await r.json().catch(()=>({})); msg(d.ok?"已删除":(d.error||"删除失败")); load();}
load();
</script>`;