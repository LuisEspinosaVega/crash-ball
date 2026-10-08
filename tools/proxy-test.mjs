#!/usr/bin/env node
// ¿Nuestro servidor aguanta detrás de un proxy inverso de verdad?
//
// Esto separa las dos hipótesis del "se queda cargando" del usuario:
//   · Si el WebSocket funciona a través de este proxy, el servidor está bien y
//     el problema es el túnel de VS Code.
//   · Si falla aquí también, el fallo es nuestro y hay que arreglarlo.
//
// El proxy es mínimo a propósito, pero hace lo que hace un proxy real: termina
// la conexión TLS, reescribe el host y reenvía la petición con el salto a
// WebSocket. Si esto pasa, cualquier nginx/Caddy detrás también pasará.
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';

const TARGET = Number(process.argv[2] || 8080);
const PROXY_PORT = Number(process.argv[3] || 8099);

const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

const server = createServer((req, res) => {
    // El HTML sí pasa: sirve para comprobar que el proxy alcanza al servidor.
    const upstream = netConnect(TARGET, '127.0.0.1', () => {
        const path = req.url || '/';
        upstream.write(`GET ${path} HTTP/1.1\r\nHost: tunnel.example\r\nConnection: close\r\n\r\n`);
        upstream.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
});

// El salto a WebSocket: esto es lo que un proxy tiene que reenviar tal cual.
server.on('upgrade', (req, socket, head) => {
    const upstream = netConnect(TARGET, '127.0.0.1', () => {
        const headers = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n');
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
});

await new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve));
console.log(`proxy en 127.0.0.1:${PROXY_PORT} -> 127.0.0.1:${TARGET}\n`);

// 1. El HTML llega a través del proxy: el túnel sí alcanza al servidor.
try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`);
    const body = await res.text();
    // Se busca el título de la página, no un identificador de JS: el HTML es lo
    // único que el túnel tiene que poder servir para que el menú aparezca.
    check('el HTML llega a través del proxy',
          res.status === 200 && body.includes('Crash Ball'),
          `estado ${res.status}, ${body.length} bytes`);
} catch (err) {
    check('el HTML llega a través del proxy', false, String(err));
}

// 2. El WebSocket survive al salto. Si esto pasa, el servidor soporta proxy.
// El WebSocket global de Node usa la API del navegador (onopen, onmessage...).
await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
    const timer = setTimeout(() => {
        check('el WebSocket sube a través del proxy', false, 'no respondió en 8 s');
        try { ws.close(); } catch { /* ya */ }
        finish();
    }, 8000);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'JOIN', name: 'Prueba tras proxy', sessionId: 'deadbeef01' }));
    };
    ws.onmessage = (event) => {
        let msg = null;
        try { msg = JSON.parse(event.data); } catch { /* ilegible */ }
        if (msg && msg.type === 'HELLO') {
            check('el WebSocket sube a través del proxy', true, `saludo recibido, sesión ${msg.sessionId}`);
            ws.send(JSON.stringify({ type: 'PING', t: Date.now() }));
            return;
        }
        if (msg && msg.type === 'PONG') {
            check('el PING/PONG atraviesa el proxy', true, `${Math.round(Date.now() - msg.t)} ms`);
            clearTimeout(timer);
            ws.close();
            finish();
        }
    };
    // El cierre limpio también dispara onerror: una vez terminado, cualquier
    // evento posterior es ruido y no debe contar como fallo.
    ws.onerror = () => {
        if (done) return;
        check('el WebSocket sube a través del proxy', false, 'error de socket');
        clearTimeout(timer);
        finish();
    };

    let done = false;
    function finish() {
        if (done) return;
        done = true;
        setTimeout(() => { server.close(); }, 200);
        setTimeout(report, 300);
    }
});

function report() {
    const bad = results.filter((r) => !r).length;
    console.log(`\n${results.length - bad}/${results.length} checks passed`);
    process.exit(bad === 0 ? 0 : 1);
}