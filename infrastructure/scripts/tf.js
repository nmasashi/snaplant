// terraform を、つながる方の IP で実行する。使い方: node tf.js <terraform の引数>（tf.cmd から呼ぶ）
//
// この PC は日によって IPv4 か IPv6 の片方の接続が、確立した直後に切られる。Terraform（Go）は IPv6 を
// 先に使い、接続後に切られると IPv4 に切り替えないため失敗する。Windows の IPv4 優先の設定
// （netsh の prefixpolicy）にしても Terraform には効かなかった（2026-10-12 に確認）。
// そこで IPv4 でつながるときは、宛先へ IPv4 でつなぐ中継（HTTPS の CONNECT だけを扱う）を立てて
// HTTPS_PROXY で通す。TLS は中継せずそのまま通すので、通信の中身は見ない。
// IPv4 でつながらない日は、そのまま実行する（その日は IPv6 が通る）。
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PROBE_HOSTS = ['management.azure.com', 'registry.terraform.io'];

/** 指定したホストの 443 番に IPv4 でつながるかを調べる */
function canConnectIPv4(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: 443, family: 4, timeout: 10000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

/** 宛先へ IPv4 でつなぐ CONNECT の中継を、空いているポートで立てる */
function startIPv4Proxy() {
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, client, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect({ host, port: Number(port) || 443, family: 4 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const env = { ...process.env };
  // azurerm v4 はサブスクリプション ID を環境変数で受け取る（scripts/deploy.sh と同じ）
  if (!env.ARM_SUBSCRIPTION_ID) {
    env.ARM_SUBSCRIPTION_ID = execSync('az account show --query id -o tsv', { encoding: 'utf8' }).trim();
  }

  const results = await Promise.all(PROBE_HOSTS.map(canConnectIPv4));
  let server = null;
  if (results.every(Boolean)) {
    server = await startIPv4Proxy();
    env.HTTPS_PROXY = `http://127.0.0.1:${server.address().port}`;
    env.NO_PROXY = '127.0.0.1,localhost';
    console.error('IPv4 でつながるので、IPv4 の中継を通して terraform を実行します。');
  } else {
    console.error('IPv4 でつながらないので、そのまま terraform を実行します。');
  }

  const child = spawn('terraform', process.argv.slice(2), {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => { server?.close(); process.exit(code ?? 1); });
  child.on('error', (err) => { console.error(`terraform を起動できません: ${err.message}`); process.exit(1); });
}

// Ctrl+C は terraform にも届く。terraform が後片付けして終わるのを待つ
process.on('SIGINT', () => {});
main();
