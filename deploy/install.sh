#!/usr/bin/env bash
# WMS route & task calendar: one-shot, idempotent setup of a fresh Ubuntu 24.04 LTS server (section 11.4).
#
# Before running it (details in README.md, "Production on a Linux VPS"):
#   - the domain's DNS A record points at this server (DNS only, not proxied);
#   - 80/tcp, 443/tcp and 443/udp are open in the provider's firewall as well;
#   - for a private repo, a read-only deploy key is in /root/.ssh.
# Usage:
#   sudo git clone <repo-url> /opt/wms
#   cd /opt/wms
#   sudo bash deploy/install.sh wms.example.com.sg
#   (or: sudo WMS_DOMAIN=wms.example.com.sg bash deploy/install.sh)
#
# It installs PHP 8.3-FPM, Caddy (automatic HTTPS) and Node.js, creates the service user wms and the
# data folder, builds the frontend, writes the config files, creates the data on the first run and prints
# the admin password, starts everything at boot and enables the firewall. Re-running it rewrites the
# config files and restarts the services; it never changes backend/data beyond ownership and mode.
# It contains no passwords: the admin password is generated on the server (R33).
set -Eeuo pipefail
umask 022                        # code, build output and config files stay readable for Caddy and PHP-FPM

APP_DIR=/opt/wms                 # fixed: the Caddyfile and wms-backup.service use this path
DATA_DIR=$APP_DIR/backend/data
BACKUP_DIR=/var/backups/wms
SVC_USER=wms
PHP_V=8.3
TZ_NAME=Asia/Singapore

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'die "install.sh stopped at line $LINENO (exit code $?). Fix the problem shown above, then run it again (it is safe to re-run)."' ERR

# ---------------------------------------------------------------------------------------------
step "1/11 Checks"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash deploy/install.sh <domain>"

# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "this script is written for Ubuntu 24.04 LTS (found: ${PRETTY_NAME:-unknown})"
fi

WMS_DOMAIN=${1:-${WMS_DOMAIN:-}}
WMS_DOMAIN=${WMS_DOMAIN,,}
[ -n "$WMS_DOMAIN" ] || die "no domain given. Usage: sudo bash deploy/install.sh wms.example.com.sg"
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'
if ! [[ $WMS_DOMAIN =~ $domain_re ]]; then
  die "'$WMS_DOMAIN' is not a valid domain name (example: wms.example.com.sg; no https://, no path)"
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [ "$SCRIPT_DIR" != "$APP_DIR/deploy" ]; then
  die "the repo must be cloned to $APP_DIR (this script is in $SCRIPT_DIR): sudo git clone <repo-url> $APP_DIR"
fi
for f in backend/public/index.php backend/tools/init.php backend/tools/backup.php frontend/package.json \
         frontend/.nvmrc deploy/Caddyfile deploy/php-fpm-wms.conf deploy/wms-backup.service deploy/wms-backup.timer; do
  [ -f "$APP_DIR/$f" ] || die "$APP_DIR/$f is missing: is $APP_DIR a complete clone of the repo?"
done

# Let's Encrypt needs the domain to point at this server. Only a warning: DNS may still be propagating.
resolved=$(getent ahostsv4 "$WMS_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)
if [ -z "$resolved" ]; then
  warn "$WMS_DOMAIN does not resolve yet. Let's Encrypt cannot issue the certificate until its DNS A record points at this server."
else
  my_ips=" $(hostname -I 2>/dev/null || true) "
  match=no
  for ip in $resolved; do case "$my_ips" in *" $ip "*) match=yes ;; esac; done
  if [ "$match" = no ] && command -v curl >/dev/null 2>&1; then
    # Behind 1:1 NAT (for example AWS Lightsail) the public address is not on a local interface.
    public_ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    for ip in $resolved; do [ "$ip" = "$public_ip" ] && match=yes; done
  fi
  if [ "$match" = no ]; then
    warn "$WMS_DOMAIN resolves to $(echo "$resolved" | tr '\n' ' ')which is not this server's address. Let's Encrypt will fail until the A record points here (DNS only, not proxied)."
  fi
