# calender_WMS: WMS route calendar

A web system for a waste-collection company in Singapore. It has two apps that share one server:

- **Office app** (`/`, desktop first): a week and month **calendar** of collection **routes**.
  - Each route collects **one waste type**: REL (general waste) or Recycling. It has an ordered list of
    customers, and only customers registered with that type can be on it. A route is regular (Mon–Sat),
    special (Sundays and public holidays) or adhoc (urgent one-offs).
  - OTC, COMPACTOR and EROSE are **not planned** (there are no tasks). Drivers submit them freely, and the
    office reads them on the **Submissions** page. They count in the calendar's daily totals.
  - The office also manages customers, public holidays, waste types, trucks and users, follows the drivers'
    progress live, and corrects route results.
- **Driver app** (`/driver`, phone first): drivers claim a route for today, then record the weight, photos,
  a signature, a ticket number or a reason for each stop. At any time they can also submit an OTC, COMPACTOR
  or EROSE collection: pick the type, pick the customer, enter the weight. Results and submissions are
  queued on the phone and sent once when there is signal.
- **Server**: PHP 8.3 with no framework and no database. The data is JSON files in `backend/data`.
  - The day rolls over at 04:00 by default, because night shifts exist.
  - Every request runs under one file lock.
  - A backup runs every night.
- **Frontend**: React 18, Vite and TypeScript. The UI is in Chinese or English, chosen per user.

Documents: the design spec [docs/Project.md](docs/Project.md) (section numbers such as §11.4 below refer to
it), the user's decisions [docs/requirements.md](docs/requirements.md), and the approved
[UI mockup](docs/mockup.html).

**Try it:** an editable demo of the office calendar, with no sign-in and sample routes, runs on GitHub Pages
at <https://zjoooooo.github.io/calender_WMS/> (section 4).

| | Local (Windows PC) | Production (Linux VPS) |
|---|---|---|
| Used for | development, demos, trials on the office network | daily use from the office and from phones on 4G |
| Started by | `start.bat` (or `build.bat` + `start-backend.bat`) | systemd, at boot (`deploy/install.sh` sets it up) |
| Web server | `php -S` (one request at a time) + Vite dev server | Caddy (automatic HTTPS) + PHP-FPM |
| Office | `http://localhost:5173/` | `https://<domain>/` |
| Drivers | `http://<pc-ip>:5173/driver` | `https://<domain>/driver` |

---

## 1. Quick start on Windows (local development and trials)

### Prerequisites
- **PHP 8.3** (8.3 or newer).
  - Download the "VS16 x64 Non Thread Safe" zip of PHP 8.3 from <https://windows.php.net/download/>.
  - Unzip it to `C:\php`, and add `C:\php` to `Path` (Start → "Edit the system environment variables" →
    Environment Variables).
  - In a new terminal, `php -v` must show 8.3.x.
  - You do not need a `php.ini`: the server only uses PHP's built-in functions.
- **Node.js 22**, not 23 or 24: the frontend pins Node 22, and `npm` refuses other versions.
  - Use the Windows installer (`node-v22.*-x64.msi`) from <https://nodejs.org/dist/latest-v22.x/>.
  - `node -v` must show v22.x.
- This repository: `git clone <repo-url>`, or download it as a ZIP and unzip it.

### Start
1. Double-click **`start.bat`**. It opens two windows:
   - **WMS backend**: the API on port 8080;
   - **WMS frontend**: the Vite dev server on port 5173. The first time, it installs the packages
     (`npm ci`), which takes a few minutes.
2. **First admin password.** The first start creates the data folder `backend\data`. The **WMS backend**
   window then shows:
   ```
   WMS first start: data folder created.
     Admin login:  username admin   password <12 random characters>
   ```
   The password is also saved in **`backend\data\initial-admin.txt`**. That file is deleted after the
   first password change. There is no fixed default password.
3. Open **<http://localhost:5173/>**, sign in as `admin`, and choose a new password (at least 8
   characters). Then create office users, drivers, customers and trucks.
