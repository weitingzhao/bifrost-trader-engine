# Deploy to Linux over SSH (Prod)

Prod stack on a single host (e.g. `192.168.10.70`): Engine, status server, Celery; Redis/PostgreSQL as configured in `config/config.prod.yaml`. See [ARCHITECTURE.md](../ARCHITECTURE.md) §2.4.

**Automation script**: [`scripts/bifrost_ssh.sh`](../../scripts/bifrost_ssh.sh) — SSH to the host, optionally `rsync` + remote venv/npm build, optionally `systemctl` on `bifrost-*` units. The legacy name `scripts/deploy_remote.sh` is a thin wrapper that forwards to it.

## Prerequisites

**On the Linux server**

- Python 3.10+ and a working `venv` module. On **Debian/Ubuntu**, the minimal Python install often omits `ensurepip`; install the matching package once (then deploy can create `.venv`):

  ```bash
  sudo apt update
  sudo apt install -y python3-venv
  # if your default python3 is 3.12 and the above is not enough:
  # sudo apt install -y python3.12-venv
  ```

- **Node.js LTS** and `npm` (for `npm ci` and `npm run build` under `frontend/`). Install separately if missing (e.g. [NodeSource](https://github.com/nodesource/distributions), `nvm`, or your distro’s `nodejs` package).
- `rsync` and SSH server (for deploy from your dev machine)
- Redis and PostgreSQL reachable from that host (not installed by this repo’s deploy script)

**On your dev machine**

- `rsync`, `ssh`
- SSH access to the deploy user (e.g. `vision@192.168.10.70`)

## First-time setup on the server

1. Create the app directory (must match `DEPLOY_PATH` and systemd `WorkingDirectory`, default `/home/vision/bifrost-trader-engine`):

   ```bash
   mkdir -p /home/vision/bifrost-trader-engine
   ```

2. Run a **first deploy** from your dev machine (repo root). This rsyncs code (including `config/config.prod.yaml.example`), creates `.venv`, installs Python deps, and runs `npm ci` + `npm run build` on the server — **without** touching systemd:

   ```bash
   ./scripts/bifrost_ssh.sh --deploy-only
   ```

   Full usage: `./scripts/bifrost_ssh.sh --help`

3. **Production config** (not in git): either edit on the server, or keep a canonical copy on your dev machine and push it when needed.

   On the server only:

   ```bash
   cd /home/vision/bifrost-trader-engine
   cp config/config.prod.yaml.example config/config.prod.yaml
   # edit config/config.prod.yaml
   ```

   **Default**: deploy **does not** sync `config/config.prod.yaml`, so a laptop copy cannot overwrite production.

   **Optional — push local `config/config.prod.yaml`** (overwrites the file on the server — review secrets first):

   ```bash
   ./scripts/bifrost_ssh.sh --deploy-only --sync-prod-config
   # or: DEPLOY_SYNC_PROD_CONFIG=1 ./scripts/bifrost_ssh.sh --deploy-only
   ```

4. Install systemd units (paths assume deploy dir `/home/vision/bifrost-trader-engine`; edit files if you use another path).

   **Core three** (engine, Celery, Monitor):

   ```bash
   sudo cp deploy/systemd/bifrost-engine.service deploy/systemd/bifrost-server.service deploy/systemd/bifrost-celery.service /etc/systemd/system/
   ```

   **HTTP APIs** (Massive, Docs, Ops, Trading, Strategy, Portfolio, Market, Research — match `server.*_port` in YAML):

   ```bash
   sudo cp deploy/systemd/bifrost-massive.service deploy/systemd/bifrost-docs.service deploy/systemd/bifrost-ops.service \
     deploy/systemd/bifrost-trading.service deploy/systemd/bifrost-strategy.service deploy/systemd/bifrost-portfolio.service \
     deploy/systemd/bifrost-market.service deploy/systemd/bifrost-research.service /etc/systemd/system/
   ```

   **Optional**: `bifrost-apis.target` groups the nine HTTP API units for `enable` (copy like other units). **Agent** (Ops executor): `bifrost-agent.service`.

   Then reload and enable what you need:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable bifrost-engine bifrost-server bifrost-celery
   sudo systemctl start bifrost-server bifrost-celery bifrost-engine
   # enable/start additional API units as required, e.g. bifrost-trading bifrost-strategy …
   ```

   From your laptop, **interactive menu (4)** or `./scripts/bifrost_ssh.sh --install-systemd-units` registers every `deploy/systemd/*.service` and `*.target` on the host (`systemctl enable` path or `cp` + `daemon-reload`).

   Later, use `bifrost_ssh.sh` with **service flags** (`--server`, per-API flags, **`--architecture` / `--account` / `--research` / `--feed`** for HTTP category groups, `--all` for **bifrost-server only**, **`--apis`** for all nine HTTP APIs, or **`--all-stack`** for those nine + `bifrost-agent` + four Socket Services units — **no** `bifrost-celery`, **no** `bifrost-engine`) and **one action** (`--stop` / `--start` / `--restart`), optionally with **`--deploy`** to rsync + build before `systemctl`. **Trading Engine** and **Celery workers**: use the Dashboard / Ops UI (or `systemctl` on the host directly); this script does not restart `bifrost-engine` or batch-restart `bifrost-celery`.

5. Optional: schema refresh against Prod DB (only when you intend to run DDL; review `scripts/db_refresh_schema.py` first). **`--migrate` must be used with `--deploy` or `--deploy-only`:**

   ```bash
   ./scripts/bifrost_ssh.sh --deploy-only --migrate
   ```

   Run `--migrate` only after `config/config.prod.yaml` on the server points at the correct database.

## Interactive mode (no arguments)

Run `./scripts/bifrost_ssh.sh` or `./scripts/bifrost_ssh.sh -i` / `--interactive`:

1. **SSH password** is not written to disk. The script starts an SSH **ControlMaster** session so you enter the SSH password **once** (unless you use key-based auth), then `rsync` and follow-up `ssh` reuse that socket.
2. Optionally enter the **remote sudo** password once; it is kept **only in shell memory** for this process and used with `sudo -S` for `systemctl`. Leave empty to be prompted on the TTY when needed, or use **NOPASSWD** sudo for `bifrost-*` on the server.
3. The screen **redisplays** each turn: **Main menu** on top (order: systemctl one / all → quick deploy **`0`** = deploy+restart all 9 HTTP APIs; **`1`–`3`** = agent / monitor (server) / ops + optional **`R`** — **Engine** is not in this script, use Ops UI; **`a`–`d`** = HTTP category + optional **`R`**; **`q`** or empty = cancel → … → quit), then a **tail** block for the **last command’s** output (default 20 lines; wider after menu **4** systemd install); no full-screen `less` pager. **ANSI colors** when stdout is a TTY. Sub-prompts (e.g. ONE service, quick deploy) may scroll until you finish; then the next redraw restores the layout. While a **remote step** runs (SSH, `rsync`, `sudo systemctl`, reconnect), output is **streamed** to the terminal so it does not look stuck; a short **INFO** line explains that SSH/sudo may take a while.

## Routine deploy / remote systemctl

CLI summary (see `./scripts/bifrost_ssh.sh --help`):

- **Services**: at least one unit flag, or a **category** flag (`--architecture`, `--account`, `--research`, `--feed`), or **`--all`** (**bifrost-server** only), or **`--apis`** (nine HTTP API units), or **`--all-stack`** (those nine + `bifrost-agent` + four Socket Services units; no `bifrost-engine`, no `bifrost-celery` — use Dashboard for Engine and Celery). The script rejects **`--engine`**; use Ops UI for `bifrost-engine`.
- **Action** (exactly one): `--stop`, `--start`, `--restart`
- **Optional** `--deploy`: rsync + remote `pip` + `npm build`, then run `systemctl` on the selected units
- **`--deploy-only`**: only rsync + build (no `systemctl`); cannot combine with service/action flags

Examples:

```bash
# Push code + deps + frontend build, then restart Monitor (bifrost-server) only
./scripts/bifrost_ssh.sh --all --restart -deploy

# Restart every HTTP API (Monitor + research + docs + ops + domain APIs)
./scripts/bifrost_ssh.sh --apis --restart -deploy

# Full stack this script supports: HTTP APIs + agent + Socket Services (not Engine)
./scripts/bifrost_ssh.sh --all-stack --restart -deploy

./scripts/bifrost_ssh.sh -server --stop
```

Environment overrides:

```bash
DEPLOY_HOST=192.168.10.70 DEPLOY_USER=vision DEPLOY_PATH=/home/vision/bifrost-trader-engine \
  ./scripts/bifrost_ssh.sh --all --restart -deploy
DEPLOY_SYNC_PROD_CONFIG=1 ./scripts/bifrost_ssh.sh --deploy-only --sync-prod-config
```

## Config merge on the server (`config.yaml` + `config.prod.yaml`)

The app loads **`config/config.prod.yaml`** when using `--prod`. If **`config/config.yaml`** exists in the **same directory**, the runtime **deep-merges** `config.yaml` first, then overlays `config.prod.yaml` (env file wins on conflicts). So `ib:` can live only in `config.prod.yaml` while `config.yaml` has no `ib` — the merged result still contains `ib`.

If there is **no** `config.yaml` on the server, only `config.prod.yaml` is used (no merge). Your `ls` showing only `config.dev.yaml` and `config.prod.yaml` is fine: **prod alone is enough** if it includes `ib`.

After changing code or config, **restart** the systemd units so a new process loads YAML; see below if `sudo` fails from the deploy script.

## systemd actions

The script runs **one** `systemctl` subcommand (`stop`, `start`, or `restart`) on the **selected** unit names in a single remote invocation (e.g. `sudo systemctl restart bifrost-server`). With **`--all`**, the unit is **`bifrost-server`** only. With **`--apis`**, units are the nine HTTP services (Monitor, ops, docs, trading, portfolio, market, research, strategy, massive — grouped by category in status output). With **`--all-stack`**, **`bifrost-agent`** and the four Socket Services units are included after the HTTP set (`bifrost-engine` and `bifrost-celery` are **not** in this script — use Ops UI / host `systemctl`). Schedule maintenance if restarting services during market hours.

### SSH / sudo

- **Interactive terminal**: uses **`ssh -t`** so remote **`sudo` can prompt** for a password.
- **Non-interactive** (e.g. CI): uses **`sudo -n`** — requires **passwordless sudo** for the chosen `systemctl` lines.

If the script’s `systemctl` step fails, SSH in and run the same command manually, e.g.:

```bash
sudo systemctl restart bifrost-server
# Trading Engine / Celery: Dashboard / Ops UI, or e.g. sudo systemctl restart bifrost-engine / bifrost-celery on the host
```

Until units are restarted after a code deploy, **old processes keep running** old code.

Example **sudoers** snippet (adjust user; use `visudo`; extend if you use `start`/`stop` from the script):

```text
vision ALL=(ALL) NOPASSWD: /bin/systemctl start bifrost-server, /bin/systemctl stop bifrost-server, /bin/systemctl restart bifrost-server, /bin/systemctl start bifrost-celery, /bin/systemctl stop bifrost-celery, /bin/systemctl restart bifrost-celery, /bin/systemctl start bifrost-engine, /bin/systemctl stop bifrost-engine, /bin/systemctl restart bifrost-engine
```

## Nginx reverse proxy (port 80)

`bifrost-server` continues to listen on **127.0.0.1:8765** (see `server.port` in YAML). To serve the same app on **port 80** without running uvicorn as root, use **Nginx** on the Linux host (e.g. `192.168.10.70`).

**Deploying the sample config to the server**

- **`bifrost_ssh.sh` does not install Nginx** — it only **rsyncs the repo** (including `deploy/nginx/`). From your dev machine, sync code first:

  ```bash
  ./scripts/bifrost_ssh.sh --deploy-only
  ```

  (`--deploy` with a service action also runs rsync + build.) Set `DEPLOY_PATH` if the remote directory is not `/home/vision/bifrost-trader-engine`.

- **On the server**, install Nginx once, then either run the helper script **or** copy by hand:

  ```bash
  sudo apt update && sudo apt install -y nginx
  cd /home/vision/bifrost-trader-engine   # or your DEPLOY_PATH
  bash deploy/nginx/install_on_server.sh
  ```

  Helper script: [`deploy/nginx/install_on_server.sh`](../../deploy/nginx/install_on_server.sh) — copies [`deploy/nginx/bifrost-status.conf`](../../deploy/nginx/bifrost-status.conf) into `/etc/nginx/sites-available/`, enables it, **removes Ubuntu’s `sites-enabled/default`** (that default site often causes **HTML 404** on `/status` because it serves static files, not the proxy), runs `nginx -t` and reloads.

- Edit `/etc/nginx/sites-available/bifrost-status` if this host’s LAN IP is not `192.168.10.70` (adjust `server_name`).

- Ensure **`bifrost-server` is running** (`systemctl status bifrost-server`). Nginx only proxies to `127.0.0.1:8765`. Quick check without Nginx: `curl -sS http://127.0.0.1:8765/status`.

## Verification

```bash
curl -sS "http://192.168.10.70:8765/status"
curl -sS "http://192.168.10.70/status"
systemctl status bifrost-engine bifrost-server bifrost-celery
```

Open `http://192.168.10.70/` (port 80 via Nginx) or `http://192.168.10.70:8765/` directly in a browser (static UI after `frontend` build on the server).

## Changing the deploy path

If `DEPLOY_PATH` is not `/home/vision/bifrost-trader-engine`, update `WorkingDirectory` and `ExecStart` paths in `deploy/systemd/*.service` (and any copied `.target` files) to match, reinstall units, and `daemon-reload`.
