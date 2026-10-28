# HANDOFF: cfnext lazy entry + status probe details

分支 `fix/cfnext-lazy-entry`（未合并到 main）。

## 变更
1. `workers/cfnext/entry.js`（新增）：入口包装，首个请求时才 `import('./worker.js')`，避免把 6500 行的 worker.js 放进启动阶段。
   `workers/cfnext/wrangler.toml` 的 `main` 改为 `entry.js`（worker.js 本身未改）。
2. `workers/status/worker.js`：CFNEXT 探测失败时把详情写入 LOG KV：
   - `probe_last`：最近一次失败 `{t, code, ms, up, cat, en}`
   - `probe_fail`：最近失败列表（最新在前，最多 20 条）
   - 只记录错误名 (`en`) 和固定分类 (`cat`: `timeout` / `script_killed` / `worker_exception` / `limit_exceeded` / `other` / `http_<code>` / `bad_body`)，不记录 message / stack / 密钥。
   - 节流：code/分类不变时 15 分钟内不重复写（控制 KV 写入额度）。

## 已知问题（重要）
- 生产上新部署的 cfnext 副本通过 service binding 调用时返回 `Error: This script has been killed.`（status 已记录到 `probe_fail`，
  分类 `script_killed`）。这是 Cloudflare 平台侧停用脚本，不是代码异常，本地 miniflare 下同样代码正常（/version 200、面板路径 200）。
  改代码/重新部署无法解决，需要在 Cloudflare 控制台 / 工单确认停用原因。

## 回滚
- status：把部署切回上一版本（版本 ID 见操作记录），`POST /workers/scripts/status/deployments` 100%。
- cfnext：使用旧 `main = "worker.js"` 即可。