4. **Drivers** on the same Wi-Fi or office network open **`http://<pc-ip>:5173/driver`**.
   - `<pc-ip>` is this PC's IPv4 address; run `ipconfig` to find it.
   - When Windows asks, allow PHP and Node.js on **Private** networks. Or run these in an administrator
     terminal:
     ```
     netsh advfirewall firewall add rule name="WMS 5173" dir=in action=allow protocol=TCP localport=5173 profile=private
     netsh advfirewall firewall add rule name="WMS 8080" dir=in action=allow protocol=TCP localport=8080 profile=private
     ```
   - The offline app shell and "Add to Home screen" need HTTPS, so test those on the VPS
     (`https://<domain>/driver`).
5. **Stop** by closing both windows, or pressing Ctrl+C in each.

### Trial without the dev server
Run **`build.bat`** once. It builds the frontend into `backend\public\app`. After that,
**`start-backend.bat`** alone serves the whole app:
- office at `http://localhost:8080/` or `http://<pc-ip>:8080/`;
- drivers at `http://<pc-ip>:8080/driver`.

Run `build.bat` again after every frontend change.

### The scripts (§11.3)
| Script | What it does |
|---|---|
| `start.bat` | Opens `start-backend.bat` and `start-frontend.bat` in two windows. |
| `start-backend.bat` | Checks PHP 8.3 and creates the data folder on the first start (printing the admin password). Then it runs `php -S 0.0.0.0:8080` and restarts it after a crash. |
| `start-frontend.bat` | Checks Node.js 22. It runs `npm ci` on the first start and again whenever `package-lock.json` changes (for example after a `git pull`). Then it runs Vite on `0.0.0.0:5173`, with `/api` proxied to `127.0.0.1:8080`. |
| `build.bat` | Checks Node.js 22, installs packages if needed, and builds the frontend into `backend\public\app`. |

### Local data
- `backend\data` (git-ignored) holds everything: `plan.json`, `users.json`, `days\`, `files\` (photos),
  `audit\` and `secret.key`.
- **Start from scratch:** stop the backend and delete `backend\data`. This deletes all local data. The next
  start creates new data and prints a new admin password.
- **Use another data folder,** for example a copy of a VPS backup. In a terminal, run
  `set WMS_DATA_DIR=C:\path\to\folder`, then `start-backend.bat` in the same terminal. Or set `data_dir` in
  the git-ignored `backend\config.local.php`, which returns an array of config overrides.
- **Back up by hand:** `php backend\tools\backup.php C:\wms-backups [--keep 30]`.

---

## 2. Development notes

### Backend (PHP 8.3, no Composer)
- **Local start:** `start-backend.bat`. It creates the data folder on the first start and prints the
  generated admin password in its console. The password is also in `backend\data\initial-admin.txt`; that
  file is deleted after the first password change.
- **Without the .bat:**
  1. Run `php backend/tools/init.php`.
  2. Create `backend/public/app`.
  3. Run `php -S 0.0.0.0:8080 -t backend/public/app backend/public/index.php`.
- **Data folder:** `backend/data` (git-ignored). To use another one, set the environment variable
  `WMS_DATA_DIR`, or set `data_dir` in the git-ignored `backend/config.local.php` (it returns an array of
  config overrides). Never edit the tracked `backend/config.php` for a server or a demo.
- **Demo clock:** set `fake_now` in `config.local.php`, or `WMS_FAKE_NOW`. It is honoured only when the data
  folder contains a `.demo` marker file. Use it only on a copy of the data folder, never on live data.
- **Backup by hand:** `php backend/tools/backup.php <folder> [--keep 30]`.

### Frontend (React 18 + Vite + TypeScript)
- **Dev server (Windows):** `start-frontend.bat` (port 5173, with `/api` proxied to `http://127.0.0.1:8080`).
  - Without the .bat: `cd frontend && npm ci && npm run dev`.
  - Another backend port: `VITE_API_TARGET=http://127.0.0.1:8280 npm run dev`.
- **Build:** `build.bat`, or `cd frontend && npm run build`. It type-checks, then builds the app into
  `backend/public/app`, which `start-backend.bat` then serves on port 8080.
- **Demo data:** with the backend running, run
  `node frontend/scripts/seed-demo.mjs --api http://127.0.0.1:8080 --data-dir backend/data [--with-runs]`.
  - It creates about 12 REL routes a day and two Recycling routes, customers (REL, Recycling, OTC,
    COMPACTOR, EROSE), trucks and drivers, like the approved mockup.
  - It is idempotent. It changes the first-start admin password to `demo-pass-2026` and prints it.
  - `--with-runs` also lets drivers claim a few of today's routes and submit an OTC and a COMPACTOR
    collection.
  - Use it on a demo copy, not on live data.
