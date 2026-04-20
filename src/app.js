'use strict';

const Koa = require('koa');
const Router = require('koa-router');
const serve = require('koa-static');
const { koaBody } = require('koa-body');
const cors = require('@koa/cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const app = new Koa();
const router = new Router();

// ─── 目录配置 ──────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'chat.db');
const CHUNK_DIR = path.join(__dirname, 'chunks');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSIONS_LOCK = path.join(__dirname, 'sessions.lock');

// 确保目录存在
[UPLOAD_DIR, CHUNK_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Database ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL,          -- 'text' | 'image'
    sender     TEXT    NOT NULL,
    content    TEXT,                      -- text content (may be null for image)
    saved_name TEXT,                      -- image saved name (null for text)
    url        TEXT,                      -- full URL for images (null for text)
    created_at TEXT    NOT NULL
  );
`);

// Synchronous insert helper
const insertMsg = db.prepare(
  'INSERT INTO chat_messages (type, sender, content, saved_name, url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const getHistory = db.prepare(
  'SELECT type, sender, content, saved_name, url, created_at FROM chat_messages ORDER BY id ASC LIMIT 200'
);

function saveMessage(type, sender, content, savedName, url) {
  try {
    insertMsg.run(type, sender, content || null, savedName || null, url || null, new Date().toISOString());
  } catch (e) {
    console.error('DB insert error:', e.message);
  }
}

function loadHistory() {
  try {
    return getHistory.all();
  } catch (e) {
    console.error('DB query error:', e.message);
    return [];
  }
}

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());

// koaBody 只处理非分片上传的路由
app.use(async (ctx, next) => {
  // 分片上传路由跳过 koaBody，让 Busboy 直接处理原始请求
  if (ctx.path.match(/^\/api\/upload\/[^/]+\/chunk$/)) {
    await next();
    return;
  }
  await koaBody({
    multipart: true,
    formidable: {
      uploadDir: UPLOAD_DIR,
      keepExtensions: true,
      maxFileSize: 130 * 1024 * 1024,
    },
  })(ctx, next);
});

app.use(serve(path.join(__dirname, '../public')));

// 聊天图片 /uploads/* — 内联中间件
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/uploads/')) {
    const filename = ctx.path.slice('/uploads/'.length);
    const safeName = path.basename(filename);
    const filePath = path.join(UPLOAD_DIR, safeName);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      ctx.set('Content-Type', mime.lookup(filePath) || 'application/octet-stream');
      ctx.set('Cache-Control', 'max-age=86400');
      ctx.body = fs.createReadStream(filePath);
      return;
    }
  }
  await next();
});

// ─── File Routes ────────────────────────────────────────────

router.get('/api/files', (ctx) => {
  const files = fs.readdirSync(UPLOAD_DIR).map((name) => {
    const filePath = path.join(UPLOAD_DIR, name);
    const stat = fs.statSync(filePath);
    return { name, size: stat.size, createdAt: stat.birthtime };
  });
  ctx.body = { files };
});

router.post('/api/upload', (ctx) => {
  const file = ctx.request.files?.file;
  if (!file) { ctx.status = 400; ctx.body = { error: '没有找到上传文件' }; return; }

  const files = Array.isArray(file) ? file : [file];
  const uploaded = [];
  for (const f of files) {
    const originalName = f.originalFilename || f.newFilename || '';
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    const safeName = uuidv4() + '_' + baseName + ext;
    const dest = path.join(UPLOAD_DIR, safeName);
    fs.renameSync(f.filepath, dest);
    uploaded.push({ originalName: originalName, savedName: safeName, size: f.size });
  }
  ctx.body = { uploaded };
});

router.get('/api/download/:filename', (ctx) => {
  const filename = ctx.params.filename;
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) { ctx.status = 404; ctx.body = { error: '文件不存在' }; return; }
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  ctx.set('Content-Type', mimeType);
  ctx.body = fs.createReadStream(filePath);
});

router.delete('/api/files/:filename', (ctx) => {
  const filename = ctx.params.filename;
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) { ctx.status = 404; ctx.body = { error: '文件不存在' }; return; }
  fs.unlinkSync(filePath);
  ctx.body = { success: true };
});

// ═══════════════════════════════════════════════════════════════
//  分片上传会话管理（持久化支持多进程）
// ═══════════════════════════════════════════════════════════════

// 内存中的会话缓存
const uploadSessions = new Map(); // uploadId -> { originalName, totalChunks, fileSize, receivedChunks: Set, createdAt }

// ─── 会话文件操作（带文件锁）──────────────────────────────
async function acquireLock(timeout = 5000) {
  const start = Date.now();
  while (fs.existsSync(SESSIONS_LOCK)) {
    if (Date.now() - start > timeout) throw new Error('获取文件锁超时');
    await new Promise(r => setTimeout(r, 50));
  }
  await fs.promises.writeFile(SESSIONS_LOCK, String(process.pid));
}

async function releaseLock() {
  try {
    if (fs.existsSync(SESSIONS_LOCK)) fs.unlinkSync(SESSIONS_LOCK);
  } catch (_) {}
}

function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const data = JSON.parse(raw);
      // 恢复 Set 结构
      for (const [id, session] of Object.entries(data)) {
        session.receivedChunks = new Set(session.receivedChunks || []);
        uploadSessions.set(id, session);
      }
      console.log(`从磁盘恢复 ${uploadSessions.size} 个上传会话`);
    }
  } catch (e) {
    console.error('加载会话失败:', e.message);
  }
}

async function saveSessionsToDisk() {
  try {
    const data = {};
    for (const [id, session] of uploadSessions) {
      data[id] = {
        originalName: session.originalName,
        totalChunks: session.totalChunks,
        fileSize: session.fileSize,
        receivedChunks: [...session.receivedChunks],
        createdAt: session.createdAt,
      };
    }
    await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('保存会话失败:', e.message);
  }
}

// 定期自动保存（每 10 秒有变更时）
let dirtyFlag = false;
setInterval(async () => {
  if (dirtyFlag) {
    dirtyFlag = false;
    await saveSessionsToDisk();
  }
}, 10000);

function markDirty() { dirtyFlag = true; }

// 启动时加载会话
loadSessionsFromDisk();

// ─── Chunked Upload Routes ───────────────────────────────────

// 初始化上传：返回 uploadId，记录文件名和总分片数
router.post('/api/upload/init', async (ctx) => {
  const { fileName, totalChunks, fileSize } = ctx.request.body;
  if (!fileName || !totalChunks) { ctx.status = 400; ctx.body = { error: '缺少参数' }; return; }

  const uploadId = uuidv4();
  const chunkSubDir = path.join(CHUNK_DIR, uploadId);
  await fs.promises.mkdir(chunkSubDir, { recursive: true });

  uploadSessions.set(uploadId, {
    originalName: fileName,
    totalChunks: Number(totalChunks),
    fileSize: Number(fileSize) || 0,
    receivedChunks: new Set(),
    createdAt: Date.now(),
  });

  markDirty();
  await saveSessionsToDisk();

  ctx.body = { uploadId };
});

// 查询已上传分片（断点续传用）
router.get('/api/upload/:uploadId/status', async (ctx) => {
  const { uploadId } = ctx.params;
  const chunkSubDir = path.join(CHUNK_DIR, uploadId);

  // 优先从内存读
  const session = uploadSessions.get(uploadId);
  if (session) {
    ctx.body = { uploadedChunks: [...session.receivedChunks] };
    return;
  }

  // session 丢失但目录存在，从磁盘扫描（多进程场景）
  if (fs.existsSync(chunkSubDir)) {
    const existing = fs.readdirSync(chunkSubDir)
      .map(Number)
      .filter(n => !isNaN(n));
    ctx.body = { uploadedChunks: existing };
    return;
  }

  ctx.body = { uploadedChunks: [] };
});

// 上传单个分片 — Busboy 流式解析，直写磁盘，绕过 formidable
router.post('/api/upload/:uploadId/chunk', async (ctx) => {
  const { uploadId } = ctx.params;
  const chunkSubDir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(chunkSubDir)) {
    ctx.status = 404; ctx.body = { error: '上传会话不存在' }; return;
  }

  // 从 query 取 chunkIndex（前端通过 URL 传）
  const chunkIndex = Number(ctx.query.chunkIndex);
  if (isNaN(chunkIndex)) { ctx.status = 400; ctx.body = { error: '缺少 chunkIndex' }; return; }

  // Busboy 流式解析 multipart（不解码到内存/临时文件）
  let chunkWritten = false;
  await new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: ctx.request.headers,
      limits: { files: 1, fileSize: 130 * 1024 * 1024 },
    });

    bb.on('file', async (fieldname, stream, info) => {
      const dest = path.join(chunkSubDir, String(chunkIndex));
      const writeStream = fs.createWriteStream(dest);
      stream.pipe(writeStream);
      writeStream.on('finish', () => {
        chunkWritten = true;
        resolve();
      });
      writeStream.on('error', reject);
      stream.on('error', reject);
    });

    bb.on('error', reject);
    ctx.req.pipe(bb);
  });

  if (!chunkWritten) { ctx.status = 500; ctx.body = { error: '分片写入失败' }; return; }

  // 更新内存中的会话
  const session = uploadSessions.get(uploadId);
  if (session) {
    session.receivedChunks.add(chunkIndex);
    markDirty();
  }

  ctx.body = { ok: true, chunkIndex };
});

// 合并分片
router.post('/api/upload/:uploadId/merge', async (ctx) => {
  const { uploadId } = ctx.params;
  const { fileName, totalChunks } = ctx.request.body;
  const chunkSubDir = path.join(CHUNK_DIR, uploadId);

  if (!fs.existsSync(chunkSubDir)) { ctx.status = 404; ctx.body = { error: '上传会话不存在或已过期' }; return; }

  const total = Number(totalChunks);
  // 验证所有分片到位
  for (let i = 0; i < total; i++) {
    if (!fs.existsSync(path.join(chunkSubDir, String(i)))) {
      ctx.status = 400; ctx.body = { error: `分片 ${i} 缺失，无法合并` }; return;
    }
  }

  const ext = path.extname(fileName || '');
  const baseName = path.basename(fileName || 'file', ext);
  const safeName = uploadId + '_' + baseName + ext;
  const dest = path.join(UPLOAD_DIR, safeName);
  const writeStream = fs.createWriteStream(dest);

  try {
    for (let i = 0; i < total; i++) {
      const chunkPath = path.join(chunkSubDir, String(i));
      await pipeline(fs.createReadStream(chunkPath), writeStream, { end: false });
    }
    writeStream.end();
    await new Promise(res => writeStream.on('finish', res));
  } catch (e) {
    writeStream.destroy();
    ctx.status = 500; ctx.body = { error: '合并失败：' + e.message }; return;
  }

  // 清理分片目录和会话
  await fs.promises.rm(chunkSubDir, { recursive: true, force: true });
  uploadSessions.delete(uploadId);
  markDirty();
  await saveSessionsToDisk();

  const stat = await fs.promises.stat(dest);
  ctx.body = { savedName: safeName, originalName: fileName, size: stat.size };
});

// 清理过期会话（超过 24 小时的）
router.delete('/api/upload/cleanup', async (ctx) => {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000; // 24 小时
  let cleaned = 0;

  for (const [uploadId, session] of uploadSessions) {
    if (now - session.createdAt > TTL) {
      const chunkSubDir = path.join(CHUNK_DIR, uploadId);
      if (fs.existsSync(chunkSubDir)) {
        await fs.promises.rm(chunkSubDir, { recursive: true, force: true });
      }
      uploadSessions.delete(uploadId);
      cleaned++;
    }
  }

  if (cleaned > 0) await saveSessionsToDisk();
  ctx.body = { cleaned };
});

// ─── Chat Routes ────────────────────────────────────────────

// 聊天历史记录
router.get('/api/chat/history', (ctx) => {
  const messages = loadHistory();
  ctx.body = { messages };
});

// 聊天图片上传
const ALLOWED_IMG = /^(image\/jpeg|image\/png|image\/gif|image\/webp|image\/svg\+xml)$/i;

router.post('/api/chat/upload', (ctx) => {
  const file = ctx.request.files?.image;
  if (!file) { ctx.status = 400; ctx.body = { error: '没有找到图片文件' }; return; }
  if (!ALLOWED_IMG.test(file.mimetype)) { ctx.status = 400; ctx.body = { error: '仅支持 JPG、PNG、GIF、WebP、SVG 格式' }; return; }
  if (file.size > 10 * 1024 * 1024) { ctx.status = 400; ctx.body = { error: '图片大小不能超过 10 MB' }; return; }

  const originalName = file.originalFilename || file.newFilename || 'image.jpg';
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  const safeName = uuidv4() + '_' + baseName + ext;
  const dest = path.join(UPLOAD_DIR, safeName);
  fs.renameSync(file.filepath, dest);
  ctx.body = { savedName: safeName, url: `/uploads/${safeName}` };
});

app.use(router.routes()).use(router.allowedMethods());

// ─── WebSocket Server ────────────────────────────────────────
const server = http.createServer(app.callback());
const wss = new WebSocket.Server({ server, path: '/ws/chat' });

// ws → { id, name }
const clients = new Map();

wss.on('connection', (ws) => {
  const userId = uuidv4().slice(0, 8);
  clients.set(ws, { id: userId, name: `用户_${userId}` });

  // 发送欢迎 + 历史记录
  const history = loadHistory();
  ws.send(JSON.stringify({ type: 'welcome', userId, userName: `用户_${userId}`, history }));

  // 广播在线人数
  broadcast({ type: 'online', count: clients.size });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const sender = clients.get(ws);

    if (msg.type === 'rename' && msg.name) {
      sender.name = msg.name.slice(0, 20);
      ws.send(JSON.stringify({ type: 'renamed', name: sender.name }));
      return;
    }

    if (msg.type === 'message' && msg.content) {
      const content = msg.content.slice(0, 2000);
      const time = new Date().toISOString();
      const outgoing = { type: 'message', from: sender.name, content, time };
      saveMessage('text', sender.name, content, null, null);
      broadcast(outgoing);
      return;
    }

    if (msg.type === 'image' && msg.savedName) {
      // 严格校验：文件名必须是 uuid.v4 格式
      const safe = /^[a-f0-9-]{36}\.[a-z0-9]+$/.test(msg.savedName);
      if (!safe) return;
      const filePath = path.join(UPLOAD_DIR, msg.savedName);
      if (!fs.existsSync(filePath)) return;
      const url = `/uploads/${msg.savedName}`;
      const time = new Date().toISOString();
      const outgoing = { type: 'image', from: sender.name, savedName: msg.savedName, url, time };
      saveMessage('image', sender.name, null, msg.savedName, url);
      broadcast(outgoing);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ type: 'online', count: clients.size });
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const [client] of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}

// ─── 模块导出 ──────────────────────────────────────────────
// 导出 app 实例供 master.js 使用
module.exports = app;
