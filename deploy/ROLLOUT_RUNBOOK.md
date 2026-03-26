# Ops Secure Control — Rollout & Rollback Runbook

## Overview

This runbook covers the Dev→Prod rollout for the Ops secure control architecture:
- **executor_mode** switch (`local` → `agent`)
- Auth token activation
- Audit persistence activation

## Prerequisites

1. bifrost-agent system user created on the target host
2. sudoers installed and validated (`deploy/sudoers/bifrost-agent`)
3. UDS socket directory exists (`/var/run/`)
4. PostgreSQL accessible for audit persistence (prod)

---

## Phase A: Dev Validation (executor_mode=local)

Config: `config.dev.yaml` ships with `executor_mode: local` and `default_role: admin`.

1. Start Ops API normally.
2. Open Dashboard — auth bar shows `ADMIN` role (no token needed in dev).
3. Test all control actions (queue binding, scale, broker control).
4. Verify audit entries appear in the Audit Trail section.
5. Confirm all operations work without the agent.

## Phase B: Dev — Agent Mode Test

1. Copy the systemd service file:
   ```bash
   sudo cp deploy/systemd/bifrost-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

2. Create the agent user (if not done):
   ```bash
   sudo useradd -r -s /usr/sbin/nologin bifrost-agent
   ```

3. Install sudoers (CRITICAL: validate first):
   ```bash
   sudo cp deploy/sudoers/bifrost-agent /etc/sudoers.d/bifrost-agent
   sudo chmod 0440 /etc/sudoers.d/bifrost-agent
   sudo visudo -c  # must report "parsed OK"
   ```

4. Start the agent:
   ```bash
   sudo systemctl start bifrost-agent
   sudo systemctl status bifrost-agent
   ```

5. Switch config to agent mode:
   ```yaml
   ops:
     executor_mode: "agent"
     agent_socket: "/var/run/bifrost-agent.sock"
   ```

6. Restart Ops API. Verify `/ops/health` shows `executor_mode: agent`.

7. Test all control actions again through Dashboard.

## Phase C: Prod — Read-Only First

1. Deploy code to prod (without changing executor_mode).
2. Config: `executor_mode: local`, tokens configured but `default_role: viewer`.
3. Test that:
   - Dashboard loads normally (viewer can see status).
   - Unauthenticated users cannot control (buttons disabled, 403 on API).
   - Authenticating with operator token enables control.
4. Verify audit persistence to PostgreSQL:
   ```sql
   SELECT COUNT(*) FROM ops_audit_log;
   ```

## Phase D: Prod — Agent Activation

1. Install agent service + sudoers (same as Phase B steps 1–4).
2. Switch config:
   ```yaml
   ops:
     executor_mode: "agent"
   ```
3. Restart Ops API.
4. Verify `/ops/health` shows `executor_mode: agent`.
5. Test one control action (e.g., restart a non-critical worker).
6. Check audit trail shows the action.
7. Gradually enable all control operations.

---

## Rollback Procedure

### Instant Rollback (< 1 minute)

If agent mode has issues, switch back to local:

1. Edit config:
   ```yaml
   ops:
     executor_mode: "local"
   ```
2. Restart Ops API:
   ```bash
   sudo systemctl restart bifrost-ops
   ```
3. Dashboard automatically works with direct systemd execution.

### Agent Issues

If the agent process is unhealthy:

```bash
sudo systemctl status bifrost-agent
sudo systemctl restart bifrost-agent
journalctl -u bifrost-agent -n 50 --no-pager
```

Check socket permissions:
```bash
ls -la /var/run/bifrost-agent.sock
# Expected: srw-rw---- bifrost-agent bifrost-agent
```

### Auth Issues

If tokens are misconfigured and operators are locked out:

1. Set `default_role: admin` temporarily in config.
2. Restart Ops API.
3. Fix token configuration.
4. Restore `default_role: viewer`.

---

## Monitoring Checklist

| Metric | Where | Alert Threshold |
|--------|-------|-----------------|
| Ops API health | `/ops/health` | Unreachable for 30s |
| Agent socket connectivity | `/ops/health → executor_mode` | Agent mode but health fails |
| 403 rate | Audit trail (denied count) | >10/min → possible misconfiguration |
| Command failure rate | Audit trail (failed count) | >3 consecutive failures |
| Audit DB connectivity | `/ops/health → audit_mode` | Should be "postgresql" in prod |

## Config Reference

```yaml
ops:
  executor_mode: "local"   # "local" = direct sudo, "agent" = UDS agent
  agent_socket: "/var/run/bifrost-agent.sock"
  auth:
    default_role: "viewer"  # unauthenticated users get this role
    allow_unauthenticated_reads: true
    tokens:
      - token: "<secret>"
        role: "operator"
        name: "trader"
      - token: "<secret>"
        role: "admin"
        name: "admin"
  audit:
    persist: true  # false = memory-only, true = PostgreSQL
```

Environment variable overrides:
- `OPS_OPERATOR_TOKEN` — auto-registers an operator token
- `OPS_ADMIN_TOKEN` — auto-registers an admin token
