#!/usr/bin/env bash
# WMS route & task calendar: ship a new version on the Linux VPS (section 11.4).
# Usage:  sudo bash /opt/wms/deploy/update.sh
#
# In order: a backup, git pull, a frontend build BESIDE the live one, old chunks kept, the folders
# swapped, PHP-FPM reloaded (clears OPcache). Data and config files are untouched; when deploy/ changed,
# it tells you to re-run install.sh. A failed step stops the script and leaves the live site as it was
# (except that the PHP code is already the new version once `git pull` has run).
set -Eeuo pipefail
umask 022

APP_DIR=${WMS_APP_DIR:-/opt/wms}   # WMS_APP_DIR is for testing this script only; production is /opt/wms
PUBLIC=$APP_DIR/backend/public
PHP_V=8.3

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'die "update.sh stopped at line $LINENO (exit code $?). Fix the problem shown above and run it again (the live app is only replaced in step 5)."' ERR

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $APP_DIR/deploy/update.sh"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git clone"

# Only one update at a time.
exec 9> /run/lock/wms-update.lock
flock -n 9 || die "another update.sh is running"

# ---------------------------------------------------------------------------------------------
step "1/6 Backup before the update (wms-backup.service)"
if [ "${WMS_SKIP_BACKUP:-}" = 1 ]; then
  warn "WMS_SKIP_BACKUP=1: no backup before this update"
elif ! systemctl start wms-backup; then
  die "the backup failed, so nothing was updated. See: systemctl status wms-backup; journalctl -u wms-backup -n 50.
       (Under 15% free disk also fails it. Free some space, or run with WMS_SKIP_BACKUP=1 at your own risk.)"
fi

# ---------------------------------------------------------------------------------------------
step "2/6 git pull --ff-only"
old_rev=$(git -C "$APP_DIR" rev-parse HEAD)
git -C "$APP_DIR" pull --ff-only
new_rev=$(git -C "$APP_DIR" rev-parse HEAD)
if [ "$old_rev" = "$new_rev" ]; then
  echo "Already up to date ($new_rev); rebuilding the frontend anyway."
else
  git -C "$APP_DIR" --no-pager log --oneline "$old_rev..$new_rev" | head -n 20
fi
deploy_changed=no
git -C "$APP_DIR" diff --quiet "$old_rev" "$new_rev" -- deploy/ || deploy_changed=yes

# ---------------------------------------------------------------------------------------------
step "3/6 Frontend build into backend/public/app.new (the live app stays untouched)"
want_node=$(sed -E -n '1s/^[[:space:]]*v?([0-9]+).*/\1/p' "$APP_DIR/frontend/.nvmrc")
have_node=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
[ "$have_node" = "$want_node" ] \
  || die "frontend/.nvmrc asks for Node.js $want_node but node is $have_node. Re-run: sudo bash $APP_DIR/deploy/install.sh <domain>"
rm -rf "$PUBLIC/app.new"
cd "$APP_DIR/frontend"
npm ci --no-audit --no-fund
npm run build -- --outDir ../backend/public/app.new
cd "$APP_DIR"
[ -f "$PUBLIC/app.new/index.html" ] || die "the build did not write backend/public/app.new/index.html"

# ---------------------------------------------------------------------------------------------
step "4/6 Keep the previous assets/ files (an open tab of the old version can still load its chunks)"
kept=0
if [ -d "$PUBLIC/app/assets" ]; then
  mkdir -p "$PUBLIC/app.new/assets"
  while IFS= read -r -d '' f; do
    rel=${f#"$PUBLIC/app/assets/"}
    if [ ! -e "$PUBLIC/app.new/assets/$rel" ]; then
      mkdir -p "$(dirname "$PUBLIC/app.new/assets/$rel")"
      cp -p "$f" "$PUBLIC/app.new/assets/$rel"
      kept=$((kept + 1))
    fi
  done < <(find "$PUBLIC/app/assets" -type f -print0)
fi
echo "$kept old file(s) kept"
chmod -R a+rX,go-w "$PUBLIC/app.new"

# ---------------------------------------------------------------------------------------------
step "5/6 Swap backend/public/app.new -> app"
rm -rf "$PUBLIC/app.old"
if [ -d "$PUBLIC/app" ]; then mv "$PUBLIC/app" "$PUBLIC/app.old"; fi
mv "$PUBLIC/app.new" "$PUBLIC/app"
rm -rf "$PUBLIC/app.old"

# ---------------------------------------------------------------------------------------------
step "6/6 Reload PHP-FPM (clears OPcache)"
systemctl reload "php$PHP_V-fpm"

trap - ERR
echo
echo "Update done: $(git -C "$APP_DIR" log -1 --format='%h %s (%cd)' --date=short)"
if [ "$deploy_changed" = yes ]; then
  warn "files in deploy/ changed in this update. Apply them with: sudo bash $APP_DIR/deploy/install.sh <domain>
         (safe to re-run; it rewrites the Caddy, PHP-FPM and systemd config and never touches the data)"
fi
