# 小书童部署指南

一天三次（10:30 / 16:30 / 22:30）从你的飞书工作聊天里提取待办、挖掘风险，
整理成表格发飞书卡片。本文从零开始讲怎么搭，覆盖：飞书应用创建与权限、OAuth 授权、
LLM 模型（推荐 deepseek-v4-flash）、vendor opencc 编译、crontab 调度、排障。

> 一份可用实例的权限页：`https://open.feishu.cn/app/<你的 APP_ID>/auth`
> （本仓库已配置的实例是 `https://open.feishu.cn/app/cli_aadd8a532cb69bdb/auth`）。

---

## 0. 整体架构

```
系统 crontab (30 10,16,22 * * *)      ← 一天三次，不是每小时
   │
   ▼ xiaoshutong_run.sh
   ① python3 feishu_fetch.py           ← 数据层（零 token）
      用 user_access_token 增量读群聊+私聊 → SQLite → data/latest.md
   ② bun vendor/opencc/dist/cli.js -p  ← 智能层（headless LLM，推荐 deepseek-v4-flash）
      读 latest.md → 分类待办/风险 → 更新 todos.md/risks.md/digests/ → feishu_send.py 发卡片
```

两套飞书凭据，各管一半：

| 凭据 | 身份 | 用途 |
|------|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 应用（bot） | 发卡片（`feishu_send.py` 用 bot token） |
| OAuth `user_access_token` | 你本人 | 读聊天（`feishu_fetch.py` 用用户身份增量读群聊/私聊） |

---

## 1. 创建飞书应用（企业自建）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**，填名称（如「小书童」）与图标。
2. 拿到 **App ID**（形如 `cli_xxxxxxxx`）和 **App Secret**，后面导出为环境变量。
3. **安全设置 → 重定向 URL** 添加：`http://localhost:8765/callback`（OAuth 回调用，端口与 `feishu_auth.py --port` 一致）。

---

## 2. 申请权限

权限分两半：**读侧**（以你的身份 OAuth 授权）与**发送侧**（以 bot 身份）。

### 发送侧（bot 需要，必开）

| 权限 scope | 开放平台上对应的权限名称 | 用途 |
|-----------|--------------------------|------|
| `im:message` | 获取与发送单聊、群组消息 | 发互动卡片（`POST /im/v1/messages`） |

> 若只想发不想读，可只开 `im:message:send_as_bot`（以应用的身份发消息）。

### 读侧（OAuth 授权时请求，对应 `feishu_auth.py` 的 `DEFAULT_SCOPE`）

| 权限 scope | 开放平台上对应的权限名称 | 用途 |
|-----------|--------------------------|------|
| `offline_access` | 获取 refresh_token | 换/续期 user_access_token（30 天） |
| `im:chat:read` | 获取群组信息 | 列会话、群成员 open_id→名字缓存 |
| `im:message:readonly` | 获取会话历史消息（只读） | 读消息正文 |
| `im:message.p2p_msg:get_as_user` | 获取用户发给机器人的单聊消息 | 读私聊 |
| `im:message.group_msg:get_as_user` | 获取群组中所有消息 | 读群聊 |
| `search:message` | 搜索消息 | 按关键词回查（可选） |

权限页：`https://open.feishu.cn/app/<APP_ID>/auth`。企业自建应用的权限一般需要
**发布版本**（「版本管理与发布」）或管理员审批后才生效。

> 本工程是**轮询**读取（`GET /im/v1/messages`），**不需要**配置事件订阅 / 长连接回调。

### 让机器人能给你发消息

`FEISHU_CHAT_ID` 是发送目标 chat_id，取法任选其一：

- 在飞书里**单聊机器人**（在机器人 Tab 里把它添加为联系人 / 或直接和机器人会话），
  用下面命令列出会话找到与机器人的 P2P chat_id；
- 或把机器人拉进一个群，用该群 chat_id 作为 `FEISHU_CHAT_ID`（报告发群里）。

