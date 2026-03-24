# FastAPI 扩展方案

Status Server（FastAPI）在期权 Massive Feed 链路中的读路径缓存、job 合并、新增路由与实时推送方案。基于现有 `servers/routers/research.py` 端点。

**前置阅读**：[ARCHITECTURE_AND_RESEARCH.md](ARCHITECTURE_AND_RESEARCH.md) §4。  
**索引**：[README.md](README.md)。

---

## 1. 现有端点盘点

以下端点已实现（详见 [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.10.1）：

| 路由 | 方法 | 说明 |
|------|------|------|
| `/research/massive/status` | GET | 配置摘要 |
| `/research/option-expirations` | GET | 到期与行权价（provider=auto/ib/massive） |
| `/research/option-snapshots` | GET | PG 最新快照行 |
| `/research/option-oi` | GET | 日终 OI |
| `/research/option-trades` | GET | 逐笔成交（Developer） |
| `/research/massive/sync` | POST | 入队异步任务 |
| `/research/massive/jobs/{id}` | GET | 任务状态 |
| `/research/massive/greeks-coverage` | GET | Greeks 覆盖率 |
| `/research/massive/contracts-coverage` | GET | 合约覆盖率 |
| `/research/massive/market-ops/*` | GET | 市场运营只读 |
| `/research/massive/technical-indicators/*` | GET | 技术指标只读 |
| `/bars` | GET | K 线（source=massive/ib） |

---

## 2. 已有端点增强

### 2.1 `GET /research/option-snapshots` — 读路径缓存

**问题**：每次查询直接走 PG `DISTINCT ON`，无缓存；高频刷新时 PG 压力大。

**方案**：Stale-while-revalidate 模式

1. 请求到达时先查 Redis `massive:snapshot_cache:{symbol}:{expiration}:{source}`。
2. 命中且 age < `snapshot_cache_ttl`（默认 120s）→ 直接返回（响应头 `X-Cache: HIT`）。
3. 未命中或过期 → 查 PG，写 Redis 缓存，返回。
4. 若使用物化视图 `option_snapshots_latest`，查询从视图读（更快）。

### 2.2 `POST /research/massive/sync` — Job 合并

**问题**：多次 Load quotes 或多用户同时点击同一标的，产生重复 pending job。

**方案**（对齐 [WORKER_PLAN](WORKER_PLAN.md) §5）：

1. 计算 `payload_hash`。
2. 查 `job_massive_backfill WHERE status IN ('pending','running') AND payload_hash = ?`。
3. 命中 → 返回已有 `job_id`，HTTP 200（`"deduplicated": true`）。
4. 未命中 → INSERT 新 job，正常返回。

### 2.3 `GET /research/option-expirations` — 浏览器侧 Cache-Control

到期日列表是慢变数据。增加 `Cache-Control: max-age=300`（5 分钟），前端 SWR 也可据此设 `staleTime`。

---

## 3. 新增端点

### 3.1 Max Pain

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /research/max-pain` | GET | 查询 `max_pain_daily` 表；参数 `symbol`、可选 `expiry`、`trade_date_gte/lte`、`limit` |
| `GET /research/max-pain/latest` | GET | 最新交易日的 max pain（快捷） |

详见 [MAX_PAIN_REPORT.md](MAX_PAIN_REPORT.md)。

### 3.2 WS 状态

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /research/massive/ws-status` | GET | 从 Redis `massive:meta:status` 读取 WS ingest 在线状态、最后消息时间、重连次数 |

### 3.3 对账结果

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /research/massive/reconciliation` | GET | 查询最近对账结果（pass/warn/fail、合约数差异等）；参数 `symbol`、`trade_date` |

### 3.4 实时推送（SSE / WebSocket 转发）

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /research/massive/stream` | SSE | 订阅 Redis `massive:channel`，转发 contract_key 级更新摘要（mid、iv、greeks、ts）到前端 |
| `WS /research/massive/ws` | WebSocket（可选） | 双向通道，前端可动态 subscribe/unsubscribe contract_key |

**实现方式**：复用现有 SSE 模式（如 `GET /quotes/stream` 的 Redis subscribe 模式），在 `servers/routers/research.py` 或新建 `servers/routers/massive_stream.py` 中实现。

---

## 4. 认证与限流

- 现有 Status Server 无认证（LAN 内部署）。新增端点继承现有策略。
- 若未来开放公网，可在 Nginx 层加 Basic Auth 或 Token；FastAPI 层可用 `slowapi` 做 rate limit（占位，暂不实现）。

---

## 5. 路由组织

| 文件 | 职责 |
|------|------|
| `servers/routers/research.py` | 现有 Massive 相关端点，增强缓存与去重逻辑 |
| `servers/routers/massive_stream.py`（新建） | SSE/WS 实时推送 |
| `servers/routers/reports.py`（新建，可选） | Max Pain 等报表端点（若路由数增多再拆） |

---

## 6. 健康检查扩展

在 `GET /status` 或 `/health` 响应中增加：

```json
{
  "massive": {
    "configured": true,
    "tier": "starter",
    "ws_connected": false,
    "last_snapshot_age_s": 3600,
    "pending_jobs": 2
  }
}
```

供前端 Feed Checklist 和运维监控使用。

---

## 7. 决策记录（已锁定）

| 编号 | 问题 | 决策 |
|------|------|------|
| FA-1 | 实时推送 | **仅 SSE**：`GET /research/massive/stream`（`servers/routers/massive_stream.py`），Redis `massive:channel` → 服务端订阅线程 → 与 `/quotes/stream` 同模式 |
| FA-2 | snapshot 缓存 TTL | **120s**：Redis key `massive:snapshot_cache:{symbol}:{exp_norm}:{source}:{hash(keys)}`，响应头 `X-Cache` / `Cache-Control: private, max-age=120` |
| FA-3 | Max Pain 路由文件 | **独立 `servers/routers/reports.py`**：`GET /research/max-pain`、`GET /research/max-pain/latest` |
