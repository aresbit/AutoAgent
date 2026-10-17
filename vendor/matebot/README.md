# MateBot

飞书上的 Claude Code 代理 + 小书童个人助理。

## 功能概览

| 组件 | 说明 | 入口 |
|------|------|------|
| **Feishu Bridge** | 交互式飞书 Bot，把 Claude Code 桥接到飞书对话，支持流式卡片渲染 | `./start_bridge.sh` |
| **小书童 Agent** | cron 一天三次从飞书工作聊天提取待办/风险，用 OpenCC 分类后发飞书卡片 | `xiaoshutong/xiaoshutong_run.sh` |

---

## Feishu Bridge

交互式飞书 Bot，轮询飞书消息 → 调用 OpenCC (Claude Code) 子进程 → 流式输出到飞书卡片。

### 架构

```
飞书消息 (长轮询)          OpenCC 子进程（每 chat 一个，常驻）
     │                           │
     ▼                           ▼
feishu_api.py  ────────►  feishu_bridge.py  ────────►  feishu_renderer.py
(token 管理/轮询/发送)     (消息桥接/命令路由)       (流式卡片渲染/编辑)
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              soul.py      session_store.py  memory.py
           (身份 workspace)  (session_id 落盘)  attention_manager.py
                                              failure_memory.py
```

- **Spawn 模式**（默认）：OpenCC 子进程 `stream-json` 直连，token 级流式输出，飞书卡片原地编辑
- **tmux 模式**（回退）：tmux 多路复用 + transcript 轮询

### 长连接与记忆持久化

三层，缺一层记忆就断一截：

| 层 | 机制 | 活多久 |
|----|------|--------|
| 进程内 | 一个 chat 一个常驻子进程，多轮共用 stdin | 到进程退出 |
| 跨进程 | `session_id` 落盘 `~/.matecode/sessions/`，重启用 `--resume` 续上 | 到 `/clear` |
| 跨会话 | `workspace/` 身份文件 + `memory/YYYY-MM-DD.md` 日记 | 永久 |

要点：

- **一个 chat 只应该 spawn 一次**。`/status` 里的 `Spawns:` 计数就是给你看这个的 ——
  它每条消息 +1，说明进程在反复重启，长连接没生效。
- CLI 路径按 `opencc_cli_path` → `OPENCC_CLI_PATH` → `vendor/opencc/dist/cli.js` →
  `~/.local/share/opencc/cli.js` → `~/.opencc/cli.js` 依次查找，全找不到就在启动时
  直接报错退出，不会拿一个跑不起来的路径反复 spawn。
- `--resume` 前会先检查 transcript 文件在不在；不在就干脆开新会话，
  而不是让 CLI 起来又立刻挂掉。

### Agent Workspace（SOUL.md）

