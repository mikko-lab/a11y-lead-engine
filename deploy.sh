#!/bin/bash
set -e

SERVER="${DEPLOY_SERVER:?Aseta DEPLOY_SERVER-ympäristömuuttuja, esim. a11y@1.2.3.4}"
REMOTE_DIR="/opt/a11y/app"

echo "→ Synkataan tiedostot..."
rsync -az \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'prisma/dev.db' \
  --exclude '.env' \
  --exclude '*.tar.gz' \
  --exclude '.DS_Store' \
  . "$SERVER:$REMOTE_DIR/"

# rsync -a säilyttää lähteen omistajan/ryhmän (paikallinen macOS-uid), ja koska
# tämä ajetaan rootina, se pääsee asettamaan sen etäpalvelimelle — chownaa siis
# KOKO puu takaisin a11y:lle, ei vain src/+package.json, muuten mikä tahansa
# uusi/koskematon tiedosto (esim. prisma/prisma/) jää väärän omistajan alle ja
# SQLite ei enää voi kirjoittaa sinne (nähty tuotannossa 2026-07-05).
echo "→ Korjataan tiedosto-oikeudet..."
ssh "$SERVER" "chown -R a11y:a11y $REMOTE_DIR 2>/dev/null || true"

echo "→ Asennetaan riippuvuudet ja päivitetään DB..."
ssh "$SERVER" "cd $REMOTE_DIR && pnpm install --frozen-lockfile && pnpm db:push"

echo "→ Käynnistetään uudelleen..."
ssh "$SERVER" "pm2 restart all"

echo "✓ Deploy valmis!"