fi
echo "Domain: $WMS_DOMAIN   Repo: $APP_DIR"

# ---------------------------------------------------------------------------------------------
step "2/11 System: time zone $TZ_NAME, swap"
timedatectl set-timezone "$TZ_NAME"
# Under 2 GiB of RAM the frontend build can run out of memory: add a 1 GB swap file once.
mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2097152 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  if [ ! -f /swapfile ]; then
    echo "Adding a 1 GB swap file (/swapfile)"
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -Eq '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Ubuntu's unattended security upgrades are left on (nothing to do here).

# ---------------------------------------------------------------------------------------------
step "3/11 Packages: PHP $PHP_V-FPM, Caddy, Node.js"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y "php$PHP_V-fpm" "php$PHP_V-cli" "php$PHP_V-opcache" git ufw curl ca-certificates gnupg

NODE_MAJOR=$(sed -E -n '1s/^[[:space:]]*v?([0-9]+).*/\1/p' "$APP_DIR/frontend/.nvmrc")
[ -n "$NODE_MAJOR" ] || die "cannot read the Node.js major version from frontend/.nvmrc"

# Caddy from its official apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
  > /etc/apt/sources.list.d/caddy-stable.list
# Node.js from NodeSource at the major pinned in frontend/.nvmrc. Ubuntu's own nodejs (18) is too old.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/keyrings/nodesource.gpg \
  /etc/apt/sources.list.d/caddy-stable.list /etc/apt/sources.list.d/nodesource.list /etc/apt/preferences.d/nodejs
apt-get update
apt-get install -y caddy nodejs

node_major_now=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major_now" = "$NODE_MAJOR" ] \
  || die "Node.js $NODE_MAJOR is needed (frontend/.nvmrc) but node $(node -v) is installed. Remove the other Node.js (apt-get remove nodejs npm) and run this again."
echo "PHP $(php -r 'echo PHP_VERSION;'), Node.js $(node -v), $(caddy version | cut -d' ' -f1 | sed 's/^/Caddy /')"

# ---------------------------------------------------------------------------------------------
step "4/11 Service user $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "User $SVC_USER exists"
else
  useradd --system --user-group --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  echo "User $SVC_USER created"
fi

# ---------------------------------------------------------------------------------------------
step "5/11 Permissions: code owned by root, data writable only by $SVC_USER"
# Code: root-owned, readable by everyone (Caddy reads public/app, PHP-FPM reads the PHP files), writable
# by root only. backend/data is skipped here: it is wms-only (0750) and Caddy can never read it.
find "$APP_DIR" -path "$DATA_DIR" -prune -o \( ! -user root -o ! -group root \) -exec chown -h root:root {} +
find "$APP_DIR" -path "$DATA_DIR" -prune -o ! -type l -exec chmod a+rX,go-w {} +
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR" "$BACKUP_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
install -d -m 0755 "$APP_DIR/backend/public/app"

# ---------------------------------------------------------------------------------------------
step "6/11 Frontend build (npm ci, npm run build -> backend/public/app)"
cd "$APP_DIR/frontend"
npm ci --no-audit --no-fund
npm run build
cd "$APP_DIR"
[ -f "$APP_DIR/backend/public/app/index.html" ] || die "the frontend build did not write backend/public/app/index.html"
chmod -R a+rX,go-w "$APP_DIR/backend/public/app"

# ---------------------------------------------------------------------------------------------
step "7/11 Config files: Caddy, PHP-FPM pool, systemd"
# Caddy: validate the new file before it replaces the live one.
sed "s/__WMS_DOMAIN__/$WMS_DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile.wms-new
caddy validate --config /etc/caddy/Caddyfile.wms-new --adapter caddyfile
chmod 0644 /etc/caddy/Caddyfile.wms-new
mv -f /etc/caddy/Caddyfile.wms-new /etc/caddy/Caddyfile