仿 [OpenClaw](https://docs.openclaw.ai/concepts/agent-workspace) 的做法：人格不写在代码里，
写成纯文本文件，spawn 时用 `--append-system-prompt` 一次性注入。因为进程常驻，
这份身份**每个会话只付一次 token**，不像塞进每轮 user prompt 那样反复计费、还会被
模型当成用户的临时要求。

```
workspace/
├── SOUL.md      人格、语气、底线          ← 最稳定，放最前
├── IDENTITY.md  名字、称呼、自我介绍
├── USER.md      关于你的长期事实
├── AGENTS.md    工作方式、记忆约定、安全
├── TOOLS.md     本机特有工具入口
├── MEMORY.md    精炼后的长期记忆
└── memory/
    └── YYYY-MM-DD.md   当天流水（每轮自动追加）  ← 最易变，放最后
```

注入顺序从稳定到易变，稳定的排前面抢注意力。文件缺了不报错，只留一个标记；
超过 `soul_max_chars`（默认 20000）会截断并**显式标注**（OpenClaw 是静默截断，
长文件出问题很难查，这里改成可见的）。

改完文件后进程里的旧身份不会自动变 —— 用 `/reload_soul` 重启进程应用新身份，
会话本身通过 `--resume` 保留。`/soul` 可以查看当前加载了哪些文件、多大、指纹是否漂移。

### 快速开始

```bash
# 1. 配置凭据
cp feishu_config.yaml.example feishu_config.yaml
# 填入 FEISHU_APP_ID / FEISHU_APP_SECRET（或用环境变量）

# 2. 启动
./start_bridge.sh
```

> `./start_bridge.sh` / `./stop_bridge.sh` 现在把 bridge 托管为 **systemd user 服务**
> （`matebot-bridge.service`，自动重启 + 开机自启，日志 `journalctl --user -u matebot-bridge -f`）。
> 前台手动调试仍可用 `python3 feishu_bridge.py`。

### 配置

`feishu_config.yaml` 关键字段：

| 字段 | 说明 |
|------|------|
| `chat_id` | Bot 与用户的 P2P chat_id（留空自动发现） |
| `user_open_id` | 飞书用户 Open ID（用于自动发现 P2P chat） |
| `poll_interval_sec` | 轮询间隔（秒，默认 5） |
| `opencc_spawn_mode` | 优先 spawn 模式（默认 true） |
| `opencc_cli_path` | OpenCC CLI 路径（留空按上面的顺序自动检测） |
| `opencc_prewarm` | 启动时预热子进程（默认 true） |
| `soul_enabled` | 启用 workspace 身份注入（默认 true） |
| `workspace_dir` | workspace 目录（留空 = `<repo>/workspace`） |
| `soul_max_chars` | 单个身份文件字符上限（默认 20000） |
| `soul_daily_notes` | 每轮追加日记到 `memory/YYYY-MM-DD.md`（默认 true） |
| `desktop_notify` | 桌面弹窗通知（notify-send） |

环境变量优先级最高，其次 `feishu_config.yaml`，最后默认值。

### Bot 命令

| 命令 | 功能 |
|------|------|
| `/status` | 会话状态：进程存活、session_id、spawn 次数、CLI 路径 |
| `/soul` | 查看 workspace 身份文件清单与大小 |
| `/reload_soul` | 重载身份文件（重启进程，保留会话） |
| `/clear` | 清空会话（同时丢弃落盘的 session_id） |
| `/continue_` | 继续最近会话 |
| `/resume` | 选择历史会话恢复 |
| `/stop` | 中断当前生成 |
| `/remember <text>` | 保存记忆 |
| `/recall [query]` | 搜索记忆 |
| `/forget <query/all>` | 删除记忆 |

### 记忆系统

| 模块 | 文件 | 用途 |
|------|------|------|
| 会话续接 | `session_store.py` | `chat_id → session_id` 落盘，重启 `--resume` |
| 身份/日记 | `soul.py` | workspace 身份文件 + 每日流水 |
| 自动记忆 | `memory.py` | SQLite FTS5 自动提取 + 智能召回 |
| 外部记忆 | `external_memory.py` | 外部知识注入 |
| 失败记忆 | `failure_memory.py` | 错误模式学习 |
| 注意力管理 | `attention_manager.py` | Manus 式注意力重定向，防止目标漂移 |
| KV-Cache | `kv_cache.py` | 复用上下文减少 token 消耗 |

---

## 小书童 Agent

个人助理：一天三次（10:30 / 16:30 / 22:30）自动梳理飞书工作聊天，提取待办、挖掘风险，发飞书卡片。

### 部署（一天三次，**不是**每小时跑一次）

调度用 crontab，每天跑三次（10:30 / 16:30 / 22:30），每次窗口约 6 小时：

```bash
PATH=/home/pc/.bun/bin:/usr/local/bin:/usr/bin:/bin
30 10,16,22 * * * /bin/bash <REPO>/xiaoshutong/xiaoshutong_run.sh >> <REPO>/xiaoshutong/data/cron.log 2>&1
```

完整搭建步骤（飞书应用创建、权限申请、OAuth 授权、LLM 模型推荐 **deepseek-v4-flash**、
vendor opencc 编译、crontab、排障）见 **[`xiaoshutong/DEPLOY.md`](xiaoshutong/DEPLOY.md)**。

**智能层依赖 vendored opencc（claude-js）**：仓库里 `vendor/opencc` 是 gitlink
（无 `.gitmodules` 条目），fresh clone 后是空目录，必须自己 vendor 并编译：

```bash
git clone https://github.com/claude-code-best/claude-code vendor/opencc
cd vendor/opencc && bun install && bun run build   # 产出 dist/cli.js（bun >= 1.2.0）
```

`config.yaml` 的 `claude_cli` **留空**走自动检测（`vendor/opencc/dist/cli.js` 优先）。

### 架构

```
系统 crontab (30 10,16,22 * * *)
   │
   ▼ xiaoshutong_run.sh
   ① python3 feishu_fetch.py        ← 数据层（零 token）
      user_access_token 增量读群聊+私聊 → SQLite → data/latest.md
   ② bun vendor/opencc/dist/cli.js -p "..."   ← 智能层（headless）
      读 latest.md → 分类待办(3类)/风险(4类)
      → 更新 todos.md/risks.md/digests/ → feishu_send.py 发卡片
```

数据层（Python，OAuth user token）与智能层（OpenCC headless）分离：
抓取便宜可靠、分类用 LLM。每次 cron 开全新 headless 会话，
靠 memoryTrigger 自动注入 SCRATCHPAD 获得上次进展，实现跨小时接力。

### 待办表（就五列）

```
| 范畴 | 事项 | 提出人 | 时间 | 备注 |
```

| 列 | 取值规则 |
|------|----------|
| 范畴 | `未回复` / `已承诺` / `主动答应` |
| 事项 | 一句话说清做什么；点名到你的，末尾加 `（点名我）` |
| 提出人 | **谁发的那条消息就是谁**，查不到的留空白 |
| 时间 | `MM-DD HH:MM`（跟踪文件里带日期；报告里只显示 `HH:MM`） |
| 备注 | 打钩用的：写 `✅` 就算完成，此后不再出现在任何报告里 |

没有「指派」列 —— 是不是点名你，靠事项末尾的 `（点名我）` 表达，一列顶两列。
判定不靠 LLM 猜：`feishu_fetch.py` 在抓取时就用 `mentions` 字段和别名
（ares / aresyang / 杨阳）算好，在 `latest.md` 里打 `【@我】` 标记。

**报告范围很窄**：`latest.md` 只保留「点名到我 / 我发的 / 私聊 / 含@提及」的消息，
泛泛讨论、没人被点名的不进快照。窗口严格从上次游标到当前，游标太老时最多回溯
`fetch_hours`(6h) —— **昨天的旧消息不进窗口**，也不占报告。`todos.md`/`risks.md`
每轮开头逐出「时间」不是今天的行，旧待办提醒最多 3 条，绝不写「另有 N 条见 data/todos.md」。

**提出人为什么曾经是 `ou_405eac73ea`**：飞书 `im/v1/messages` 的 `sender` 对象
**不带 name**，老代码回退成截断 open_id。现在改为用 `im/v1/chats/:id/members`
（沿用已有的 `im:chat:read` scope，无需重新授权）建 open_id → 名字缓存存进
SQLite `users` 表；`mentions` 里带的名字也顺手入库。仍查不到的**留空白**，
不写 `未知同事(ou_xxx)`，不让 id 冒充人名。

**打钩机制**：编辑 `data/todos.md` 把 `⬜` 改 `✅`，或在聊天里说「X已完成」。
`✅` 的条目此后不再出现在任何报告表格里。bot 还会主动推断「没人明说但其实做完了」的
情况（对方道谢、贴了 MR、话题翻篇），有证据才打钩。

**为什么卡片不再分页**：飞书 table 组件 `page_size` 上限是 10，行数一超右下角就出现
`1/2`。`feishu_send.py` 硬截到 10 行（旧待办提醒 prompt 限 3 行），且**不补**
「另有 N 条见 data/todos.md」那行字。

### 配置

`xiaoshutong/config.yaml`：

| 字段 | 说明 |
|------|------|
| `claude_cli` | OpenCC CLI 路径（**留空自动检测**，别写绝对路径） |
| `fetch_hours` | 每次拉取窗口；也是增量上限（游标太老时最多回溯，默认 6h） |
| `initial_backfill_hours` | 首跑回填窗口（默认 24h） |
| `send_chat` | 发送目标 chat_id（留空用 `FEISHU_CHAT_ID` 环境变量） |
| `chat_filters` | 会话过滤（include/exclude 关键词） |

### OAuth 授权

```bash
cd xiaoshutong
python3 feishu_auth.py --print-url   # 打印授权链接，浏览器打开完成授权
# token 存 ~/.xiaoshutong/tokens.json，refresh 30 天，UserTokenManager 自动刷新
```

OAuth scope: `offline_access im:chat:read im:message:readonly
im:message.p2p_msg:get_as_user im:message.group_msg:get_as_user search:message`

### 运维命令

```bash
cd xiaoshutong
python3 feishu_fetch.py              # 手动增量抓取
python3 feishu_fetch.py --hours 24  # 回填 24 小时
bash xiaoshutong_run.sh             # 手动跑一次完整链路
tail -50 data/runs.log              # 查看运行日志
```

### 记忆系统

- `~/.claude/projects/<仓库根路径，/ 和 . 换成 ->/memory/SCRATCHPAD.md` — 临时记忆，
  memoryTrigger 自动注入下一次 headless 会话，格式 `[小书童待办进展 <日期> <时间>]` + 五行。
  路径按仓库位置变，算法：``echo ~/.claude/projects/"$(git rev-parse --show-toplevel | tr './' '--')"/memory``
- `data/todos.md` — 待办跟踪表（持久）
- `data/risks.md` — 风险跟踪表
- `data/digests/<YYYY-MM-DD>.md` — 每日摘要

---

## 文件结构

```
MateBot/
├── feishu_bridge.py          # Feishu Bridge 主程序
├── feishu_api.py             # 飞书 API（token/轮询/发送）
├── feishu_renderer.py        # 流式卡片渲染
├── feishu_config.py          # 配置加载
├── feishu_config.yaml.example
├── opencc_backend.py         # OpenCC 常驻子进程管理（路径解析/生命周期/resume）
├── soul.py                   # Agent workspace 加载器（SOUL.md 等）
├── session_store.py          # chat_id → session_id 持久化
├── workspace/                # 身份文件（SOUL/IDENTITY/USER/AGENTS/TOOLS/MEMORY）
├── memory.py                 # 自动记忆（SQLite FTS5）
├── external_memory.py        # 外部记忆注入
├── failure_memory.py         # 失败记忆
├── attention_manager.py      # 注意力管理
├── kv_cache.py               # KV-Cache 优化
├── start_bridge.sh / stop_bridge.sh
├── vendor/opencc/            # OpenCC dist（Claude Code CLI）
├── hooks/                    # Claude Code 钩子
├── skills/                   # Claude Code 技能
└── xiaoshutong/              # 小书童 Agent
    ├── agent_prompt.md       # Agent 角色指令 + 分类规则
    ├── DEPLOY.md             # 部署指南（飞书权限/OAuth/模型/vendor 编译/cron）
    ├── feishu_fetch.py       # 数据层：增量抓取 → latest.md
    ├── feishu_send.py       # 发送层：markdown → 飞书卡片
    ├── feishu_auth.py        # OAuth 授权
    ├── feishu_user_api.py    # user_access_token 客户端
    ├── config.py / config.yaml
    ├── xiaoshutong_run.sh    # cron 入口
    ├── SKILL.md              # 架构/运维知识库
    └── data/                 # SQLite + latest.md + todos.md + digests/
```

## 技术栈

- **运行时**：Python 3（**uv 管理**，`.venv`）+ Bun（OpenCC CLI）
- **飞书 API**：httpx 直连，bot token（卡片发送）+ user OAuth token（消息读取）
- **多媒体**：图片 OCR（下载→模型 Read）、**语音转写（本地 SenseVoice，中文优先）**、
  文件下载、视频抽帧（静态 `~/bin/ffmpeg`，无需 sudo）
- **智能层**：OpenCC (Claude Code) headless 会话，stream-json I/O
- **卡片**：飞书 v2 卡片，markdown 表格转原生 table 组件
- **记忆**：SQLite FTS5 + 文件系统分层存储
- **调度**：系统 crontab（小书童）/ systemd user 服务（bridge）

## License

MIT
