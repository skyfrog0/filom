'use strict';

const cluster = require('cluster');
const http = require('http');
const os = require('os');
const path = require('path');

// 加载应用
const app = require('./app');

// 启动 CPU 核心数 - 1 个 worker，保留一个给主进程
const numCPUs = Math.max(1, os.cpus().length - 1);

if (cluster.isMaster) {
  console.log('═══════════════════════════════════════════');
  console.log(`🚀 Filom Cluster 启动`);
  console.log(`   主进程: ${process.pid}`);
  console.log(`   Worker 数量: ${numCPUs}`);
  console.log('═══════════════════════════════════════════');

  // 创建 HTTP 服务器（主进程监听端口）
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';

  const server = http.createServer(app.callback());

  // 启动 workers
  for (let i = 0; i < numCPUs; i++) {
    const worker = cluster.fork();
    console.log(`   ✅ Worker ${worker.id} (PID: ${worker.process.pid}) 已启动`);
  }

  // 主进程监听端口
  server.listen(PORT, HOST, () => {
    const nets = os.networkInterfaces();
    const localIPs = [];
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) localIPs.push(addr.address);
      }
    }
    console.log(`✅  Server running:`);
    console.log(`    Local:   http://localhost:${PORT}`);
    localIPs.forEach(ip => console.log(`    Network: http://${ip}:${PORT}`));
  });

  cluster.on('exit', (worker, code, signal) => {
    console.log(`\n⚠️  Worker ${worker.id} 退出 (code: ${code}, signal: ${signal})`);
    // 自动重启崩溃的 worker
    const newWorker = cluster.fork();
    console.log(`   🔄 已重启 Worker ${newWorker.id} (PID: ${newWorker.process.pid})`);
  });

  cluster.on('online', (worker) => {
    console.log(`   💚 Worker ${worker.id} 已就绪`);
  });

} else {
  // Worker 进程：直接使用 app 模块
  console.log(`   📦 Worker ${cluster.worker.id} (PID: ${process.pid}) 加载完成`);
}
