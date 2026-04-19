# CODEBUDDY.md This file provides guidance to WorkBuddy when working with code in this repository.

## 常用命令

```bash
npm install              # 安装依赖
node src/app.js          # 启动服务，默认端口 3000
PORT=3100 node src/app.js        # 指定端口
HOST=0.0.0.0 node src/app.js     # 允许外部访问（默认已绑定 0.0.0.0）
```

## 项目架构

Filom 是一个基于 **Koa 2** 的单文件后端 + 纯前端单页应用，同时提供文件管理和实时聊天室功能。

### 后端（src/app.js）

所有逻辑集中在一个文件中，按职责分为以下几层：

1. **中间件层** — CORS、请求体解析（koa-body multipart）、静态资源（public 目录）、聊天图片内联中间件（`/uploads/*`）
2. **REST API 路由** — Koa Router 处理文件操作：`GET /api/files`（列表）、`POST /api/upload`（上传）、`GET /api/download/:filename`（下载）、`DELETE /api/files/:filename`（删除）、`POST /api/chat/upload`（聊天图片上传）
3. **WebSocket 服务** — 复用同一 HTTP Server，路径 `/ws/chat`，管理在线用户 Map，以 `type` 字段区分消息类型（`welcome`/`rename`/`message`/`image`/`online`），图片消息携带服务器文件路径而非内联 Base64
4. **广播函数** — `broadcast(data)` 遍历所有在线 WebSocket 连接并发送 JSON

**注意**：`/uploads/` 路径由内联中间件实现（koa-static 的 prefix 选项行为异常），不要改用带 prefix 的 koa-static。

### 前端（public/index.html）

纯原生 HTML/CSS/JS 单页，无需构建工具：

- **文件面板** — 拖拽上传（dragover/drop 事件），XHR 带进度条上传，文件列表渲染与操作
- **聊天面板** — WebSocket 连接管理（含断线 3s 重连）、文本消息、图片消息（选择 → XHR 上传 `/api/chat/upload` → WebSocket 发送 `{type:'image',savedName}` → 对方渲染缩略图）、灯箱预览
- **Tab 切换** — 纯 CSS `display:flex/none` 切换两个 `.panel` 区域

### 数据存储

上传文件保存在 `src/uploads/`（UUID 重命名，原始文件名存元数据），聊天图片与普通文件共用同一目录，访问时通过 `/uploads/` 路径。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP/WebSocket 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址（已默认允许外部访问） |