- **Texts:** `frontend/src/i18n/{common,office,driver}.{zh,en}.ts`. Add every key to both languages;
  `npm run i18n:check` and `tsc` fail when they differ.
- **API:** `frontend/src/api.ts` is the only file that knows the backend JSON (types and one function per
  endpoint).

---

## 3. Tests

**Backend** (from the repo root; PHP 8.3 on PATH):
```
php backend/tests/run.php                              # rule tests; optional filter, e.g. "customers:" or "runs_"
php backend/tests/api_smoke.php 8180 /tmp/wms-test-smoke   # real HTTP through php -S on port 8180
php backend/tests/backup_test.php                      # tools/backup.php: dated folders, hard links, --keep
php backend/tests/race.php 8182 /tmp/wms-test-race     # 10 simultaneous claims on one job: exactly one wins;
                                                       # one submission sent many times at once: one record
```
- `api_smoke.php` and `race.php` start and stop their own `php -S`. They **wipe the data folder** you
  give them, so never point them at real data.
- On Windows, use a folder such as `%TEMP%\wms-test-smoke`.

**Frontend** (in `frontend/`, Node.js 22):
```
npm ci                 # once
npm test               # vitest: i18n key parity, API client, helpers, stop reordering, rollover refetch
npm run typecheck      # tsc --noEmit
npm run build          # type check + production build into ../backend/public/app
npm run e2e            # Playwright: login, password change, zh/en, customers, holidays, settings, users
npm run e2e:office     # Playwright at 1440x1000: calendar, drawer edits, drag and drop, a Recycling route,
                       # the Submissions page, runs
npm run e2e:driver     # Playwright as two phones (Pixel 7): claim race, results with photo + signature,
                       # switch route, offline outbox (exactly once), free submissions (also offline),
                       # leave, finish, office release
npm run e2e:demo       # the calendar demo build (section 4) in Chromium, from a plain static server
```
- The `e2e*` scripts need PHP 8.3 and `playwright` with Chromium. To install them:
  `npm install --no-save playwright && npx playwright install chromium`. The next `npm ci` removes it.
- Each e2e script starts its own backend and Vite on its own ports, and wipes its own temp data folder:
  - `e2e` uses ports 8280/5280 and `/tmp/wms-test-shell`;
  - `e2e:office` uses ports 8281/5281 and `/tmp/wms-test-office`;
  - `e2e:driver` uses ports 8282/5282 and `/tmp/wms-test-driver`. With `PWA=1` it also runs
    `npm run build` and checks that the built app opens with zero signal (service worker + cached Today).
- Ports and the data folder can be changed with `BACKEND_PORT`, `FRONT_PORT` and `WMS_DATA_DIR`.
  `E2E_SHOTS=<dir>` saves screenshots. `WMS_FAKE_NOW=2026-11-11T10:00:00+08:00` pins the server clock, as on
  GitHub Actions; without it the suites run on the real date.
- `e2e:demo` needs `npm run build:demo` first. It serves `dist-demo` on ports 5826 and 5827 (`DEMO_PORT`,
  `DEMO_PORT2`) and needs no backend.
- The browser tests are written for Linux and run there on GitHub Actions on every push. They need
  **PHP 8.3** (`php` on the PATH, also for `npm run demo:data`) and **Node.js 22** (`frontend/.nvmrc`;
  `frontend/.npmrc` sets `engine-strict`, so `npm ci` refuses another major version). On Windows, set the
  variables in PowerShell with `$env:NAME = "value"`.

**Deployment scripts:** `bash -n deploy/install.sh deploy/update.sh` and
`shellcheck deploy/install.sh deploy/update.sh`.

### Tests on GitHub Actions
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push (any branch), every pull request, a
manual run (**Actions > CI > Run workflow**) and every Monday (§11.5):

