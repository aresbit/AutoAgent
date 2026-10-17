---
name: xiaoshutong
description: 小书童个人助理 agent 的架构、运维与飞书 API 调试指南。当处理 xiaoshutong 项目、飞书聊天抓取、待办/风险梳理、feishu_fetch/feishu_send/feishu_auth 脚本、飞书 OpenAPI 调试、卡片表格渲染问题时使用。
---

# 小书童（xiaoshutong）Agent 知识库

个人助理 agent：一天三次从用户飞书工作聊天中提取待办、挖掘风险，整理成表格发飞书卡片，
并把进展沉淀到记忆实现小时级接力。代码在 MateBot 仓库的 `xiaoshutong/` 子目录。

> 本文所有路径都相对仓库根写。**不要往代码或文档里写绝对家目录路径** —— 之前
> `config.yaml` 的 `claude_cli` 写死了 `/home/pc/...`，换机器后 cron 每小时静默
> 空跑，什么都不发，查了很久。

## 架构总览

```
系统 crontab (30 10,16,22 * * *)  ← 一天三次：10:30 / 16:30 / 22:30
   │
   ▼ xiaoshutong_run.sh（调度入口）
   ① python3 feishu_fetch.py            ← 数据层（零 token）
      列会话 → 逐会话增量读消息 → SQLite messages.db → data/latest.md → 更新游标
   ② bun vendor/opencc/dist/cli.js -p "Read agent_prompt.md 并执行"
       ← 智能层（opencc headless 会话）
      读 latest.md → 分类待办(3类)/风险(4类) → 更新 todos.md/risks.md/digests/
      → MemoryTool temp_save(SCRATCHPAD 接力) → feishu_send.py 发卡片
```

数据层（Python）与智能层（opencc CLI）分离：抓取便宜可靠、分类用 LLM。
每次 cron 触发开一个全新 headless 会话，靠 memoryTrigger 自动注入 REHEARSAL.md /
SCRATCHPAD.md 获得上次待办进展，实现跨小时接力。

## 组件清单

| 文件 | 职责 |
|------|------|
| `feishu_auth.py` | 一次性 OAuth：授权 URL → loopback 8765 捕获 code → 换 user_access_token。`--print-url` 只打印链接 |
| `feishu_user_api.py` | user_access_token 客户端：UserTokenManager(自动刷新) + list_chats / read_messages / search_messages / parse_message_text |
| `feishu_fetch.py` | 增量抓取：会话过滤 → 逐会话读消息 → SQLite → latest.md → 游标 |
| `feishu_send.py` | markdown 报告 → 飞书 v2 卡片（表格转原生 table 组件）→ bot token 发送 |
| `agent_prompt.md` | 小书童角色 + 待办/风险分类规则 + 记忆指令 + 发送铁律 |
| `config.py` / `config.yaml` | 配置（CLI 路径、抓取窗口、会话过滤、发送目标） |
| `xiaoshutong_run.sh` | cron 入口：加载凭据 → fetch → headless agent |
| `data/` | messages.db(SQLite) / latest.md / todos.md / risks.md / digests/ / last_run.txt(游标) / runs.log |

## 飞书 API 关键事实（实测踩坑，别再踩）

### Token 体系
- **user_access_token**（用户身份，OAuth 浏览器授权获取）有效期约 2h，refresh_token 30 天。
  存于 `~/.xiaoshutong/tokens.json`（`config.yaml` 的 `token_file`），`UserTokenManager` 自动刷新。
- **bot tenant_access_token**（应用身份）用于发送卡片，`feishu_api.py` 的 `TokenManager`。
- OAuth scope 需含 `offline_access`（换 refresh_token）+ 数据权限：
  `im:chat:read im:message:readonly im:message.p2p_msg:get_as_user im:message.group_msg:get_as_user search:message`
- 开放平台开通新权限后，**已签发的 user_access_token 动态生效，无需重新授权**（实测 token 文件未变但权限通了）。
- 消息搜索必须用 user_access_token；bot token 调用会报误导性错误 `99992354 "Invalid ids: [search]"`。

### 消息列表 `GET /im/v1/messages`（read_messages）
- **`start_time`/`end_time` 参数用【秒】！** 传毫秒会报 `230001 "end_time is earlier than start_time"`。
- 返回的 `create_time` 是【毫秒】（insert 时注意区分，勿再乘 1000）。
- `page_size` 最大 **50**，超过报 `99992402 field validation failed`。
- 权限：读群消息需 `im:message.group_msg:get_as_user`，读单聊需 `im:message.p2p_msg:get_as_user`，
  缺权限报 `230027 "Lack of necessary permissions, ext=need scope: im:..."`。
