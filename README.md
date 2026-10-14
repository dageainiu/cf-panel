# cf-panel

一套跑在 Cloudflare Workers 上的个人面板系统：工作台登录、代理面板、邮箱验证码、网盘、安全监控、管理后台，开箱即用。

```
你 → https://panel.example.com (portal, 登录 + 2FA)
       ├─ service→ cfnext     VLESS/Trojan/SS 代理管理面板
       ├─ service→ otp-panel  验证码（读 Outlook 邮件，自动翻译 + 最新码）
       ├─ service→ drive      网盘（文件存在你的私有 GitHub 仓库）
       ├─ service→ status     状态监控（每 5 分钟巡检，异常邮件告警）
       └─ service→ admin      管理后台（令牌、审计、代理仪表盘、配置版本）
                ↘ D1 panel-log + 2 个 KV 命名空间
```

## 功能一览

| Worker | 功能 |
|---|---|
| `portal` | 入口 / 工作台：密码 + TOTP 两步登录、访客只读订阅链接、各功能跳转 |
| `admin` | 令牌管理、审计日志、代理节点仪表盘、CFNext 配置版本（一键回滚） |
| `status` | 项目在线状态、5 分钟巡检、离线/恢复邮件告警、可疑 IP 记录、域名健康检查 |
| `cfnext` | 代理管理面板：VLESS/Trojan/Shadowsocks、订阅签发、优选 IP、出站设置 |
| `drive` | 私人网盘：小文件存你自己的 GitHub 私有仓库 |
| `otp-panel` | 邮箱验证码：轮询 Outlook，按发件人/关键词提取验证码，多语言翻译 |

## 快速开始

完整部署步骤见 **[DEPLOY.md](DEPLOY.md)**。大致流程：

1. 准备 Cloudflare 账户 + 一个域名，创建 3 个 KV 和 1 个 D1。
2. 填好 6 个 `wrangler.toml` 里的 ID 占位符。
3. `wrangler secret put` 设置各 Worker 的密钥（清单在每个 `wrangler.toml` 顶部注释里）。
4. 依次 `wrangler deploy`，给 `portal` 绑定自定义域名。
5. 登录工作台，逐项配置（微软 OAuth、GitHub Token、Turnstile 等见 DEPLOY.md）。

## 仓库结构

```
workers/
  portal/       worker.js + wrangler.toml
  admin/        worker.js + wrangler.toml
  status/       worker.js + wrangler.toml
  cfnext/       worker.js + wrangler.toml
  drive/        worker.js + wrangler.toml
  otp-panel/    worker.js + wrangler.toml
DEPLOY.md       从零部署指南
LICENSE         MIT
```

## 说明

- 仓库里**没有任何真实密钥**：所有凭据都通过 Worker secrets / vars / bindings 注入，代码里只有占位符。
- `panel.example.com` 是占位域名，部署时换成你自己的。
- D1 表结构由各 Worker 首次运行时自动创建（`CREATE TABLE IF NOT EXISTS`），无需手动建表。

## License

MIT