| Job | What it checks |
|---|---|
| Backend (PHP 8.3) and server scripts | `run.php`, `api_smoke.php`, `race.php`, `backup_test.php`; `bash -n` and shellcheck of `deploy/*.sh` |
| Frontend | `tsc --noEmit`, vitest, the dev server's dependency scan (`vite optimize --force`), `npm run build`, and that the production build has no demo code |
| Browser tests (shell, office, driver) | the three Playwright suites, with the server clock pinned (`WMS_FAKE_NOW`), so a run does not depend on the day; the driver suite with `PWA=1` |
| Calendar demo | `npm run demo:data`, `npm run build:demo` and `e2e/demo.e2e.cjs`; the build is kept as the artifact `calendar-demo` |
| Publish the calendar demo to GitHub Pages | `main` only, after all the others pass (section 4) |

- The result shows on each commit and pull request (a green tick or a red cross). Open the run in the
  **Actions** tab for the log of each step.
- When a browser suite fails, its log and screenshots are attached to the run (Artifacts, kept 14 days).
- A newer push to the same branch cancels the older run's tests.
- Nothing is deployed to a server.

---

## 4. Calendar demo on GitHub Pages (§11.5)

A demo of the office calendar that anyone can open: no sign-in, sample routes (REL and Recycling), customers,
today's driver runs and two driver submissions. It is **editable**. The real backend (the same PHP files as on a server) runs inside the
visitor's browser, compiled to WebAssembly (WordPress Playground's php-wasm), so every rule behaves exactly as
in the real system. Nothing is sent to a server.

**Turn it on (once):**
1. Make the repository **public**: **Settings > General > Danger Zone > Change visibility**. GitHub Pages for
   a private repository needs a paid plan.
2. Open **Settings > Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main`, or open **Actions > CI > Run workflow** on `main`. When every test passes, the job
   "Publish the calendar demo to GitHub Pages" publishes it.

**URL:** <https://zjoooooo.github.io/calender_WMS/> (in general `https://<owner>.github.io/<repository>/`).

**How it updates:**
- It is rebuilt and published by every push to `main`, every manual run on `main`, and every Monday morning
  (Singapore time), so its sample runs stay recent.
- Until Pages is turned on, that job ends green with a warning, and its summary says what to do.
- Every run, also on other branches and pull requests, keeps the build as the artifact `calendar-demo`
  (14 days).

**What a visitor gets:**
- The office app, signed in as the demo admin, on the month view of the visitor's own date.
- Everything on the calendar can be changed: routes, the customers of a route (add, remove, drag),
  "only this date" or "and all following", change schedule, copy, holidays. Routes, Submissions, Customers, Holidays
  and Settings work too. Users, sign-out and the driver app are left out.
- The first visit downloads the PHP runtime: 18 MB, about 7 MB when the host compresses it. A loading screen
  shows the progress. Later visits use the browser's cache.
- Tested in Chromium (Chrome, Edge), with both PHP runtimes the demo carries. Firefox and Safari should load
  the second one (Asyncify), but they have not been tested yet. Any static web host and any sub-path work: no
  special server settings are needed.

**The data stays in the visitor's browser:**
- Each change is saved in that browser only (IndexedDB) and is still there after a reload. Other visitors and
  other browsers always start from the original sample data. Just opening the demo saves nothing.
- **重置演示数据 / Reset demo data**, in the banner at the top, deletes the visitor's changes and restores the
  original data.
- Every new deploy, the weekly one too, brings new sample data. A visitor who changed nothing simply gets it.
  Changes saved from an earlier deploy are reset, with a short notice.
- With the demo open in two tabs, a tab never overwrites what the other one saved. When the demo changes in
  another tab, the banner says so, stops saving in this tab and offers **Reload this page**.
- In a browser that does not allow storage (some private windows), the demo still works; the banner says that
  changes are lost on reload.

**Build and try it locally** (in `frontend/`, with PHP 8.3 and Node.js 22):
```
npm run demo:data      # sample data made by the real backend (php -S on a free port + scripts/seed-demo.mjs)
npm run build:demo     # -> frontend/dist-demo/ (makes the data first when demo-data/ is missing)
npm run e2e:demo       # Chromium test of dist-demo under /calender_WMS/ and under a random prefix
npm run dev:demo       # the demo with the Vite dev server
```
`dist-demo` is a static site. Open it through a web server (for example `npx vite preview --outDir dist-demo`),
not as a file. `demo-data/` and `dist-demo/` are git-ignored.

---

## 5. Production on a Linux VPS (§11.4, §12)

