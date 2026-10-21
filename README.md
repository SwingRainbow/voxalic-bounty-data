# voxalic-bounty-data

VoxAlic 赏金窗口观测采集器（研究用）。每 150 分钟一个窗口，自动记录：

- 官方 `worldState.php`：`EntratiLabSyndicate` 的 `Activation / Expiry / Seed`，以及 Cetus / Solaris / Entrati 的 `Jobs` 类型列表（同窗口比对用）。
- 社区 `https://oracle.browse.wf/bounty-cycle`：扎里曼 / 解剖圣所 / 六人组的 `node` 与 `challenge`（按档位顺序）。

目的：验证「同一 Seed 是否决定任务类型序列」，并为 Seed→类型的算法搜索积累样本。**不涉及 VoxAlic 源码，也不携带任何凭据。**

## 文件

- `collector.mjs`：采集脚本。发现新窗口才追加一行到 `data/bounty-cycles.jsonl`（重复运行幂等）。
- `.github/workflows/collect.yml`：每 10 分钟运行一次；有新记录才提交，没有则跳过。
- `data/bounty-cycles.jsonl`：采集结果（UTF-8，每行一个窗口）。
- `data/last-error.log`：最近一次失败的错误与出口 IP；成功后自动删除。

## 本地试跑

```bash
node collector.mjs --dry-run   # 只打印，不写文件
node collector.mjs             # 写入 data/
```

当前窗口的有效数据示例（字段说明）：

- `window.activation` / `window.expiry`：官方窗口起止（Unix 毫秒）。
- `window.seed`：本窗口的全局 Seed（`EntratiLabSyndicate` 的值）。
- `window.seeds`：各派系各自记录的 Seed（部分派系会比主 Seed 小 1，属于观测事实）。
- `oracle.bounties`：三派系按档位的节点与挑战路径。
- `jobs`：Cetus / Solaris / Entrati 本窗口的 `jobType` 列表。
- `window.source`：`direct` 表示直连官方 CDN，`relay:...` 表示经公共中继取到官方原文。

## 部署步骤

1. 在 GitHub 新建一个 **public** 仓库（例如 `voxalic-bounty-data`），不要勾选 README / .gitignore / license，保持空仓库。
2. 在本机这个目录执行：

   ```bash
   git init
   git add .
   git commit -m "init bounty cycle collector"
   git branch -M main
   git remote add origin https://github.com/<你的账号>/voxalic-bounty-data.git
   git push -u origin main
   ```

3. 打开仓库 **Settings → Actions → General → Workflow permissions**，选择 **Read and write permissions** 并保存（否则提交步骤会 403）。
4. 到 **Actions → collect-bounty-cycle → Run workflow** 手动跑一次，确认日志里出现 `recorded:` 或 `skip:` 而不是报错。
5. 之后不用管：每 10 分钟自动轮询，窗口变化时自动提交一条数据。

## 注意

- 公开仓库的 Actions 分钟数不限；私有仓库每月 2000 分钟，按 10 分钟轮询会接近上限，所以建议 public。
- 如果日志出现 `HTTP 403`，通常是 DE 官方 CDN 拒绝了云端机房 IP（本项目实测 Azure 出口被拒）。`collector.mjs` 会先试官方与 `content.warframe.com`，再退回公共中继 `https://r.jina.ai/https://api.warframe.com/cdn/worldState.php` 读取同一份官方数据，记录里的 `window.source` 会标明来源。
- Oracle 的 `/bounty-cycle` 对云端开放；`oracle.browse.wf/worldState.json` 同样会 403，不要依赖它取 Seed。
- `api.warframestat.us` 虽然对云端开放，但响应里没有 `Seed` 字段，不能替代官方原文。
- 定时任务若 60 天内仓库无活动会被 GitHub 暂停；本项目持续提交数据，不会触发。
- 数据全是公开游戏数据（节点 ID、挑战路径、Seed），不含个人信息。
- 想停止采集：在 Actions 页面禁用 `collect-bounty-cycle` 工作流，或直接删除仓库。
