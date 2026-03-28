# Strategy Opportunity 页面测试步骤

基于当前表结构（`scope_type` + 子表，无 jsonb），按页面操作一步步验证机会策略的创建、列表、编辑与提交。

---

## 前置条件

1. **后端已启动**：相关 FastAPI 进程已启动（通常含 **Monitor** `run_server.py` 与 **Strategy** `run_server_strategy.py` 等，视前端 API 基址配置），且已配置数据库。
2. **前端已启动**：例如 `./scripts/run_frontend.sh dev`，浏览器打开对应地址。
3. **至少有一条结构策略**：机会策略必须关联一条 Structure；若库中还没有，需先在 Strategy 页的「Strategy structures」区块创建一条。

---

## 一、进入 Strategy 页

1. 在左侧导航点击 **Research**。
2. 在 Research 子菜单中点击 **Strategy**。
3. 页面应显示：
   - 顶部：当前 Active strategy（Structure / Gate safety）
   - **Strategy structures** 表格
   - **Opportunity strategies** 表格（可能为空）
   - **Gate safety sets** 表格
   - **Strategy history**

若无结构策略，先完成「二、准备一条结构策略」；否则直接做「三、创建机会策略」。

---

## 二、准备一条结构策略（若无）

1. 在 **Strategy structures** 区块点击 **Create structure**。
2. 填写例如：
   - **Name**: `Test Straddle`
   - **Structure type**: 任选（如 `straddle_strangle`）
   - **Legs**: 至少保留一行（可填 role、direction、quantity 等），或保持默认。
3. 点击 **Save**，列表中应出现新行，记下其 **ID**（或名称），后面创建机会策略时会选这条 Structure。

---

## 三、创建机会策略（示例：explicit_symbols + 入场条件）

1. 在 **Opportunity strategies** 区块点击 **Create opportunity**。
2. 弹出/展开 **New opportunity** 表单后，按下面填写。

### 3.1 Metadata

- **Name**: `My Test Opportunity`（必填）
- **Structure**: 下拉选择上一步的结构（如 `Test Straddle (1)`）
- **Default gate safety**: 可留空「— None」，或选已有 Gate safety set
- **Active**: 勾选

### 3.2 Symbol scope

- **Scope type**: 选择 **explicit_symbols**
- 下方出现标的列表：
  - 点击 **Add symbol**，在输入框填 `AAPL`
  - 再点 **Add symbol**，填 `MSFT`
- 若选 **watchlist_stk**，则只显示说明「Symbols from Watchlist STK」，无需填 symbol 列表。

### 3.3 Entry conditions

- 点击 **Add condition**（若无行会新增一行）：
  - **Type**: 选 `iv_min`
  - **Value (text)**: 可留空
  - **Value (numeric)**: 填 `0.15`
- 再点 **Add condition** 添加第二条：
  - **Type**: `dte_min`
  - **Value (numeric)**: `7`
- 可按需选类型：`iv_min`、`iv_max`、`dte_min`、`dte_max`、`earnings_blackout_days`、`min_volume` 等。

### 3.4 提交

- 点击 **Save**（或表单底部的主提交按钮）。
- 若无报错，表单关闭，**Opportunity strategies** 表格会刷新。

---

## 四、在列表中验证

1. 在 **Opportunity strategies** 表格中找到刚创建的 **My Test Opportunity**。
2. 检查各列：
   - **Name**: `My Test Opportunity`
   - **Structure**: 对应结构名称（如 `Test Straddle`）
   - **Scope**: `explicit_symbols`（若选的是 watchlist_stk 则显示 `watchlist_stk`）
   - **Default gate safety**: 所选名称或 —  
   - **Active**: Yes

说明列表接口返回了 `scope_type`，且表格「Scope」列展示正确。

---

## 五、编辑并验证详情回显

1. 在同一行点击 **Edit**。
2. 表单标题变为 **Edit opportunity &lt;id&gt;**，且应出现 Loading… 后加载完成。
3. 检查回显是否与创建时一致：
   - **Name**、**Structure**、**Default gate safety**、**Active** 正确。
   - **Scope type** 为 `explicit_symbols`。
   - **Symbol scope** 下方有两条：`AAPL`、`MSFT`（可编辑/删除/新增）。
   - **Entry conditions** 表格有两行：`iv_min` / 0.15、`dte_min` / 7。

说明详情接口返回了 `symbols` 数组和 `entry_conditions` 数组，且 `opportunityToPayload` 与表单状态正确绑定。

---

## 六、修改后保存（验证更新）

1. 在编辑表单中做小改动，例如：
   - 将 **Name** 改为 `My Test Opportunity (updated)`。
   - 在 Symbol 列表再 **Add symbol** 填 `GOOGL`。
   - 在 Entry conditions 中把 `iv_min` 的 **Value (numeric)** 改为 `0.20`，或再 **Add condition** 加一条 `iv_max` / 0.50。
2. 点击 **Save**。
3. 表格刷新后，该行 **Name** 应变为 `My Test Opportunity (updated)`。
4. 再次点击 **Edit**，确认：
   - Symbol 列表为 `AAPL`、`MSFT`、`GOOGL`。
   - Entry conditions 包含修改后的数值与新增行。

说明 PUT 请求的 payload（`scope_type`、`symbols`、`entry_conditions`）被正确提交并写回子表。

---

## 七、可选：watchlist_stk 与空条件

1. **Create opportunity** 再建一条，例如名称 `Watchlist Opportunity`。
2. **Scope type** 选 **watchlist_stk**，不填 symbol 列表。
3. **Entry conditions** 不点击 Add condition（或保留 0 行）。
4. **Save** 后，列表中 **Scope** 列为 `watchlist_stk`。
5. **Edit** 该条，确认 Scope type 与「Symbols from Watchlist STK」说明正确，且 entry conditions 为空或之前保存的状态。

---

## 八、异常与校验

- **Name 为空**：点 Save 应提示 **Name is required**，不提交。
- **Structure 未选**：点 Save 应提示 **Structure is required**，不提交。
- **Scope type = explicit_symbols 但未填任何 symbol**：允许保存，后端收到 `symbols: []`；列表/详情中该机会的标的为空，行为符合设计。

---

## 九、验收对照（与契约一致）

| 项目 | 预期 |
|------|------|
| 列表 GET | 响应含 `scope_type`，无 `symbol_scope`/`entry_conditions` 旧字段；表格有 Scope 列 |
| 详情 GET | 响应含 `symbols`（字符串数组）、`entry_conditions`（`{ condition_type, value_text?, value_numeric? }[]`） |
| 创建/编辑表单 | Scope type 下拉（watchlist_stk / explicit_symbols）；explicit_symbols 时展示可增删的 symbol 列表；Entry conditions 为表格行（类型 + value_text / value_numeric） |
| 提交 payload | 仅含 `scope_type`、`symbols`、`entry_conditions`，无 JSON 文本框、无旧字段名 |

按上述步骤跑通即表示：在「无历史 jsonb 数据、表结构已改为 scope_type + 子表」的前提下，Strategy Opportunity 的页面流程与 API 契约一致。
