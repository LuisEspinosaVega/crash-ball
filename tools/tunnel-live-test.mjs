#!/usr/bin/env node
// Comprueba el juego a través de un túnel REAL de Internet.
//
// Esto no simula nada: abre un WebSocket contra la URL pública que da el túnel
// y espera el saludo del servidor. Es la única comprobación que dice si, desde
// otra máquina y sin nada más que un navegador, el juego arranca.
//
// También mide el ping por el túnel, que es lo que más se nota al jugar.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = process.argv[2];
if (!url) {
    console.error('uso: node tools/tunnel-live-test.mjs https://algo.trycloudflare.com');
    process.exit(2);
}

const wsUrl = url.replace(/^http/, 'ws').replace(/\/$/, '');
const host = wsUrl.replace(/^wss?:\/\//, '');
const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
console.log(`probando el juego a través de ${host}\n`);

// 1. El HTML: si esto falla, el túnel no llega al servidor.
try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    check('el HTML llega por el túnel', res.status === 200 && body.includes('Crash Ball'),
          `estado ${res.status}, ${body.length} bytes`);
} catch (err) {
    check('el HTML llega por el túnel', false, err.message);
    report();
}

// 2. El salto a WebSocket: el punto de todo esto.
const pings = [];
await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    let greeted = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch { /* ya */ } resolve(); } };
    const timer = setTimeout(() => {
        // Solo si no saludó antes: si ya bajó, no hay nada que declarar aquí.
        if (!greeted) {
            check('el WebSocket sube a través del túnel', false, 'no llegó el saludo en 15 s');
        }
        finish();
    }, 15000);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'JOIN', name: 'Prueba por tunel', sessionId: 'abcdef0123456789'
        }));
    };
    ws.onmessage = (event) => {
        let msg = null;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'HELLO') {
            // Una sola vez: el saludo solo llega al abrir. Volver a marcarlo
            // desde el temporizador de abajo daría un falso FAIL.
            if (!greeted) {
                greeted = true;
                check('el WebSocket sube a través del túnel', true, `sesión ${msg.sessionId}`);
            }
            ws.send(JSON.stringify({ type: 'PING', t: Date.now() }));
            return;
        }
        if (msg.type === 'PONG') {
            pings.push(Math.round(Date.now() - msg.t));
        }
    };
    // Un socket que no puede abrirse no da ni error ni cierre: se queda
    // colgando en CONNECTING. Por eso decide el temporizador, no el onerror.
    ws.onerror = finish;

    // Rondas de ping para medir el retraso real del túnel.
    setTimeout(() => {
        for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: 'PING', t: Date.now() }));
    }, 1500);

    setTimeout(() => {
        // Si no hubo saludo, el túnel no reenvió el salto. Solo entonces se
        // declara el fallo; si ya entró, no se toca el resultado.
        if (!greeted) {
            check('el WebSocket sube a través del túnel', false,
                  'sigue en CONNECTING: el túnel no reenvía el salto');
        }
        if (pings.length) {
            const avg = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
            check('el ping por el túnel es jugable', avg < 250,
                  `${avg} ms de media (${pings.join(', ')})`);
        }
        clearTimeout(timer);
        finish();
    }, 9000);
});

report();

function report() {
    const bad = results.filter((r) => !r).length;
    console.log(`\n${results.length - bad}/${results.length} checks passed`);
    process.exit(bad === 0 ? 0 : 1);
}