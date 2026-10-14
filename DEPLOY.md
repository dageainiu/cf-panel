# DEPLOY.md — 从零部署指南

> 预计用时 30–60 分钟。前置：一个 Cloudflare 账户、一个已接入 Cloudflare 的域名、本地装好 `wrangler` 并 `wrangler login`。

## 0. 准备资源

```bash
# 3 个 KV 命名空间
wrangler kv namespace create CFNEXT_KV
wrangler kv namespace create OTP_KV
wrangler kv namespace create STATUS_KV

# 1 个 D1 数据库
wrangler d1 create panel-log
```

把返回的 ID 填进各 `workers/*/wrangler.toml`，替换 `YOUR_KV_*_ID` / `YOUR_D1_ID` / `YOUR_CF_ZONE_ID`。
`YOUR_CF_ACCOUNT_ID` 在 `wrangler whoami` 里能看到（status Worker 里个别管理功能用）。

## 1. 生成内部密钥

```bash
# 32 字节随机串，portal/admin/status/drive/otp-panel 的 SVC_KEY 必须用同一个值
SVC=$(openssl rand -hex 32); echo $SVC
```

## 2. 部署顺序（service binding 要求被引用的先存在）

```bash
cd workers/cfnext
# 先在 wrangler.toml 里把 U 换成你自己的 UUID（uuidgen 生成一个）
wrangler deploy

cd ../drive && wrangler deploy
cd ../otp-panel && wrangler deploy
cd ../status && wrangler deploy
cd ../admin && wrangler deploy
cd ../portal && wrangler deploy
```

## 3. 设置 Secrets

```bash
# portal
cd workers/portal
wrangler secret put PASSWORD            # 工作台登录密码
wrangler secret put SESSION_SECRET      # openssl rand -hex 32
wrangler secret put SVC_KEY            # 第 1 步生成的 $SVC
wrangler secret put ADMIN_SVC_KEY       # 再生成一个随机串
wrangler secret put TOTP_KEY           # openssl rand -hex 32（2FA 加密用）
wrangler secret put TURNSTILE_SECRET    # Cloudflare Turnstile 后台申请
wrangler secret put PANEL              # 代理面板路径回退值，可留空

# admin
cd ../admin
for k in SVC_KEY ADMIN_RO_TOKEN CONFIG_KEY CSRF_KEY OUTBOUND_POOL_KEY; do wrangler secret put $k; done
# OUTBOUND_POOL_JSON 为空 JSON {} 即可，有出站代理再按格式填

# status
cd ../status
for k in SVC_KEY CF_ANALYTICS_TOKEN CI_REPORT_KEY CI_WRITE_KEY CONFIG_KEY GUARD_TOKEN OUTBOUND_POOL_KEY; do wrangler secret put $k; done
# OUTBOUND_POOL_JSON 同上

# drive
cd ../drive
wrangler secret put GH_TOKEN   # 推荐 fine-grained PAT（单仓库 Contents: Read and write），见下方说明
wrangler secret put SVC_KEY    # 同 $SVC

# otp-panel
cd ../otp-panel
wrangler secret put SVC_KEY           # 同 $SVC
wrangler secret put MS_REFRESH_TOKEN  # 见第 4 步
```

**GH_TOKEN（drive 网盘用）——推荐 fine-grained PAT，最小权限：**
1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token；
2. Repository access 选 "Only select repositories"，只勾你的私有网盘仓库；
3. Permissions → Repository permissions → **Contents** 设为 **Read and write**（drive 只调 Contents API 和 Git Database API——读文件/列表要 read，建 blob、tree、commit，更新 ref，删除文件要 write；fine-grained 下 Git Database 同样归 Contents 管）；
4. 设个有效期（如 90 天），到期前重新生成并 `wrangler secret put GH_TOKEN` 轮换。

兼容方案：classic PAT（`repo` scope）也能用，但能读写你名下所有仓库，权限更宽——建议同样设有效期、定期轮换。

## 4. 微软 OAuth（验证码功能用）

1. 到 [Azure Portal](https://portal.azure.com) 注册一个应用（个人 Microsoft 账户可用）：
   - 重定向 URI：`https://login.microsoftonline.com/common/oauth2/nativeclient`
   - API 权限：`Mail.Read`、`offline_access`（Delegated）
2. 用 OAuth code 流程拿一次 refresh token（scope 带 `https://graph.microsoft.com/Mail.Read offline_access`）。
3. 把 refresh token 写入 `MS_REFRESH_TOKEN`，client ID 填进 `otp-panel/wrangler.toml` 的 `MS_CLIENT_ID` 后重新 deploy。
4. 之后每天 03:17（cron）的定时任务会自动轮换，refresh token 永不过期。

## 5. 绑定域名

在 Cloudflare 后台 → Workers → `portal` → Settings → Domains & Routes → Add Custom Domain，填你的域名（如 `panel.example.com`）。其他 Worker 不需要公网域名，走 service binding 互调。

## 6. 收尾检查

1. 打开你的域名，应该看到工作台登录页。
2. 用 `PASSWORD` 登录，进 `/2fa/setup` 绑定 TOTP。
3. 打开 `/status`（安全监控），确认 cfnext / drive / otp 都是绿色。
4. cfnext 面板：访问 `https://<你的cfnext地址>/<U>`，首次访问设置管理密码。

## 常见问题

- **otp 显示"读取邮箱失败"**：`MS_REFRESH_TOKEN` 或 `MS_CLIENT_ID` 不对，重新走第 4 步。
- **status 巡检 530/超时**：被探测的 Worker 可能冷启动，多等一个周期；drive 需要 `GH_TOKEN` 有效。
- **忘记工作台密码**：`wrangler secret put PASSWORD` 重设即可。