```bash
cd xiaoshutong
# 先导出凭据，再列会话，找到机器人所在会话的 chat_id
export FEISHU_APP_ID=... FEISHU_APP_SECRET=...
python3 -c "import sys; sys.path.insert(0,'.'); from config import load_config; from feishu_user_api import UserTokenManager, list_chats; cfg=load_config(); tm=UserTokenManager(cfg.feishu_app_id,cfg.feishu_app_secret,cfg.token_file); [print(c['chat_id'], c['name']) for c in list_chats(tm)]"
```

---

## 3. 配置环境变量（~/.zshrc）

`xiaoshutong_run.sh` 在 cron 下会从 `~/.zshrc` 里 `grep '^export (FEISHU_|ANTHROPIC_|OPENCC_)'` 加载，
所以把这些 export 写进 `~/.zshrc` 即可（cron 一次配好）：

```bash
# 飞书（必填）
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
export FEISHU_CHAT_ID=oc_xxxx           # 发送目标 chat_id

# LLM 代理 / 模型（推荐 deepseek-v4-flash，见下节）
export ANTHROPIC_BASE_URL=http://127.0.0.1:15721
export ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED
```

改完 `source ~/.zshrc` 并确认能抓到：`grep '^export FEISHU_' ~/.zshrc`。

---

## 4. LLM 模型：推荐 deepseek-v4-flash

小书童的「智能层」是 opencc（claude-js）headless 会话，模型选择与真实 Claude Code 一致：
claude-js 读 `~/.claude/settings.json`（env 块）并尊重 `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL_NAME` 等环境变量。

**推荐配置**：走 LLM 网关/代理，把默认模型映射成 **deepseek-v4-flash**（便宜、快，够小书童
分类待办/风险这种轻任务用）。在 `~/.claude/settings.json` 里加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
    "ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED",
    "ANTHROPIC_MODEL": "YF95AXVV/deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "YF95AXVV/deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "YF95AXVV/deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "YF95AXVV/deepseek-v4-flash"
  }
}
```

- 也可以只设 `ANTHROPIC_MODEL`，或不写 settings.json 而在 `~/.zshrc` 里 `export ANTHROPIC_*`
  （run.sh 会加载）。
- 验证：`bun vendor/opencc/dist/cli.js -p "hi" --dangerously-skip-permissions`，
  能回话就说明模型链路通了。

---

## 5. vendor opencc 代码并编译

`xiaoshutong_run.sh` 智能层跑的是 `vendor/opencc/dist/cli.js`（一个 Claude Code CLI 的
开源复刻，包名 `claude-js`）。解析顺序见 `opencc_backend.py`：

```
vendor/opencc/dist/cli.js  →  ~/.local/share/opencc/cli.js  →  ~/.opencc/cli.js
```

> ⚠️ **fresh clone 后 `vendor/opencc/` 是空的**：仓库里 `vendor/opencc` 是 gitlink
> （mode 160000）但没有 `.gitmodules` 条目，`git clone` 不会带出内容。**必须自己重新 vendor。**

```bash
cd <repo>
# 1) clone 源码到 vendor/opencc（替换成你实际可访问的仓库）
git clone https://github.com/claude-code-best/claude-code vendor/opencc
cd vendor/opencc

# 2) 装依赖 + 编译（产物 dist/cli.js）
bun install
bun run build          # 等价 make build，产出 dist/cli.js

