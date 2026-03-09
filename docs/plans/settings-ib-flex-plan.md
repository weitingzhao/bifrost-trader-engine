# Settings 页面 IB 二级分层与 Flex 迁移 DB 实施计划

## 目标

1. **Settings 二级分层**：将 IB 相关配置归类到「IB Connection」下，降低复杂度。
2. **Flex 配置迁移 DB**：将 `config/config.yaml` 的 `flex.accounts` 迁移到 PostgreSQL，在 Settings 中按账户配置；支持主账户与第二 IB 账户各自的 Flex Token 与 Query ID。

---

## 一、Settings 二级分层

### 1.1 当前结构

```
Settings sidebar:
├── Heartbeat
├── IB connection (primary)
├── IB connection (second)
├── IB Client ID
└── US market holidays
```

### 1.2 目标结构

```
Settings sidebar:
├── Heartbeat
├── IB Connection                    ← 一级分组（可折叠）
│   ├── Primary TWS                  ← 原 IB connection (primary)
│   ├── Second TWS                  ← 原 IB connection (second)
│   ├── Client IDs                  ← 原 IB Client ID（含 Primary account、Daemon、Monitor、Second IB、Celery）
│   └── Flex (per account)          ← 新增：Flex token + query_id 按账户配置
└── US market holidays
```

### 1.3 前端实现步骤

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1.1 | 修改 `SETTINGS_SECTIONS`：改为 `Heartbeat`、`IB Connection`（一级）、`US market holidays`；`IB Connection` 下用子锚点 `#ib-primary`、`#ib-second`、`#ib-client-ids`、`#ib-flex` | `frontend/src/pages/SettingsPage.tsx` |
| 1.2 | 侧边栏：一级项可点击跳转；`IB Connection` 展开时显示子项（或点击后滚动到第一个 IB 区块，子项用 `scroll-margin-top` 锚点） | 同上 |
| 1.3 | 主内容区：将 IB 相关 `daemon-group` 用 `id="ib-primary"`、`id="ib-second"`、`id="ib-client-ids"`、`id="ib-flex"` 包在同一个父容器内，父容器可加 `id="settings-ib-connection"` 便于整体滚动 | 同上 |
| 1.4 | 样式：子项缩进或二级标题样式，区分「IB Connection」下的区块 | `frontend/src/App.css` 或相关 |

**可选实现**：侧边栏用「可折叠」的二级结构，`IB Connection` 点击展开/收起子项；或保持扁平，点击 `IB Connection` 滚动到第一个 IB 区块，子区块用 `h3` 或 `daemon-group-subtitle` 区分。

---

## 二、Flex 配置迁移 DB

### 2.1 数据模型（当前实现）

**表 `flex_accounts`**：存 Flex Query 行；**Token 不存本表**，存于 **settings** 的 `ib_flex_host_token`、`ib_flex_secondary_token`。

| 列名 | 类型 | 说明 |
|------|------|------|
| id | serial PRIMARY KEY | 自增主键 |
| sort_order | integer NOT NULL DEFAULT 0 | 显示与拉取顺序 |
| query_label | text | Query 标签（如 "Cash Transactions"），可选 |
| purpose | text DEFAULT 'cash_transactions' | 用途：cash_transactions、trades 等 |
| query_host_id | text NOT NULL | Host IB 的 Flex Query ID（用 settings.ib_flex_host_token 拉取） |
| query_secondary_id | text | 第二 IB 的 Flex Query ID（用 settings.ib_flex_secondary_token 拉取）；可空 |

- **一行 = 同一 Label/Purpose**，Host 与 Secondary 各一个 Query ID；系统每次对两个 Query **各 call 一次**，拿回相同结构的 response。
- POST /transactions/fetch 使用 `get_flex_config(purpose='cash_transactions')` 得到的 (token, query_id) 列表，对 Host 与 Secondary 分别拉取。

### 2.2 数据库变更

| 步骤 | 内容 | 文件 |
|------|------|------|
| 2.1 | 在 `postgres_sink._ensure_tables` 中创建 `flex_accounts`（sort_order, query_label, purpose, query_host_id, query_secondary_id）；Token 在 settings | `src/sink/postgres_sink.py` |
| 2.2 | 迁移：旧表若有 query_id_cash_transactions → query_id；token/account_label → settings + account_is_host；account_is_host+query_id → query_host_id+query_secondary_id 并合并为一行一 purpose | 同上 |

### 2.3 后端（reader + app）