### What runs on the server
| Part | What it does |
|---|---|
| Caddy (`caddy.service`, official Caddy apt repository) | Listens on 80 and 443 and gets and renews the Let's Encrypt certificate by itself. Redirects HTTP to HTTPS and adds the security headers. Serves the built app from `/opt/wms/backend/public/app` and passes `/api/*` to PHP-FPM. |
| PHP 8.3-FPM (`php8.3-fpm.service`, pool `wms`) | Runs `backend/public/index.php` as the service user `wms` on a Unix socket. It never listens on a TCP port. |
| `/opt/wms` | The git clone. The code is owned by root and read-only for `wms`. Only `backend/data` (0750, owner `wms`) and `/var/backups/wms` are writable by `wms`. Caddy cannot read `backend/data`. |
| systemd | Starts Caddy and PHP-FPM at boot and restarts them on failure. Runs `wms-backup.timer` every night at 04:30. |
| `ufw` | Allows only SSH, 80/tcp and 443 (TCP and UDP). |

The deployment files are in [`deploy/`](deploy):

| File | Installed as |
|---|---|
| `install.sh` | Run once (safe to re-run). |
| `update.sh` | Run for each new version. |
| `Caddyfile` | `/etc/caddy/Caddyfile`, with the domain filled in. |
| `php-fpm-wms.conf` | `/etc/php/8.3/fpm/pool.d/wms.conf` (includes the 3 MB request-body limit). |
| `wms-backup.service`, `wms-backup.timer` | `/etc/systemd/system/` |

### Before you install
1. **A VPS** running **Ubuntu 24.04 LTS**, in a Singapore region.
   - Suggested size: 1 vCPU, 2 GB RAM (the frontend is built on the server) and 50 GB SSD.
   - Turn on the provider's **automatic weekly snapshots**.
2. **A domain name**, for example `wms.<company>.com.sg`, with a **DNS A record** pointing at the VPS.
   - The record must be **DNS only, not proxied**: in Cloudflare, use the grey cloud, not the orange one.
     Behind a proxy all clients share a few IP addresses, so the per-IP login lockout would lock a username
     for everyone.
   - Remove any AAAA record that points somewhere else.
3. **The provider's firewall** (security group) must allow your SSH port, **80/tcp, 443/tcp and 443/udp**.
   Some providers open only 22 and 80 by default (AWS Lightsail, for example), and `ufw` alone is not
   enough.
4. **SSH key login** to the VPS, as a user that can run `sudo`.
5. **For a private repository**, a read-only **deploy key**:
   - run `sudo ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ''`;
   - add `/root/.ssh/id_ed25519.pub` as a read-only deploy key of the repository;
   - clone over SSH (`git@github.com:<owner>/<repo>.git`).

   `update.sh` pulls with the same key.

### Install
```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone <repo-url> /opt/wms
cd /opt/wms
sudo bash deploy/install.sh wms.example.com.sg        # or: sudo WMS_DOMAIN=wms.example.com.sg bash deploy/install.sh
```
- `bash deploy/install.sh` works even if the execute bit was lost.
- The repository must be at `/opt/wms`.
- The script stops with a clear message at the first problem, and it is safe to run again.
- At the end it prints the office and driver URLs and the **first admin password**. You can read the
  password again with `sudo cat /opt/wms/backend/data/initial-admin.txt` until the first password change.

What `install.sh` does, in order:
1. **Checks** that it runs as root on Ubuntu 24.04, that the domain is valid, and that the repo is at
   `/opt/wms`. It warns, without stopping, when the domain does not resolve to this server.
2. **System:** sets the time zone to `Asia/Singapore` and adds a 1 GB swap file when the server has less
   than 2 GiB of RAM. Ubuntu's unattended security upgrades stay on.
3. **Packages:**
   - `php8.3-fpm`, `php8.3-cli`, `php8.3-opcache`, `git`, `ufw` and `curl`;
   - Caddy from its official apt repository;
   - Node.js from NodeSource, at the major version in `frontend/.nvmrc` (22).
4. **Service user:** `wms`, a system user with no login shell.
5. **Permissions:**
   - the code is owned by root and is not writable by others;
   - `backend/data` and `/var/backups/wms` are `wms:wms` 0750.