- 注意：单聊里 `@_user_N` 是脱敏提及，`<p>` 是富文本残留，均因缺 contact 权限无法解析真实人名。

### 消息搜索 `POST /im/v1/messages/search`（search_messages）
- 返回结构与列表 API 完全不同：`{id, display_info, meta_data:{chat_id, create_time(ISO8601 UTC), from_id, type}}`。
- `display_info` 含 HTML 标签（`<pi>`/`<asl-style>`/`<h>` 高亮）与 `&amp;` 实体、以及"会话名+人名"前缀，需清洗。
- 是关键词驱动的片段（会截断），质量不如列表 API 的全量读取；仅作权限不足时的回退数据源。

### 卡片发送（markdown 渲染）
- **`{"tag":"text"}` 元素不渲染 markdown** —— 表格会显示成原始管道符文本。
- 要渲染表格：用 **v2 卡片** `{"schema":"2.0", "header":..., "body":{"elements":[...]}}`，
  表格转成**原生 `table` 组件**（`columns` 列定义 + `rows` 行数据，`page_size` 1-10，每卡最多 5 个 table），
  标题/段落用 `{"tag":"markdown","content":"..."}`。
- `feishu_send.py` 已封装：`split_markdown_tables` 拆 GFM 表格 → `md_table_to_feishu_table` 转换 → 分卡发送。
- 用 `get_message_content` 读回 v2 卡片会得到 v1 图片预览（"请升级客户端"），**无法用 GET 验证 v2 结构**，属正常。

### 网络/代理
- 系统代理是 `socks://`，httpx 不支持 → 必须 `trust_env=False` 或先清空 proxy 环境变量（脚本顶部已处理）。
- 直连飞书 API 可用，无需代理。

## 增量查询语义（用户明确要求）

**严格从游标开始，跳过游标之前的旧消息。** 10 点查完，11 点只查 10 点之后。
- cron 增量（无参数）：`since_ms = max(last_run, now - fetch_hours)` —— 游标太老
  （比如上次是昨天跑的）时最多回溯 `fetch_hours`(6h)，**昨天的旧消息不进窗口**。
- `--hours N`：手动回填 N 小时（覆盖游标）。`--full`/首跑：回填 `initial_backfill_hours`(24h)。
- 游标 `data/last_run.txt` 存查询结束时刻（epoch 毫秒，即每次 main() 开头的 now_ms，非抓取完成时刻），
  这样抓取期间的边界消息不会丢失（会被下一次查询覆盖）。

### latest.md 过滤（用户明确要求）

`build_latest_md` 只保留与用户相关的消息，其余泛泛讨论不进快照（agent 也就不会记录）：
- `at_me = 1`（点名到我，含 mention name 里的别名匹配）
- `sender = 我`（用户自己发的）
- p2p 私聊（全量）
- 文本含 `@_user_` 掩码提及（缺 contact 权限时 @ 会退化成 `@_user_N`，这类点名值得浮出）

## 调度与凭据

- crontab：`30 10,16,22 * * *`（一天三次：10:30 / 16:30 / 22:30）。
- crontab 顶部要有 `PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin`
  （cron 的默认 PATH 不含 `~/.bun/bin`，`bun` 会找不到）。
- cron 环境不继承 login shell 的 export，`run.sh` 里从 `~/.zshrc` 用 `grep -E '^export FEISHU_'` 加载凭据。

## 记忆系统

- 记忆目录：`~/.claude/projects/<仓库根绝对路径，把 / 和 . 换成 ->/memory/`。
  例：仓库在 `/srv/MateBot` → `~/.claude/projects/-srv-MateBot/memory/`。
  **项目根解析到 git repo 根（MateBot），不是 xiaoshutong 子目录**，改记忆时认准这个。
  拿不准就直接算：
  ```bash
  echo ~/.claude/projects/"$(git rev-parse --show-toplevel | tr './' '--')"/memory
  ```
- `SCRATCHPAD.md`（MemoryTool temp_save 写入）由 memoryTrigger 自动注入下一次会话的 system prompt，
  格式 `[小书童待办进展 <日期> <时间>]` + 未回复/已承诺/主动答应/本时段完成/最新风险 五行。
- `MEMORY.md` 索引长期记忆；digests/ 是每日摘要历史。
- `data/todos.md` 待办跟踪表含「备注」列，打钩方式：在备注里写 `✅`。
  `✅` 条目此后不再出现在**任何**报告表格里。
