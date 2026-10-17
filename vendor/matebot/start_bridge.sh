#!/bin/bash
# Start MateBot Feishu Bridge（托管为 systemd user 服务，自动重启）
# 前台手动调试：cd "$(dirname "$0")" && python3 feishu_bridge.py
systemctl --user start matebot-bridge
systemctl --user --no-pager status matebot-bridge | head -6