# Filom

一个基于 Koa 2 的轻量级 Web 应用，提供文件管理、实时聊天和大文件上传功能。

## 功能特性

### 文件管理
- 拖拽上传：支持拖拽文件到页面直接上传
- 上传进度：实时显示上传进度条
- 文件列表：展示已上传文件，支持下载和删除

### 大文件上传（断点续传）
- 分片上传：自动将大文件切分为多个分片上传，单文件无大小限制
- 断点续传：中途关闭页面或断网后，可从断点处继续上传
- 暂停/继续：支持随时暂停和恢复上传
- 可配置分片大小（10 / 25 / 50 / 100 MB）和并发数（1-10，默认 2）

### 实时聊天
- WebSocket 双向通信
- 支持文本消息和图片消息
- 图片预览：点击聊天中的图片可放大查看
- 自动重连：断线后 3 秒自动重连

## 技术栈

- **后端**：Koa 2 + WebSocket + SQLite
- **前端**：原生 HTML/CSS/JS（无框架）
- **依赖**：Koa、koa-router、koa-body、koa-static、koa-websocket、uuid、better-sqlite3

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
node src/app.js
```

服务默认运行在 `http://localhost:3000`

### 自定义配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | 3000 | HTTP/WebSocket 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |

```bash
PORT=3100 node src/app.js
```

## 目录结构

```
filom/
├── src/
│   ├── app.js          # 后端主入口
│   ├── uploads/        # 上传文件存储目录
│   └── chunks/        # 分片上传临时目录（合并后自动清理）
├── public/
│   ├── index.html     # 主页面（文件管理 + 聊天）
│   └── upload.html    # 大文件上传页面（断点续传）
├── package.json
└── README.md
```

## API 接口

### 文件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 获取文件列表 |
| POST | `/api/upload` | 上传文件（普通模式） |
| GET | `/api/download/:filename` | 下载文件 |
| DELETE | `/api/files/:filename` | 删除文件 |

### 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/chat/history` | 获取聊天历史记录 |
| POST | `/api/chat/upload` | 上传聊天图片 |

### 大文件分片上传

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload/init` | 初始化上传会话，返回 uploadId |
| GET | `/api/upload/:uploadId/status` | 查询已上传分片（断点续传） |
| POST | `/api/upload/:uploadId/chunk` | 上传单个分片 |
| POST | `/api/upload/:uploadId/merge` | 合并所有分片，完成后清理临时文件 |

**分片上传流程：**

```
1. POST /api/upload/init      → { uploadId }
2. 循环：POST /api/upload/:uploadId/chunk（每个分片）
3. POST /api/upload/:uploadId/merge → { savedName, originalName, size }
```

## WebSocket

- 路径：`/ws/chat`
- 消息类型：
  - `welcome`：连接成功欢迎消息
  - `rename`：用户重命名
  - `message`：文本消息
  - `image`：图片消息
  - `online`：在线用户更新
