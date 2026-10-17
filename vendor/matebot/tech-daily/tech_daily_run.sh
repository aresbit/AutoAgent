#!/bin/bash
# 科技日报调度入口：抓 HN → opencc LLM 中文总结 → 转 PDF → 发飞书
# 由 crontab 触发（每天早上 8:30）：
#   30 8 * * * bash <REPO>/tech-daily/tech_daily_run.sh
# 脚本内部一律用相对 $DIR 的路径，换机器只要改 crontab 这一行。

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# cron 环境不继承 login shell 的 export；从 ~/.zshrc 加载飞书凭据 + LLM 配置
# FEISHU_* 必填；OPENCC_*/ANTHROPIC_* 用于 LLM 代理与模型（与 MateBot 一致）
if [ -f "$HOME/.zshrc" ]; then
  eval "$(grep -E '^export (FEISHU_|OPENCC_|ANTHROPIC_)' "$HOME/.zshrc")" 2>/dev/null || true
fi

mkdir -p data

# 读取配置（opencc CLI 路径、bun、是否跳过权限）
CLI="$(
  python3 - <<'PY'
import sys
sys.path.insert(0, '.')
sys.path.insert(0, '..')
import yaml
from opencc_backend import resolve_cli_path
cfg = yaml.safe_load(open('config.yaml')) or {}
try:
    print(resolve_cli_path((cfg.get('claude_cli') or '') or None))
except Exception as e:
    print((cfg.get('claude_cli') or ''), file=sys.stdout)
    print(f"resolve_cli_path 失败: {e}", file=sys.stderr)
PY
)"
BUN="$(
  python3 - <<'PY'
import yaml
cfg = yaml.safe_load(open('config.yaml')) or {}
print(cfg.get('claude_bun') or 'bun')
PY
)"
SKIP="$(
  python3 - <<'PY'
import yaml
cfg = yaml.safe_load(open('config.yaml')) or {}
print('--dangerously-skip-permissions' if cfg.get('dangerously_skip_permissions', True) else '')
PY
)"
# 找不到 CLI 就直接失败并留下日志（避免 cron 静默空跑）
if [ ! -f "$CLI" ]; then
  echo "[$(date '+%F %T')] 找不到 opencc CLI（配置: '$CLI'），本次跳过。" >> data/runs.log
  exit 1
fi

TS="$(date '+%Y-%m-%d %H:%M:%S')"
TODAY="$(date '+%Y-%m-%d')"
{
  echo ""
  echo "==== [$TS] 科技日报 run start ===="

  # ① 数据层：抓 HN → data/latest.md（零 token 成本）
  echo "--- [fetch] 开始 ---"
  python3 tech_daily.py fetch
  echo "--- [fetch] 结束 rc=$? ---"

  # ② 智能层：opencc headless 会话，执行 agent_prompt.md（中文总结）
  PROMPT="你是科技日报编辑。今天是 ${TODAY}。请先 Read 当前目录下的 agent_prompt.md 并严格执行其中全部任务。HN 快照在 data/latest.md，开始吧。"
  AGENT_RC=1
  for attempt in 1 2; do
    echo "--- [agent] 第 ${attempt} 次尝试开始 ---"
    timeout 900 "$BUN" "$CLI" -p "$PROMPT" $SKIP
    AGENT_RC=$?
    echo "--- [agent] 第 ${attempt} 次结束 rc=$AGENT_RC ---"
    if [ "$AGENT_RC" -eq 0 ]; then
      break
    fi
    echo "[警告] agent 第 ${attempt} 次失败 rc=$AGENT_RC（0=成功 124=超时），30s 后自动重试..."
    sleep 30
  done
  if [ "$AGENT_RC" -ne 0 ]; then
    echo "[严重] agent 重试后仍失败 rc=$AGENT_RC，本次日报未发送。请人工检查（内存/代理/opencc 会话）。"
  fi

  # ③ 发布层：转 PDF + 发飞书
  echo "--- [publish] 开始 ---"
  python3 tech_daily.py publish
  echo "--- [publish] 结束 rc=$? ---"

  echo "==== [$TS] 科技日报 run done ===="
} >> data/runs.log 2>&1

exit 0