6. **Frontend build:** `npm ci && npm run build`, into `backend/public/app`.
7. **Config files:** the Caddyfile (validated with `caddy validate` before it replaces the live one), the
   PHP-FPM pool (`php-fpm8.3 -t`), systemd `Restart=on-failure` drop-ins for Caddy and PHP-FPM, and the
   backup service and timer.
8. **First start:** runs `sudo -u wms php backend/tools/init.php` **before** the services start, so no
   stray internet request can create the data first. It creates the data and prints the admin password.
   On a later run it finds the data and prints nothing.
9. **Start:** `systemctl enable --now php8.3-fpm caddy wms-backup.timer`, then a restart, so the new
   config is live and everything starts again after a reboot.
10. **Firewall:** allows the SSH port(s) that `sshd -T` reports, so a custom port does not lock you out.
    Then it allows 80/tcp and 443 (TCP and UDP) and runs `ufw --force enable`.
11. **Check:** calls `curl https://<domain>/api/health`, retrying for about a minute while the certificate
    is issued.

Re-running `install.sh` (for example after `deploy/` changed, or to change the domain) rewrites the config
files and restarts the services. It never changes `backend/data` beyond its ownership and mode.

### After the install: switch off SSH password login (§12)
Do this only once your SSH key login works:
```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/00-wms.conf
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -i passwordauthentication          # must say: passwordauthentication no
```
The file is named `00-…` because sshd keeps the first value it reads. Many cloud images ship
`50-cloud-init.conf` with `PasswordAuthentication yes`.

### Use
- **Office PCs** open `https://<domain>/`.
- **Drivers** open `https://<domain>/driver` on their phones, then use the browser's
  "Add to Home screen".
- **After a reboot** (for example after a kernel update) nobody needs to log in on the server: systemd
  starts Caddy and PHP-FPM again, and Caddy renews the certificate by itself.

### Ship a new version
```bash
sudo bash /opt/wms/deploy/update.sh
```
In order, it:
1. makes a backup (`systemctl start wms-backup`). If the backup fails, nothing is updated.
2. runs `git pull --ff-only`;
3. builds the frontend into `backend/public/app.new` while the live app keeps running. A failed build
   leaves the site as it was.
4. copies the old `assets/` files into the new build, so an office tab still open on the old version can
   still load its chunks;
5. swaps the folders (`app` → `app.old`, `app.new` → `app`) and deletes the old one;
6. reloads PHP-FPM, which clears OPcache.

Data and config files are not touched. When the update changed files in `deploy/`, the script says so:
then re-run `sudo bash /opt/wms/deploy/install.sh <domain>` to apply them.

### Backups
- **When and where:** every night at **04:30** server time, just after the default 04:00 day rollover.
  - Each backup is a dated folder `/var/backups/wms/YYYY-MM-DD_HHMMSS`.
  - It holds the whole data folder: `plan.json`, `users.json`, `days/`, `secret.key`, `audit/`, the
    `*.bak` files and `files/`.
  - Folders older than 30 days are deleted.
  - `backup.php` takes the same lock as the server, so the JSON files come from one moment.
  - A backup missed while the server was off runs at the next boot.
- **Photos are stored once.** A photo already in the previous folder is hard-linked, not copied, so
  `du -sh /var/backups/wms` grows by about one day of photos per night.
- **Check:** run `systemctl list-timers wms-backup.timer`, `systemctl status wms-backup` and
  `journalctl -u wms-backup -n 50`.
  - The unit shows **failed** when the backup could not be written.
  - It also shows failed when the disk has **under 15% free**. In that case the backup is still written;
    resize the disk or move `files/` to a mounted volume.
- **Back up now:** `sudo systemctl start wms-backup`.
  - Do not run `backup.php` or `init.php` as root by hand: files they create would be owned by root, and
    PHP-FPM could no longer write the data. If that happened, re-run `install.sh`; it fixes the ownership.
  - To run a tool by hand, use `sudo -u wms php /opt/wms/backend/tools/<tool>.php …`.
- **Off-server copy, monthly:** `/var/backups/wms` is on the same disk as the data, so also keep a copy on
  the office PC:
  ```bash
  sudo tar -C /var/backups/wms -czf ~/wms-<date>.tgz <folder>      # on the VPS (tar keeps the hard links)
  scp <you>@<vps>:wms-<date>.tgz .                                  # on the office PC
  ```

