#!/usr/bin/env bash
# Met en ligne la version locale de LogisticTrack sur https://www.logisticstraack.com
#
#   ./deploy.sh              tests, puis mise en ligne
#   ./deploy.sh --sans-tests mise en ligne sans relancer les tests (déconseillé)
#
# Étapes : tests -> compilation du site -> envoi du code -> sauvegarde de la base en ligne
# -> compilation sur le serveur -> migrations MySQL -> redémarrage -> vérification.
# En cas d'erreur, tout s'arrête : l'ancienne version reste en ligne.
set -euo pipefail

SERVER=root@194.34.232.102
KEY="$HOME/.ssh/id_ed25519_logistictrack"
APP=/opt/logistictrack
URL=https://www.logisticstraack.com
ROOT="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$SERVER")
RSYNC_SSH="ssh -i $KEY -o BatchMode=yes"

etape() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
echec() { printf '\n\033[1;31mÉCHEC : %s\033[0m\n' "$1"; exit 1; }

etape "Connexion au serveur"
"${SSH[@]}" true || echec "connexion SSH impossible (clé $KEY)."

if [[ "${1:-}" != "--sans-tests" ]]; then
  etape "Tests du serveur (environ une minute)"
  (cd "$ROOT/server" && npm test >/tmp/logistictrack-tests.log 2>&1) || { tail -30 /tmp/logistictrack-tests.log; echec "des tests échouent : rien n'a été mis en ligne."; }
  grep -E "^# (pass|fail)" /tmp/logistictrack-tests.log
fi

etape "Compilation du site web"
(cd "$ROOT/web" && npx vite build >/tmp/logistictrack-web.log 2>&1) || { tail -20 /tmp/logistictrack-web.log; echec "le site web ne compile pas."; }

etape "Envoi du code du serveur"
# Jamais : .env, bases locales, fichiers et sauvegardes de développement.
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude node_modules --exclude dist --exclude 'dist.precedent' --exclude '.env' --exclude '.env.*' \
  --exclude '*.db' --exclude '*.db-journal' --exclude '*.db-wal' --exclude '*.db-shm' \
  --exclude storage --exclude backups --exclude '.DS_Store' \
  "$ROOT/server/" "$SERVER:$APP/server/"

etape "Sauvegarde, compilation, migrations et redémarrage sur le serveur"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
APP=/opt/logistictrack
export PATH=$APP/node/bin:$PATH
cd $APP/server
echo "- sauvegarde de la base et des fichiers avant la mise à jour"
runuser -u logistictrack -- env PATH=$PATH node dist/src/backup-cli.js backup | tail -1
echo "- installation des dépendances"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
echo "- compilation pour MySQL"
rm -rf dist.precedent && cp -a dist dist.precedent
npm run -s db:mysql:generate >/dev/null
npm run -s build
echo "- migrations MySQL"
npm run -s db:mysql:deploy 2>&1 | grep -E "Applying|No pending|applied|Error" || true
set -a; . ./.env; set +a
if ! npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/mysql/schema.prisma --exit-code >/dev/null 2>&1; then
  # Le modèle a changé sans migration MySQL : on garde l'ancienne version en marche.
  rm -rf dist && mv dist.precedent dist
  echo "ERREUR : le modèle de données a changé mais aucune migration MySQL ne l'accompagne."
  echo "Créez la migration (prisma/mysql/migrations) puis relancez. L'ancienne version reste en ligne."
  exit 1
fi
echo "- redémarrage"
systemctl restart logistictrack
for i in $(seq 1 30); do
  if curl -fs -m 2 http://127.0.0.1:3210/health >/dev/null; then echo "- serveur prêt"; exit 0; fi
  sleep 1
done
echo "ERREUR : le serveur ne répond pas après redémarrage. Retour à la version précédente."
journalctl -u logistictrack --no-pager -n 25 | cut -c1-220
rm -rf dist && mv dist.precedent dist && systemctl restart logistictrack
exit 1
REMOTE

etape "Envoi du site web"
rsync -az --delete -e "$RSYNC_SSH" --exclude '.DS_Store' "$ROOT/web/dist/" "$SERVER:$APP/web/"
"${SSH[@]}" "find $APP/web -type d -exec chmod 755 {} + && find $APP/web -type f -exec chmod 644 {} +"

etape "Vérification en ligne"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
sante=$(curl -s "$URL/health" || true)
[[ "$code" == "200" && "$sante" == *'"status":"ok"'* ]] || echec "le site ne répond pas correctement (code $code)."
printf '\n\033[1;32mMise en ligne réussie : %s\033[0m\n' "$URL"
