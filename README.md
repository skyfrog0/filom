# Filom

一个基于 Koa 2 的轻量级 Web 应用，提供文件管理和实时聊天功能。

## 功能特性

### 文件管理
- 拖拽上传：支持拖拽文件到页面直接上传
- 上传进度：实时显示上传进度条
- 文件列表：展示已上传文件，支持下载和删除

### 实时聊天
- WebSocket 双向通信
- 支持文本消息和图片消息
- 图片预览：点击聊天中的图片可放大查看
- 自动重连：断线后 3 秒自动重连

## 技术栈

- **后端**：Koa 2 + WebSocket
- **前端**：原生 HTML/CSS/JS（无框架）
- **依赖**：Koa、koa-router、koa-body、koa-static、koa-websocket、uuid

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
│   └── uploads/       # 上传文件存储目录
├── public/
│   └── index.html     # 前端单页应用
├── package.json
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 获取文件列表 |
| POST | `/api/upload` | 上传文件 |
| GET | `/api/download/:filename` | 下载文件 |
| DELETE | `/api/files/:filename` | 删除文件 |
| POST | `/api/chat/upload` | 上传聊天图片 |

## WebSocket

- 路径：`/ws/chat`
- 消息类型：
  - `welcome`：连接成功欢迎消息
  - `rename`：用户重命名
  - `message`：文本消息
  - `image`：图片消息
  - `online`：在线用户更新
