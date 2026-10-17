#!/bin/bash
# Stop the Feishu bridge（托管为 systemd user 服务）
echo "Stopping Feishu bridge..."
systemctl --user stop matebot-bridge
rm -f ~/.matecode/feishu_pending ~/.matecode/feishu_chat_id
echo "Feishu bridge stopped."