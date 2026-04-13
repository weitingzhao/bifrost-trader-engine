# Account Sync Daemon (systemd)

Independent process: consumes `ib:account:stream:v1`, persists account data to PostgreSQL, updates `account_sync_heartbeat` and Redis `bifrost:health:daemon_account_sync` (legacy key `bifrost:health:account_sync_daemon` is still read for migration).

Requires the same Redis and PostgreSQL connectivity as configured in `config/config.prod.yaml` or `config/config.dev.yaml`. IB Account Agent must be running to populate the stream.

## Units

| File | Purpose |
|------|---------|
| `bifrost-account-sync-daemon.service` | Production (`config.prod.yaml`) |
| `bifrost-account-sync-daemon-dev.service` | Dev / staging (`config.dev.yaml`) |

Copy the unit to `/etc/systemd/system/`, adjust `User`, `Group`, `WorkingDirectory`, and `ExecStart` paths, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bifrost-account-sync-daemon.service
```

Manual start (any host):

```bash
python scripts/systemd/run_account_sync_daemon.py --config config/config.prod.yaml
```

On macOS without systemd, run the same command under `tmux`/Terminal or use a launchd plist (not shipped here).

## Ops

When Ops API registers this service (`account_sync_daemon`), use **Ops → market ingest → Account Sync Daemon** for start/stop on the control host that runs `systemctl`.
