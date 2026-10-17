# 科技日报部署说明

定时抓取 Hacker News 首页 → **opencc LLM 中文总结** → 转 PDF → 发飞书。与小书童同级目录，由 crontab 驱动。

## 目录结构

```
tech-daily/
├── config.yaml          # 配置（条数 / 标题 / opencc / 发送目标）
├── tech_daily.py        # 确定性脚本：fetch（抓取）+ publish（转 PDF + 发飞书）
├── tech_daily_run.sh    # cron 入口：fetch → agent → publish 三段式
├── agent_prompt.md      # LLM 总结指令（读 latest.md → 写中文日报）
├── data/
│   ├── latest.md        # HN 原始快照（fetch 产出，agent 输入）
│   ├── digests/         # LLM 写的中文日报 md
│   ├── pdfs/            # 每日 PDF
│   └── runs.log         # 运行日志
└── DEPLOY.md
```

## 三段式流程（对齐小书童）

1. **fetch**（`tech_daily.py fetch`）：抓 HN 首页前 N 条 → `data/latest.md`，零 token。
2. **agent**（opencc headless）：读 `agent_prompt.md` + `data/latest.md`，写中文总结到 `data/digests/<日期>.md`。
3. **publish**（`tech_daily.py publish`）：读 digest md → pandoc+Tectonic 转 PDF → 飞书发 **PDF + markdown 两个文件**。

总结交给 LLM，脚本只做抓取/转 PDF/发送这三件确定性的事。

> **降级规则**：PDF 是尽力而为。引擎自检失败或转换报错时，本轮**只发 markdown**，绝不静默漏发。
> 引擎在转换前先跑一次 `--version` 自检——本机发生过 tectonic 二进制被静默改写（位翻转、mtime 不变）
> 导致启动即段错误，那种情况 pandoc 只会吐一句无信息的 `Error producing PDF`，极难排查。

## 依赖

- **抓取**：Hacker News 官方 Firebase API（`httpx` 直连，无需代理）
- **总结**：opencc CLI（`vendor/opencc/dist/cli.js`，经 `opencc_backend.resolve_cli_path()` 解析）+ bun
- **PDF**：`pandoc` + `~/.local/bin/tectonic`（经 `~/.local/bin/convert_md_to_pdf.sh`）
  - 用官方 **musl 静态版**，别用 glibc 动态版：`tech_daily.py` 会先跑 `--version` 自检，静态版不受 `ld.so` 影响，也更小
  - `convert_md_to_pdf.sh` 会在转换前删掉旧产物，并把 pandoc 真实退出码透传（旧的 `|| true` 会把失败伪装成成功）
- **发送**：复用 MateBot 的 `feishu_api.py` / `feishu_config.py`（app_id/secret 读 `~/Documents/config/feishu-meeting-assistant/secrets.yaml`）

## 安装定时任务

```bash
crontab -e
```

加一行（每天 8:30）：

```
30 8 * * * bash /home/pc/yysapp/MateBot/tech-daily/tech_daily_run.sh
```

改时间只动这一行。小书童是一天三次（`30 10,16,22 * * *`），科技日报默认一天一次。

## 配置

`config.yaml`：

| 字段 | 默认 | 说明 |
|------|------|------|
| `title` | 科技日报 | 日报标题（写入 agent prompt） |
| `top_n` | 30 | 抓取首页前 N 条 |
| `data_dir` | data | 输出目录 |
| `claude_cli` | "" | opencc CLI 路径，留空自动检测 |
| `claude_bun` | bun | bun 运行时 |
| `dangerously_skip_permissions` | true | headless 免权限弹窗 |
| `send_enabled` | true | 是否发飞书（调试可关） |
| `send_chat` | "" | 发送目标 chat_id；留空复用 MateBot 的 P2P 会话 |

## 手动测试

```bash
cd /home/pc/yysapp/MateBot/tech-daily
python3 tech_daily.py fetch      # 只抓快照
bash tech_daily_run.sh           # 完整跑一遍（含 LLM 总结 + 发飞书）
cat data/runs.log                # 看日志
```

`send_enabled: false` 时只生成本地 PDF、不发飞书，便于调试 agent。
