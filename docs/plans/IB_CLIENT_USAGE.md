# IB Client 使用逻辑（历史：Host Trading / Host Listener）

## 当前（Engine / Daemon）

- **Daemon（`GsTrading`）**不再创建 `IBConnector`。账户与挂单等来自 **Redis**（IB Account Agent 快照）；行情来自 **Redis**（IB Ingestor）；对冲下单经 **IB Operator** RPC。
- 以下章节描述的是**已移除的**进程内 IB 分工，仅供查阅旧实现或 Celery/其他仍直连 TWS 的组件。

## 历史目标（已废弃的 Daemon 内分工）

- **Host Trading (app.connector)**：曾用于 CONNECTING；已删除。
- **Host Listener (app.listener_connector)**：曾用于 ticker / positions / open orders；已删除。
- **Secondary Listener (listener_connector_2)**：已删除。

## 其他进程

- **IB Ingestor / IB Account Agent / IB Operator**：各自使用配置的 `client_id` 连 TWS；见 `config.yaml` 与 `docs/DATABASE.md` 中的 client_id 表。
