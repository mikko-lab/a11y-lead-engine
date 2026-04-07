#!/bin/bash
set -e

SERVER="${DEPLOY_SERVER:-root@***REMOVED***}"
REMOTE_DIR="/opt/a11y"

echo "→ Synkataan tiedostot..."
rsync -az \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'prisma/dev.db' \
  --exclude '.env' \
  --exclude '*.tar.gz' \
  . "$SERVER:$REMOTE_DIR/"

echo "→ Asennetaan riippuvuudet ja päivitetään DB..."
ssh "$SERVER" "cd $REMOTE_DIR && pnpm install --frozen-lockfile && pnpm db:push"

echo "→ Käynnistetään uudelleen..."
ssh "$SERVER" "pm2 restart all"

echo "✓ Deploy valmis!"
