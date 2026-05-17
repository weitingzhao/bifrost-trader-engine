# Bifrost 监控前端（React / Next.js）

监控页面的 React 前端，使用 Next.js App Router，对接多个 FastAPI 后端 API。

## 快速脚本（推荐）

在**项目根目录**执行：

```bash
./scripts/run_frontend.sh dev     # 开发：热更新，端口由 config/config.yaml 的 frontend.port 决定（默认 5173），启动前会 Kill 占用该端口的进程
./scripts/run_frontend.sh build   # 构建：Next.js 产出在 frontend/.next（standalone 模式）
./scripts/run_frontend.sh start   # 生产启动：next start，端口同上
./scripts/run_frontend.sh install # 仅安装依赖（首次或 package 变更后）
```

脚本会自动在缺少 `node_modules` 时先执行 `npm install`。开发端口可在 `config/config.yaml` 中配置：

```yaml
frontend:
  port: 5173   # Next.js 开发/生产服务器端口
```

### 何时用 dev，何时用 build + start？

| 场景 | 使用 | 说明 |
|------|------|------|
| 日常改页面、调样式、联调 API | `dev` | 启动 Next.js 开发服务器，改代码即刷新；`next.config.mjs` 中的 rewrites 将 API 请求代理到后端。 |
| 生产部署 | `build` + `start` | `build` 生成 standalone 产出到 `frontend/.next/standalone/`；`start` 运行 Next.js 生产服务器。nginx 将 API 路径代理到 FastAPI，页面请求代理到 Next.js。 |

## 开发（手动）

1. 在项目根目录启动 Monitor API（API 需在 8765 端口）：
   ```bash
   python scripts/run_server.py config/config.yaml
   ```
2. 启动前端开发服务器：
   ```bash
   ./scripts/run_frontend.sh dev
   ```
3. 浏览器访问 http://localhost:5173。Next.js 会把 `/status`、`/operations`、`/control` 等 API 路径代理到后端。

## 构建 & 生产启动（手动）

```bash
./scripts/run_frontend.sh build
./scripts/run_frontend.sh start
```

产出在 `frontend/.next/`（含 `standalone/` 子目录）。部署到 Linux 服务器时由 `bifrost-frontend.service` 运行 Next.js 生产服务器，nginx 将 `/` 代理到该进程。

## 生产部署架构

```
nginx :80
  ├── /_next/static/  → 直接 serve 静态资源（nginx alias）
  ├── /status, /health, /control, … → Monitor API (FastAPI)
  ├── /research/massive, /ops, … → 各领域 FastAPI
  └── / (fallback) → Next.js server (bifrost-frontend.service, port 5173)
```
