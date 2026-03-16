# IB Client 使用逻辑（Host Trading / Host Listener / Secondary Listener）

## 目标

- **Host Trading (app.connector)**：仅保留给未来在线实时交易使用，当前**不挂任何逻辑与订阅**；项目尚未开发实时交易，因此该 Client 理论上可以不存在也不影响现有功能。
- **Host Listener (app.listener_connector)**：Host 侧**所有事件订阅**，包括 Real-time ticker、Open orders、Positions、Fills 等。
- **Secondary Listener (listener_connector_2)**：仅用于订阅 Secondary IB 账号的 Open orders、Positions、Fills、Commission report。

## 实施状态

- **daemon_handlers**：已整改。RUNNING 时先连 Host Listener，再在其上挂 ticker、positions、order_status、open_order、fills；Open orders 合并仅使用 Host Listener + Secondary Listener；不再对 Host Trading 做任何订阅或拉取 open orders。Heartbeat 的 ib_connected/ib_client_id 取自 Host Listener；stop 时从 Host Listener 取 get_subscribed_ticker_symbols。
- **control_heartbeat**：event_subscribe_flags、write_daemon_heartbeat、ticker 同步与 refresh/release/init_ticker 控制命令、release_ib 条件、“未连接”重试逻辑均改为基于 Host Listener（_host_listener(app)）。refresh_accounts / refresh_replay 仍用 app.connector（accounts 模块尚未迁移）。
- **contract_quote_live**：Ticker 订阅/退订、get_subscribed_ticker_symbols、get_instrument_price（R-M6）均改为通过 _ticker_connector(app)（Host Listener）。
- **CONNECTING**：仍连接 Host Trading（保证 handle_connected / snapshot / accounts 等现有读路径可用）；RUNNING 阶段 Host Trading 不参与事件与 open orders。
- **后续可选**：若希望 Host Trading 完全不存在，可将 CONNECTING 改为只连 Host Listener，并让 snapshot / accounts 等改为使用 `app.listener_connector` 做 Host 侧读取。