### Restore
Always restore a **whole folder**, never single files over live data: day files written after the backup
would no longer match the restored plan.
```bash
sudo systemctl stop wms-backup.timer php8.3-fpm
sudo mv /opt/wms/backend/data /opt/wms/backend/data.before-restore-$(date +%Y%m%d-%H%M%S)
sudo cp -a /var/backups/wms/<folder> /opt/wms/backend/data
sudo chown -R wms:wms /opt/wms/backend/data && sudo chmod 0750 /opt/wms/backend/data
sudo systemctl start php8.3-fpm wms-backup.timer
```
A backup without `secret.key` still opens. The server makes a new key, and every user signs in again.

**Restore drill** (open a backup without touching live data):
- **On the Windows PC:**
  1. Copy the folder down (see above) and unpack it, for example to `C:\wms-restore\<folder>`.
  2. In a terminal, run `set WMS_DATA_DIR=C:\wms-restore\<folder>`, then `start-backend.bat` in the same
     terminal.
  3. Open `http://localhost:8080/`, after `build.bat`.
- **On the VPS:**
  ```bash
  sudo cp -a /var/backups/wms/<folder> /tmp/wms-drill && sudo chown -R wms:wms /tmp/wms-drill
  sudo -u wms env WMS_DATA_DIR=/tmp/wms-drill php -S 127.0.0.1:8099 -t /opt/wms/backend/public/app /opt/wms/backend/public/index.php
  ```
  Then, in a second SSH session, run `curl http://127.0.0.1:8099/api/health`. Stop the drill server with
  Ctrl+C and delete `/tmp/wms-drill`.
- Never add a `.demo` marker to live data.

### Logs
| What | Command |
|---|---|
| Caddy (certificates), and PHP warnings and errors with stack traces (through `capture_stderr`) | `journalctl -u caddy` |
| The PHP-FPM master process | `journalctl -u php8.3-fpm` |
| Backups | `systemctl status wms-backup`, `journalctl -u wms-backup` |
| Every successful write request (one JSON line each, passwords removed) | `sudo ls /opt/wms/backend/data/audit/` |

Caddy does not log every request; the Caddyfile is kept as in the spec. To log every request in
`journalctl -u caddy`:
1. Add a line `log` inside the site block of `deploy/Caddyfile`.
2. Re-run `install.sh`.

Expect about 75 MB of journal a day with 25 phones polling.

### Change the domain
1. Point the new domain's A record at the VPS.
2. Run `sudo bash /opt/wms/deploy/install.sh <new-domain>`.

Drivers then need to add the home-screen icon again.

### Troubleshooting
- **No certificate, or the health check fails:**
  - check the A record (`getent hosts <domain>`);
  - check that the provider firewall allows 80/tcp, 443/tcp and 443/udp, and that the record is not
    proxied;
  - read `journalctl -u caddy --since -30min`.

  Then re-run `install.sh`.
- **503 `DATA_CORRUPT`:** a data file does not decode. The message names the file. Restore its `.bak`
  copy, or restore the last backup.
- **503 `CLOCK_BEHIND_FREEZE`:** the server clock is behind the days already frozen. Check `timedatectl`:
  "System clock synchronized" must say yes.
- **500 errors:** the PHP error and its stack trace are in `journalctl -u caddy`.

---

## 6. Public holidays 2027: please confirm

The Singapore 2027 list in `backend/seed/holidays-sg.json` was taken from **news coverage of the MOM
announcement**. It was not checked against mom.gov.sg. Please compare it with the official list at
<https://www.mom.gov.sg> (public holidays), and correct any wrong date on the **Holidays** page:

| Date | Holiday |
|---|---|
| 2027-01-01 | New Year's Day |
| 2027-02-06 | Chinese New Year |
| 2027-02-07 | Chinese New Year Day 2 |
| 2027-02-08 | Chinese New Year (observed) |
| 2027-03-10 | Hari Raya Puasa |
| 2027-03-26 | Good Friday |
| 2027-05-01 | Labour Day |
| 2027-05-17 | Hari Raya Haji |
| 2027-05-20 | Vesak Day |
| 2027-08-09 | National Day |
| 2027-10-28 | Deepavali |
| 2027-12-25 | Christmas Day |

The 2026 list is seeded as well. From 2028 on, the office enters each year's holidays on the Holidays page.
The calendar shows a banner for any year that has no holidays yet.
