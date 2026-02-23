# Bifrost 监控前端（React）

监控页面的 React 前端，对接现有 FastAPI 状态服务（方案 1：后端不变）。

## 快速脚本（推荐）

在**项目根目录**执行：

```bash
./scripts/run_frontend.sh dev     # 开发：热更新，端口由 config/config.yaml 的 frontend.port 决定（默认 5173），启动前会 Kill 占用该端口的进程
./scripts/run_frontend.sh build   # 构建：产出 frontend/dist，供状态服务或部署
./scripts/run_frontend.sh install # 仅安装依赖（首次或 package 变更后）
```

脚本会自动在缺少 `node_modules` 时先执行 `npm install`。开发端口可在 `config/config.yaml` 中配置：

```yaml
frontend:
  port: 5173   # Vite 开发服务器端口
```

### 何时用 dev，何时用 build？

| 场景 | 使用 | 说明 |
|------|------|------|
| 日常改页面、调样式、联调 API | `dev` | 启动 Vite 开发服务器，改代码即刷新；需同时把状态服务跑在 8765 端口，浏览器访问 5173。 |
| 部署、或单端口访问监控页 | `build` | 生成静态文件到 `frontend/dist`；状态服务会优先提供该前端，访问 http://localhost:8765/ 即为 React 页。 |

## 开发（手动）

1. 在项目根目录启动状态服务（API 需在 8765 端口）：
   ```bash
   python scripts/run_server.py config/config.yaml
   ```
2. 启动前端开发服务器：
   ```bash
   ./scripts/run_frontend.sh dev
   ```
3. 浏览器访问 http://localhost:5173。Vite 会把 `/status`、`/operations`、`/control` 代理到 `http://127.0.0.1:8765`。

## 构建（手动）

```bash
./scripts/run_frontend.sh build
```

产物在 `frontend/dist`。在项目根目录运行状态服务时，访问 http://localhost:8765/ 会优先使用该前端；未构建时则显示「请先构建前端」说明页。

## 环境变量（可选）

- `VITE_API_BASE`：若设置，前端将请求该 base URL 而非相对路径（用于与后端不同域/端口的部署）。

当前未使用该变量，API 使用相对路径，依赖 Vite 开发代理或同源部署。
