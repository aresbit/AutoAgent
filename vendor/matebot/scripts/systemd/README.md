# MateBot 守护进程 / 定时任务清单

本目录存放 systemd 托管的守护进程配置备份。MateBot 共有三类常驻/定时进程：

| 进程 | 托管方式 | 入口代码（仓库内） | 配置 |
|---|---|---|---|
| **matebot-bridge**（飞书桥） | systemd user | `feishu_bridge.py`（根目录） | `matebot-bridge.service` + `~/.config/matebot/matebot-bridge.env` |
| **xiaoshutong**（小书童待办梳理） | crontab（10/16/22 点） | `xiaoshutong/xiaoshutong_run.sh` | `xiaoshutong/config.yaml` |
| **tech-daily**（科技日报） | crontab（每天 9 点） | `tech-daily/tech_daily_run.sh` | `tech-daily/config.yaml` |

## matebot-bridge 重建步骤

```bash
mkdir -p ~/.config/systemd/user ~/.config/matebot
cp scripts/systemd/matebot-bridge.service ~/.config/systemd/user/
cp scripts/systemd/matebot-bridge.env.example ~/.config/matebot/matebot-bridge.env
# 编辑 matebot-bridge.env 填入 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID
systemctl --user daemon-reload
systemctl --user enable --now matebot-bridge
```

注意：unit 文件里的 `WorkingDirectory` / `ExecStart` / `Environment=PATH` 含当前机器的绝对路径，换机器需改成实际仓库路径。
