#!/usr/bin/env bash
# 用法：在项目根目录建 .deploy.env（已被 git 忽略），写入
#   DEPLOY_HOST=root@服务器IP
#   DEPLOY_PATH=/var/www/llmliangyi
# 然后执行 pnpm deploy:server
set -euo pipefail

if [ -f .deploy.env ]; then
  set -a
  source .deploy.env
  set +a
fi

host="${DEPLOY_HOST:?请在 .deploy.env 里设置 DEPLOY_HOST，例如 root@服务器IP}"
target="${DEPLOY_PATH:-/var/www/llmliangyi}"

pnpm build
ssh "$host" "mkdir -p '$target'"
rsync -avz --delete dist/ "$host:$target/"
echo "已发布到 $target"
