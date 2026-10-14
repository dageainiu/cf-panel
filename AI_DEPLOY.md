# AI 部署引导 · AI-Guided Deploy

不想看文档？把下面对应语言的**整段提示词**复制，发给任意 AI 助手（Muse、ChatGPT、Gemini、Grok 等），它会一步步带你把 cf-panel 部署到你自己的 Cloudflare 账户和域名上。

> 提示：先把本仓库 fork 或 clone 到本地，AI 才能看到代码。

---

## 中文提示词（复制整段发送）

```
你是一名 Cloudflare Workers 部署专家。我要部署 cf-panel——一套跑在 Cloudflare Workers 上的个人面板系统。


仓库根目录有 README.md（功能介绍）和 DEPLOY.md（部署指南），请先读这两份文件。
workers/ 下有 6 个 Worker，每个目录包含 worker.js（源码）和 wrangler.toml（配置）：
- portal：入口工作台（登录/2FA），对外绑定自定义域名
- admin：管理后台
- status：状态监控，每 5 分钟巡检（cron: */5 * * * *）
- cfnext：VLESS/Trojan/SS 代理面板
- drive：网盘（文件存在我自己的 GitHub 私有仓库）
- otp-panel：Outlook 邮箱验证码读取（每天 03:17 的 cron 自动轮换微软 token）


带我一步步完成部署。规则：
1. 一次只做一步，每步说清楚要做什么、为什么、具体命令是什么，做完等我确认再继续。
2. 需要我提供的信息（比如 Cloudflare 账户、域名、各类 ID、密钥）要逐个问，并告诉我去哪里找、格式是什么。
3. 每个 secret 都要解释它是干嘛的。SVC_KEY 这个密钥 5 个 Worker 共用同一个值，提醒我只生成一次。
4. 部署顺序必须是：cfnext → drive → otp-panel → status → admin → portal（service binding 要求被引用的先存在）。
5. wrangler.toml 里的 YOUR_*_ID 占位符（KV/D1/Zone ID）帮我确认填对。
6. 微软 OAuth 应用（MS_CLIENT_ID + MS_REFRESH_TOKEN）、GitHub Token（GH_TOKEN）、Turnstile 这三处第三方配置，单独作为步骤，手把手教我申请。
7. 最后帮我验证：域名能打开、工作台能登录、/status 里四个项目都是绿色。
8. 不要编造命令或 API；不确定就查 wrangler 官方文档或问我。

先从第 0 步开始：检查我的本地环境（wrangler 是否安装、是否登录、Node 版本），然后问我要 Cloudflare 账户和域名信息。
```

---

## English Prompt (copy everything below and send)

```
You are a Cloudflare Workers deployment expert. I want to deploy cf-panel — a self-hosted personal panel system running on Cloudflare Workers.

[PROJECT STRUCTURE]
Read README.md (features) and DEPLOY.md (deploy guide) in the repo root first.
workers/ contains 6 workers, each with worker.js (source) and wrangler.toml (config):
- portal: entry workbench (login/2FA), gets the custom domain
- admin: admin dashboard
- status: monitor, health checks every 5 min (cron: */5 * * * *)
- cfnext: VLESS/Trojan/SS proxy panel
- drive: file drive (files live in my own private GitHub repo)
- otp-panel: Outlook verification-code reader (daily 03:17 cron rotates the Microsoft token)

[YOUR TASK]
Walk me through the deployment step by step. Rules:
1. One step at a time: explain what to do, why, and the exact commands. Wait for my confirmation before moving on.
2. Ask for each piece of info you need (Cloudflare account, domain, IDs, keys) one by one, and tell me where to find each and what format it has.
3. Explain what every secret is for. SVC_KEY is shared across 5 workers — remind me to generate it only once.
4. Deploy in this order: cfnext → drive → otp-panel → status → admin → portal (service bindings require targets to exist first).
5. Help me verify every YOUR_*_ID placeholder (KV/D1/Zone IDs) in the wrangler.toml files is filled correctly.
6. Treat the three third-party setups as dedicated steps and walk me through each: Microsoft OAuth app (MS_CLIENT_ID + MS_REFRESH_TOKEN), GitHub token (GH_TOKEN), Turnstile.
7. Verify at the end: domain loads, workbench login works, all four services are green on /status.
8. Never invent commands or APIs; check the official wrangler docs or ask me when unsure.

Start with step 0: check my local environment (is wrangler installed and logged in? node version?), then ask me for my Cloudflare account and domain info.
```

---

## 给 AI 助手的补充说明（可选读）

如果你是被上面提示词唤起的 AI 助手，补充几点项目细节，帮你带得更顺：

1. **wrangler.toml 里的 secrets 清单**：每个 `workers/*/wrangler.toml` 头部注释都列了该 Worker 需要的 secrets，一一对照 `wrangler secret put` 即可，不要漏。
2. **KV / D1 创建命令**：
`wrangler kv namespace create <NAME>`、`wrangler d1 create panel-log`。D1 表结构由 Worker 首次运行时自动创建，不用手动建表。
3. **微软 OAuth**：Azure Portal 注册应用，重定向 URI 用 `https://login.microsoftonline.com/common/oauth2/nativeclient`，权限 `Mail.Read` + `offline_access`（Delegated），scope 带 `https://graph.microsoft.com/Mail.Read offline_access` 换 refresh token。
4. **drive 的仓库**：`workers/drive/worker.js` 顶部 `OWNER` / `REPO` 两个常量先改成用户自己的 GitHub 用户名和私有仓库名（仓库需先建好，main 分支）。
5. **cfnext 的 U**：`wrangler.toml` 里 `[vars] U` 换成用户自己的 UUID（`uuidgen` 生成），它同时是面板 URL 路径。
6. **域名绑定**：在 Cloudflare 后台 → Workers → `portal` → Settings → Domains & Routes 里加自定义域名；其余 5 个 Worker 不需要公网域名。
7. **验证清单**：域名返回 200（登录页）→ 用 PASSWORD 登录 → `/2fa/setup` 绑 TOTP → `/status` 四项全绿 → cfnext 面板路径首次访问设置管理密码。
