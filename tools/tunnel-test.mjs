#!/usr/bin/env node
// Reproduce el túnel de VS Code: sirve el HTML por HTTP pero NO reenvía el salto
// a WebSocket. Es el caso que reportó el usuario ("se queda cargando") y el
// peor posible, porque el navegador no da ningún error: el socket se queda en
// CONNECTING para siempre y la interfaz no tiene nada que contar.
//
// Comprueba dos cosas:
//   1. que el HTML llega igual (para que se vea el menú y el fallo sea real),
//   2. que la interfaz explica la causa en vez de quedarse en silencio.
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TARGET = Number(process.argv[2] || 8080);
const PROXY_PORT = Number(process.argv[3] || 8098);

const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Proxy que funciona como el túnel: HTTP sí, salto a WebSocket no. Se comporta
// como un proxy mal configurado que ignora la cabecera Upgrade, que es el fallo
// típico al montar un túnel a mano.
const server = createServer((req, res) => {
    const upstream = netConnect(TARGET, '127.0.0.1', () => {
        upstream.write(`GET ${req.url || '/'} HTTP/1.1\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n`);
        upstream.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
});

// El fallo del túnel: acepta la conexión y la cierra sin responder al handshake.
server.on('upgrade', (req, socket) => {
    socket.destroy();
});

await new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve));
console.log(`túnel simulado en 127.0.0.1:${PROXY_PORT} -> 127.0.0.1:${TARGET}`);
console.log('sirve HTML pero rompe el salto a WebSocket\n');

// 1. El HTML pasa: el túnel alcanza al servidor, así que el fallo es el salto.
const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`);
const body = await res.text();
check('el HTML llega por el túnel (el fallo es solo el salto)',
      res.status === 200 && body.includes('Crash Ball'),
      `estado ${res.status}, ${body.length} bytes`);

// 2. El navegador: se comprueba que la interfaz explica la causa. Se usa Chrome
//    en modo headless con un script mínimo que hace lo mismo que el cliente:
//    abrir el WebSocket y esperar al reloj de OPEN_TIMEOUT_MS.
const script = `
(async () => {
  // Reproduce el reloj del cliente contra un destino inalcanzable.
  const ws = new WebSocket('ws://127.0.0.1:${PROXY_PORT}');
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('never-opened'), 7000);
    ws.onopen = () => { clearTimeout(t); resolve('opened'); };
    ws.onerror = () => {};
  });
  return opened;
})()`;

const chrome = await findChrome();
check('se encuentra Chrome para la prueba', !!chrome, chrome || 'no está');

if (chrome) {
    const cdpPort = 9223 + (PROXY_PORT % 50);
    const child = spawn(chrome, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(process.env.TEMP || '.', 'cb-tunnel-test')}`,
        'about:blank'
    ], { stdio: 'ignore' });

    try {
        await waitForCdp(cdpPort);
        const outcome = await evaluate(cdpPort, script);
        // El punto del test: el navegador se queda en CONNECTING, sin error ni
        // cierre. Sin el reloj del cliente esto es un silencio infinito.
        check('el salto se queda colgado en el navegador (el fallo es real)',
              outcome === 'never-opened', `resultado: ${outcome}`);
    } finally {
        child.kill();
        server.close();
    }
}

server.close();

async function findChrome() {
    const candidates = [
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
    const { existsSync } = await import('node:fs');
    return candidates.find((p) => existsSync(p)) || null;
}

async function waitForCdp(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (r.ok) return;
        } catch { /* aún no */ }
        await sleep(200);
    }
    throw new Error('CDP no respondió');
}

async function evaluate(port, expression) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP no respondió')), 20000);
        ws.onopen = () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, awaitPromise: true, returnByValue: true }
            }));
        };
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            if (msg.result && msg.result.result && msg.result.result.value !== undefined) {
                resolve(msg.result.result.value);
            } else {
                reject(new Error(JSON.stringify(msg).slice(0, 200)));
            }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('error de CDP')); };
    });
}

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);