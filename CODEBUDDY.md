# CODEBUDDY.md This file provides guidance to WorkBuddy when working with code in this repository.

## 常用命令

```bash
npm install              # 安装依赖
npm start                # 多进程模式启动（推荐）
npm run start:single     # 单进程模式
npm run dev              # 开发模式（单进程 + nodemon）
PORT=3100 npm start      # 指定端口
```

## 项目架构

Filom 是一个基于 **Koa 2** 的多进程后端 + 纯前端单页应用，同时提供文件管理、实时聊天室和大文件断点续传功能。

### 多进程架构

```
src/master.js     ← Cluster 主进程，监听端口，分发请求
src/app.js        ← Worker 进程处理实际请求
```

- 主进程创建 HTTP Server 并监听端口
- 自动启动 CPU 核心数 - 1 个 Worker 进程
- Worker 崩溃时自动重启
- 上传会话持久化到 `src/sessions.json`，支持跨 Worker 共享状态

### 后端（src/app.js）

所有逻辑集中在一个文件中，按职责分为以下几层：

1. **中间件层** — CORS、分片上传跳过 koa-body（让 Busboy 直接处理）、静态资源（public 目录）、聊天图片内联中间件（`/uploads/*`）
2. **REST API 路由** — Koa Router 处理文件操作：
   - `GET /api/files`（列表）、`POST /api/upload`（普通上传）、`GET /api/download/:filename`（下载）、`DELETE /api/files/:filename`（删除）
   - `GET /api/chat/history`（聊天历史）、`POST /api/chat/upload`（聊天图片上传）
   - 分片上传：`POST /api/upload/init`、`GET /api/upload/:uploadId/status`、`POST /api/upload/:uploadId/chunk`、`POST /api/upload/:uploadId/merge`、`DELETE /api/upload/cleanup`
3. **会话持久化** — `uploadSessions` Map 内存缓存 + `sessions.json` 文件持久化，支持多进程共享
4. **WebSocket 服务** — 复用同一 HTTP Server，路径 `/ws/chat`，管理在线用户 Map，以 `type` 字段区分消息类型（`welcome`/`rename`/`message`/`image`/`online`），图片消息携带服务器文件路径而非内联 Base64
5. **广播函数** — `broadcast(data)` 遍历所有在线 WebSocket 连接并发送 JSON

**注意**：`/uploads/` 路径由内联中间件实现（koa-static 的 prefix 选项行为异常），不要改用带 prefix 的 koa-static。

### 前端

**public/index.html** — 主页面

纯原生 HTML/CSS/JS 单页，无需构建工具：

- **文件面板** — 拖拽上传（dragover/drop 事件），XHR 带进度条上传，文件列表渲染与操作，支持列表/画廊两种视图
- **聊天面板** — WebSocket 连接管理（含断线 3s 重连）、文本消息、图片消息（选择 → XHR 上传 `/api/chat/upload` → WebSocket 发送 `{type:'image',savedName}` → 对方渲染缩略图）、灯箱预览
- **Tab 切换** — 纯 CSS `display:flex/none` 切换两个 `.panel` 区域
- **导航栏** — 「📁 文件」「💬 聊天」「🚀 大文件」（跳转 upload.html）

**public/upload.html** — 大文件断点续传页面

- 分片大小滑块（10/25/50/100 MB，默认 100 MB）和并发数下拉（1/2/3/5/8/10，默认 10）
- 拖拽或点击选文件，自动切片、并发上传，每个文件独立显示进度/速度/分片状态
- `inFlight` Map 追踪并发中分片的实时进度，保证进度条准确
- `speedDisplay` 字段保存最后一个有效速度值，避免速度显示闪烁
- 支持暂停/继续（`AbortController` 中断 XHR）、断点续传（`GET /status` 拉取已上传分片）、全部开始/暂停/清除已完成
- **localStorage 持久化**：任务状态保存到 localStorage，刷新后自动恢复未完成任务

### 数据存储

上传文件保存在 `src/uploads/`，文件名格式为 `uuid_原文件名.扩展名`（分片合并后同样保留原名）。
分片临时文件存放在 `src/chunks/<uploadId>/`，合并成功后自动删除。
聊天消息存储在 `src/chat.db`（SQLite WAL 模式）。
上传会话存储在 `src/sessions.json`，支持多进程共享和重启恢复。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP/WebSocket 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址（已默认允许外部访问） |
