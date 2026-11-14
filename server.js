// 本地小服务器：只是把文件夹里的文件发给浏览器。
// 不用装依赖，双击“启动.bat”就行。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5180;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[\\/])+/, ''));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到这个文件');
      return;
    }
    const isVendor = pathname.startsWith('/vendor/');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 引擎、词典、语音包这些大文件让浏览器缓存一天，页面本身不缓存
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  读书 已经启动');
  console.log('');
  console.log(`  这台电脑打开： http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('');
    console.log('  手机连同一个 WiFi，打开：');
    lan.forEach((ip) => console.log(`    http://${ip}:${PORT}`));
  }
  console.log('');
  console.log('  要停止，关掉这个黑色窗口就行。');
  console.log('');

  if (process.platform === 'win32' && !process.env.NO_OPEN) {
    exec(`start "" "http://localhost:${PORT}"`, (e) => { /* 打不开就算了 */ });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 被占用了。关掉之前开的窗口，或者换一个端口：set PORT=5181 && node server.js`);
  } else {
    console.log('启动失败：', err.message);
  }
  process.exit(1);
});
