'use strict';

const os = require('os');
const app = require('./app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (!app.server) {
  throw new Error('app.server is not available. Check src/app.js exports.');
}

app.server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const localIPs = [];

  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) localIPs.push(addr.address);
    }
  }

  console.log('Filom single-process server running:');
  console.log(`  Local:   http://localhost:${PORT}`);
  localIPs.forEach(ip => console.log(`  Network: http://${ip}:${PORT}`));
});