| 步骤 | 内容 | 文件 |
|------|------|------|
| 2.4 | `reader.get_flex_config(purpose=None)`：返回 `{ host_token, secondary_token, rows }`，rows 每项含 query_host_id、query_secondary_id、query_label、purpose | `servers/reader.py` |
| 2.5 | `reader.get_flex_config(purpose='cash_transactions')`：返回 `[{ token, query_id }, ...]`，每行对 Host/Secondary 各一条，供 POST /transactions/fetch | `servers/reader.py` |
| 2.6 | `reader.write_flex_config(status_config, host_token, secondary_token, accounts)`：Token 写 settings；accounts 为 `[{ query_host_id, query_secondary_id?, query_label?, purpose? }]`，整表替换 flex_accounts | `servers/reader.py` |
| 2.7 | POST /config/flex：body `{ host_token?, secondary_token?, accounts: [{ query_host_id, query_secondary_id?, query_label?, purpose? }] }`，调用 write_flex_config | `servers/app.py` |
| 2.8 | GET /status 的 flex_config：get_flex_config() 的 `{ host_token, secondary_token, rows }`，供 Settings 页展示与编辑 | `servers/app.py` |

### 2.4 前端（Settings 页 Flex 区块）

| 步骤 | 内容 | 文件 |
|------|------|------|
| 2.9 | `types.ts`：FlexAccountItem 为 query_host_id、query_secondary_id?、query_label?、purpose?；FlexConfig 为 host_token、secondary_token、rows | `frontend/src/types.ts` |
| 2.10 | `api.ts`：postFlexConfig(hostToken?, secondaryToken?, accounts) 调用 POST /config/flex | `frontend/src/api.ts` |
| 2.11 | Settings 页 Flex 区块：每行「Query ID (Host)」「Query ID (Secondary)」、Query Label、Purpose；从 status.flex_config.rows 加载，保存时提交 query_host_id / query_secondary_id | `frontend/src/pages/SettingsPage.tsx` |
| 2.12 | 保存逻辑：onSave 中 postFlexConfig(flexHostToken, flexSecondaryToken, flexAccounts) | 同上 |

### 2.5 配置与文档

| 步骤 | 内容 | 文件 |
|------|------|------|
| 2.13 | 从 `config/config.yaml` 中移除 `flex` 段 | `config/config.yaml` |
| 2.14 | 更新 `docs/DATABASE.md`：新增 §2.23 表 `flex_accounts`；更新 §2.9 说明 Flex 配置来源 | `docs/DATABASE.md` |
| 2.15 | 更新 `docs/FLEX_TRANSACTIONS.md`：配置改为「在 Settings 页 IB Connection → Flex 中配置」；移除 config 说明 | `docs/FLEX_TRANSACTIONS.md` |
| 2.16 | TransferPay 页：若当前有「Configure flex.accounts in config.yaml」提示，改为「Configure in Settings → IB Connection → Flex」 | `frontend/src/pages/TransferPayPage.tsx` |

### 2.6 兼容与回退

- **config 回退**：若 `reader.get_flex_config()` 返回空列表，可尝试从 `(control_via_db or {}).get("flex")` 读（兼容旧部署）；或直接要求「至少配置一行」否则 POST /transactions/fetch 报错。建议**不**做 config 回退，迁移即切到 DB。
- **环境变量**：当前 `IB_FLEX_TOKEN`、`IB_FLEX_QUERY_ID_CASH_TRANSACTIONS` 仅覆盖第一个账户。迁移后可选：若 `flex_accounts` 为空且 env 存在，则用 env 作为临时单账户；否则以 DB 为准。为简化，建议迁移后**仅 DB**，env 不再支持。

---

## 三、实施顺序建议

1. **Phase A：Flex 迁移 DB**（2.1–2.16）
   - 先完成 Flex 表、reader、app、前端、config 移除，再调整 Settings 布局。
2. **Phase B：Settings 二级分层**（1.1–1.4）
   - 在 Flex 已迁入 Settings 后，统一做 IB 二级分组。

或按需合并：先做 1.1–1.4 布局调整，再在「IB Connection」下加入 Flex 区块。

---

## 四、验收清单

- [x] Settings 侧边栏「IB Connection」下可见 Primary TWS、Second TWS、Client IDs、Flex 四个子区块；
- [x] Flex 区块支持添加/删除/编辑多行（Query ID Host、Query ID Secondary、Query Label、Purpose）；
- [x] 保存后 POST /config/flex 写入 `flex_accounts`，GET /status 返回 `flex_config`；
- [x] POST /transactions/fetch 从 `flex_accounts` 读取配置，不再读 config；
- [x] config.yaml 中已无 `flex` 段；
- [x] TransferPay 页提示更新为 Settings 配置路径；
- [x] docs/DATABASE.md、FLEX_TRANSACTIONS.md 已更新。