install -m 0644 "$APP_DIR/deploy/php-fpm-wms.conf" "/etc/php/$PHP_V/fpm/pool.d/wms.conf"
"php-fpm$PHP_V" -t

# systemd restarts Caddy and PHP-FPM after a crash.
for svc in caddy "php$PHP_V-fpm"; do
  install -d -m 0755 "/etc/systemd/system/$svc.service.d"
  printf '# Written by /opt/wms/deploy/install.sh (WMS, section 11.4)\n[Service]\nRestart=on-failure\nRestartSec=2s\n' \
    > "/etc/systemd/system/$svc.service.d/restart.conf"
done
install -m 0644 "$APP_DIR/deploy/wms-backup.service" "$APP_DIR/deploy/wms-backup.timer" /etc/systemd/system/
systemctl daemon-reload

# ---------------------------------------------------------------------------------------------
step "8/11 First start: data folder and admin password"
# Runs before the services start, so no stray internet request can seed the data first (R36).
# On a later run it finds the existing data and prints nothing.
cd /
sudo -u "$SVC_USER" php "$APP_DIR/backend/tools/init.php"
cd "$APP_DIR"

# ---------------------------------------------------------------------------------------------
step "9/11 Start PHP-FPM, Caddy and the backup timer (and at every boot)"
systemctl enable --now "php$PHP_V-fpm" caddy wms-backup.timer
systemctl restart "php$PHP_V-fpm" caddy wms-backup.timer
for _ in $(seq 1 20); do [ -S /run/php/wms.sock ] && break; sleep 0.5; done
[ -S /run/php/wms.sock ] || die "PHP-FPM did not create /run/php/wms.sock: see journalctl -u php$PHP_V-fpm"
systemctl is-active --quiet caddy || die "Caddy is not running: see journalctl -u caddy"

# ---------------------------------------------------------------------------------------------
step "10/11 Firewall (ufw): SSH, 80, 443"
# Allow the SSH port(s) sshd really uses, so a custom port does not lock the operator out.
ssh_ports=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u || true)
if [ -z "$ssh_ports" ]; then
  warn "could not read the SSH port from 'sshd -T'; allowing 22/tcp"
  ssh_ports=22
fi
for p in $ssh_ports; do ufw allow "$p/tcp" >/dev/null; echo "allowed SSH $p/tcp"; done
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null     # TCP and UDP (HTTP/3)
ufw --force enable
ufw status verbose

# ---------------------------------------------------------------------------------------------
step "11/11 Check https://$WMS_DOMAIN/api/health (waits up to about 60 s for the certificate)"
health=failed
for _ in $(seq 1 12); do
  if curl -fsS --max-time 5 "https://$WMS_DOMAIN/api/health" >/dev/null 2>&1; then health=ok; break; fi
  sleep 5
done
if [ "$health" = ok ]; then
  echo "OK: https://$WMS_DOMAIN/api/health answers"
else
  warn "https://$WMS_DOMAIN/api/health did not answer. Check the DNS A record, the provider firewall (80/tcp, 443/tcp, 443/udp) and 'journalctl -u caddy --since -10min'. Re-run this script once fixed."
fi

trap - ERR
cat <<EOF

=====================================================================
 WMS is installed.
   Office:   https://$WMS_DOMAIN/
   Drivers:  https://$WMS_DOMAIN/driver   (then "Add to Home screen")
   Data:     $DATA_DIR   (owner $SVC_USER, mode 0750)
   Backups:  $BACKUP_DIR  (every night at 04:30; check: systemctl list-timers wms-backup.timer)
   Update:   sudo bash $APP_DIR/deploy/update.sh
=====================================================================
EOF
if [ -f "$DATA_DIR/initial-admin.txt" ]; then
  echo
  echo "First admin login (from $DATA_DIR/initial-admin.txt; deleted after the first password change):"
  sed 's/^/   /' "$DATA_DIR/initial-admin.txt"
fi
[ "$health" = ok ] || exit 1
