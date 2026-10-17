#!/bin/bash
# 小书童调度入口：抓取飞书聊天 → opencc headless agent 分类梳理 → 发卡片
# 由 crontab 触发（一天三次：10:30 / 16:30 / 22:30，不是每小时跑）：
#   PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
#   30 10,16,22 * * * bash <REPO>/xiaoshutong/xiaoshutong_run.sh
# 脚本内部一律用相对 $DIR 的路径，换机器只要改 crontab 这一行。

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# cron 环境不继承 login shell 的 export；从 ~/.zshrc 加载飞书凭据 + LLM 配置
# FEISHU_* 必填；ANTHROPIC_*/OPENCC_* 用于 LLM 代理与模型（见 DEPLOY.md）
if [ -f "$HOME/.zshrc" ]; then
  eval "$(grep -E '^export (FEISHU_|ANTHROPIC_|OPENCC_)' "$HOME/.zshrc")" 2>/dev/null || true
fi

# 读取配置（CLI 路径、bun、是否跳过权限）
CLI="$(
  python3 - <<'PY'
import sys
sys.path.insert(0, '.')
sys.path.insert(0, '..')
from config import load_config
configured = load_config().claude_cli or ''
try:
    from opencc_backend import resolve_cli_path
    print(resolve_cli_path(configured or None))
except Exception as e:
    # 兜底：解析不出来就打印配置值，让下面的检查报错退出，而不是静默跑一个空路径
    print(configured, file=sys.stdout)
    print(f"resolve_cli_path 失败: {e}", file=sys.stderr)
PY
)"
BUN="$(
  python3 - <<'PY'
import sys
sys.path.insert(0, '.')
from config import load_config
print(load_config().claude_bun or 'bun')
PY
)"
SKIP="$(
  python3 - <<'PY'
import sys
sys.path.insert(0, '.')
from config import load_config
print('--dangerously-skip-permissions' if load_config().dangerously_skip_permissions else '')
PY
)"
# 找不到 CLI 就直接失败并留下日志。以前这里回退到一个硬编码路径，
# 换台机器后 cron 每小时静默空跑一次，什么都不发。
if [ ! -f "$CLI" ]; then
  mkdir -p data
  echo "[$(date '+%F %T')] 找不到 opencc CLI（配置: '$CLI'），本次跳过。" \
    >> data/runs.log
  exit 1
fi

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo ""
  echo "==== [$TS] 小书童 run start ===="

  # ① 数据层：抓取增量聊天记录（零 token 成本）
  echo "--- [fetch] 开始 ---"
  python3 feishu_fetch.py
  echo "--- [fetch] 结束 rc=$? ---"

  # ①.5 备份 agent 即将改写的跟踪表
  # todos.md / risks.md 由 agent 手工 Edit，且第五步要求「先逐出非今天的旧行、再追加新增」
  # —— 这是非幂等的 read-modify-write。agent 被 timeout 杀掉或触发重试时，可能停在
  # 「已逐出、未追加」之间，当天旧行就此消失。而 data/ 在 .gitignore 里（无 git 历史）、
  # 目录下也没有 .bak，丢了就找不回。备份便宜，先加上。（2026-09-19）
  # 注：上面第 ② 步「重试不会重复写 digest」的论证只对纯追加的 digest 成立，
  #     对这两张「删+加」的表不成立。
  mkdir -p data/backup
  for f in todos.md risks.md; do
    # 不用 cp -p：要的就是"本次备份时刻"的 mtime，否则下面的 -t 轮转会排错序、删错文件
    [ -f "data/$f" ] && cp "data/$f" "data/backup/${f%.md}-$(date '+%Y%m%d-%H%M').md"
  done
  # 只留最近 30 份（每天 3 轮 × 2 个文件 = 6 份/天，约留 5 天）
  ls -1t data/backup/*.md 2>/dev/null | tail -n +31 | xargs -r rm -f

  # ② 智能层：opencc headless 会话，执行 agent_prompt.md
  PROMPT="你是小书童，用户的个人助理。请先 Read 当前目录下的 agent_prompt.md 并严格执行其中全部任务。本次要分析的聊天快照在 data/latest.md，开始吧。"
  # 420s/900s 都曾被大批量窗口跑满：agent 超时被 timeout 杀掉（rc=124）时报告静默丢失。
  # 对策：超时自动重试一次（agent 是独立会话，重试不会重复写 digest）；仍失败则留明确警告。
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
    echo "[严重] agent 重试后仍失败 rc=$AGENT_RC，本次报告未发送。请人工检查（内存/代理/opencc 会话）。"
  fi

  echo "==== [$TS] 小书童 run done ===="
} >> data/runs.log 2>&1

exit 0