# 3) 验证
bun dist/cli.js --version
bun dist/cli.js -p "你好" --dangerously-skip-permissions
```

- 运行要求：`bun >= 1.2.0`。已知坑：**bun 1.3.14 有 GC 挂栈崩溃问题**，建议用 1.3.13
  或更新的稳定版。
- `config.yaml` 的 `claude_cli` 保持**留空**（自动检测），别写死绝对路径——换机器后
  写死的路径就是哑火 cron。
- 想钉死仓库内构建，可提交 `dist/cli.js`（约 25MB）替换 gitlink，或用 `git submodule add` 正式托管。

---

## 6. OAuth 授权（一次性）

```bash
cd xiaoshutong
python3 feishu_auth.py --print-url     # 打印授权链接
# 浏览器打开 → 登录飞书 → 同意授权 → 跳回 http://localhost:8765/callback
# token 存 ~/.xiaoshutong/tokens.json，refresh_token 30 天自动续期
```

授权一次即可；`feishu_fetch.py` 每次运行会自动刷新。

---

## 7. 配置 config.yaml

| 字段 | 说明 |
|------|------|
| `claude_cli` | **留空**，自动检测 vendor CLI |
| `fetch_hours` | 抓取窗口；也是增量回溯上限（游标太老最多回溯 N 小时，默认 6h） |
| `initial_backfill_hours` | 首跑回填窗口（默认 24h） |
| `send_chat` | 发送目标 chat_id（留空用 `FEISHU_CHAT_ID`） |
| `send_title` | 卡片标题（默认「小书童」） |
| `chat_filters` | 会话过滤：`enabled` / `include_keywords` / `exclude_keywords` / `max_chats` |

---

## 8. 定时调度（crontab）

**一天三次，不是每小时跑一次。** 每轮窗口约 6 小时，抓取脚本会从游标增量读取，
游标太老时最多回溯 `fetch_hours`(6h)，昨天的旧消息不进窗口。

```bash
crontab -e
# PATH 要给到 bun，否则 cron 找不到运行时
PATH=/home/pc/.bun/bin:/usr/local/bin:/usr/bin:/bin
30 10,16,22 * * * /bin/bash <REPO>/xiaoshutong/xiaoshutong_run.sh >> <REPO>/xiaoshutong/data/cron.log 2>&1
```

- `xiaoshutong_run.sh` 里 agent 阶段 `timeout 900`（15 分钟）：大批量窗口
  （如 16:30→22:30 积压 70+ 条）分析 + 写盘 + 发卡片可能超过 7 分钟，
  420s 曾被掐断导致报告没发出去，故放宽到 900s。
- 每次运行日志在 `data/runs.log`，最后一行应看到 `小书童 run done` 且 agent `rc=0`。

---

## 9. 手动运维

```bash
cd xiaoshutong
python3 feishu_fetch.py              # 手动增量抓取
python3 feishu_fetch.py --hours 24   # 回填 24 小时
bash xiaoshutong_run.sh              # 手动跑一次完整链路（会真发卡片）
tail -50 data/runs.log               # 看运行日志
```

---

## 10. 排障速查

| 现象 | 原因 | 处理 |
|------|------|------|
| 某次没收到报告，`runs.log` 里 `agent 结束 rc=124` | agent 阶段被 timeout 杀掉 | 查看那次是否大窗口积压；确认已用 `timeout 900` |
| 一直收不到报告，`cron.log` 有「找不到 opencc CLI」 | `vendor/opencc` 是空 gitlink / `claude_cli` 写死路径 | 按第 5 节重新 vendor 编译；`claude_cli` 留空 |
| OAuth 授权链接打不开 / 回调失败 | 重定向 URL 没加 | 应用「安全设置」加 `http://localhost:8765/callback` |
| 群消息读不到，P2P 正常 | 缺 `im:message.group_msg:get_as_user` | 开放平台开权限（动态生效） |
| 卡片显示纯文本表格 | 用了 text 元素 | 一律走 `feishu_send.py`（v2 + 原生 table 组件） |
| 卡片右下角 `1/2` 翻页 | table 行数超 10 | `feishu_send.py` 硬截 10 行；prompt 限 10 行 |
| `ValueError: Unknown scheme for proxy URL socks://` | httpx 读到 socks 代理 | `trust_env=False` / 清 proxy 环境变量 |
| 报告里出现 `ou_xxx` / `未知同事(...)` | 名字没解析出来，agent 照抄旧写法 | 发言人查不到留空白；确认 `users` 表非空 |
| 模型不回话 | 网关/模型配置没生效 | 见第 4 节；`bun dist/cli.js -p "hi"` 先验证 |