- 待办表列（只有五列，不许增减）：`| 范畴 | 事项 | 提出人 | 时间 | 备注 |`
  - 范畴 = 直接写 `未回复` / `已承诺` / `主动答应`，不写数字编号
  - 提出人 = **消息发送者**，查不到的留空白。禁用「自需」，禁止填裸 open_id / `未知同事(...)`
  - 时间 = **`MM-DD HH:MM`**（跨天判断用）；报告里只显示 `HH:MM`
  - 点名到本人的，在「事项」末尾加 `（点名我）`；**不设「指派」列**
  - **只填与用户本人直接相关的事务**，团队其他人的事不填
  - **每天逐出昨天的旧行**：todos.md/risks.md 里「时间」不是今天的行在每轮开头删掉，
    旧事务不占报告（历史留在 digests/）。旧待办提醒**最多 3 条**，绝不写「另有 N 条见 data/todos.md」
  - 判定点名不靠 LLM 猜：fetch 阶段用 `mentions`（含 mention name 别名）+ 别名
    （ares/aresyang/杨阳）算好，在 latest.md 行尾打 `【@我】` 标记

## 发言人名字解析

飞书 `im/v1/messages` 的 `sender` 对象**不含 name**，只有 open_id。
所以 `sender_name()` 基本总是返回空，需要另建映射：

| 来源 | 接口 | scope |
|------|------|-------|
| 会话成员（主） | `im/v1/chats/:chat_id/members` | `im:chat:read`（已有） |
| 消息 @ 到的人（顺带） | 消息体的 `mentions[].name` | 无需额外权限 |

两者都写进 SQLite `users(open_id, name, updated_at)`，每轮抓取刷新一次。
仍查不到的在 latest.md 里**发言人留空白**（报告里「提出人/涉及人」列也留空白），
不写 `未知同事(ou_xxx)`，更不写裸 `ou_...` —— 空白就是空白，别拿乱码冒充人名。

## 常见错误排查表

| 错误码 / 现象 | 原因 | 解法 |
|---------------|------|------|
| `99992354 Invalid ids: [search]` | search API 用了 bot token（缺用户身份） | 用 user_access_token；检查 OAuth 是否完成 |
| `230027 need scope: im:...` | 缺 get_as_user 细粒度权限 | 开放平台开 `im:message.group_msg/p2p_msg:get_as_user` |
| `230001 end_time earlier than start_time` | start/end 传了毫秒（API 要秒） | `start_time//1000` |
| `99992402 field validation failed` | page_size > 50 或参数非法 | page_size ≤ 50 |
| `ValueError: Unknown scheme for proxy URL socks://` | httpx 读到了 socks 代理 | `trust_env=False` 或清 proxy 环境变量 |
| 卡片显示纯文本表格 | 用了 text 元素 | 走 feishu_send.py（v2 + 原生 table 组件） |
| 卡片右下角出现 `1/2` 翻页 | table 行数 > `page_size`（上限 10） | feishu_send.py 硬截 10 行；prompt 里也限 10 行（旧待办提醒限 3 行，不补「另有 N 条」） |
| 报告出现 `未知同事(ou_xxx)` / `ou_xxx` | 名字没查到，agent 照抄了旧写法 | 见「发言人名字解析」；涉及人/提出人查不到就留空白 |
| cron 每小时空跑不发消息 | `claude_cli` 写死了别的机器的路径 | 留空走自动检测；run.sh 现在找不到 CLI 会记日志并退出 1 |
| 群里读不到消息但 P2P 可以 | 群需要 group_msg 权限 | 开权限（动态生效） |
| 时间错乱 5 万年 | create_time 毫秒被误乘 1000 | insert 时 `<1e12` 才转毫秒 |

## 已知限制与扩展点

- **联系人不显示姓名**（open_id / `@_user_N`）：已用 `im/v1/chats/:chat_id/members`
  解决（沿用已有的 `im:chat:read`，见「发言人名字解析」）。只有在需要拉**非会话成员**
  的名字时，才值得加 `contact:user.base:readonly` 并重新走一遍授权。
- **搜索回退数据含噪声**（HTML 残留、片段截断、系统消息 JSON）：`normalize_search_item` 已尽力清洗，
  主路径 read_messages 无此问题。
- **会议纪要**（风险来源之二）：`lark-meeting-digest`（在你的 worktools 仓库里）
  可后续接入为第二数据源。
- **分类灵敏度**：agent_prompt.md 里调整"③我主动答应"等类别判定措辞可改变识别倾向。

## 运维命令

```bash
# 以下命令都在仓库的 xiaoshutong/ 目录下执行
cd "$(git rev-parse --show-toplevel)/xiaoshutong"

# 手动抓取（增量）
python3 feishu_fetch.py
# 手动回填
python3 feishu_fetch.py --hours 24
# 重新授权（换 token）
python3 feishu_auth.py
# 手动跑一次完整链路
bash xiaoshutong_run.sh
# 查看运行日志
tail -50 data/runs.log
```
