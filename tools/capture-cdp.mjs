// 通过 WebView2 CDP 截取当前窗口内容（仅用于生成 docs 截图）。
// 用法：node tools/capture-cdp.mjs <port> <out.png> [width] [height]
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] || 9333);
const out = process.argv[3];
const width = Number(process.argv[4] || 1480);
const height = Number(process.argv[5] || 920);
if (!out) throw new Error('missing output path');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target: ' + JSON.stringify(targets));

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message));
  else resolve(msg.result);
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
// 等待字体枚举/自动转换/首帧渲染完成
await new Promise((r) => setTimeout(r, 1500));
const { data } = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`saved ${out} (${width}x${height})`);
ws.close();
