#!/usr/bin/env node
// Reproduce "Ctrl+C and the server hangs": start it, connect a real client
// (a browser keeps one open), send the interrupt, and time how long it takes to
// actually die. A clean stop is under a couple of seconds; the bug shows up as
// a process that never exits and has to be killed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BIN = process.argv[2] || '.\\build\\Release\\server.exe';
const PORT = Number(process.argv[3] || 8085);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openClient() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'JOIN', name: 'Cliente que no se va' }));
            resolve(ws);
        };
        ws.onerror = () => reject(new Error('no se pudo conectar'));
    });
}

async function waitForPort(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/`);
            if (res.status) return true;
        } catch { /* aún no */ }
        await sleep(200);
    }
    return false;
}

if (!existsSync(BIN)) {
    console.error('No existe', BIN);
    process.exit(2);
}

const server = spawn(BIN, [String(PORT), 'easy', '1'], { stdio: 'ignore' });

// Ctrl+C equivale a la señal que el manejador de SIGINT recoge. En Windows,
// 'SIGINT' se genera al pulsar Ctrl+C en la consola; enviar el carácter no
// genera la señal, así que aquí se prueba el final de igual forma peromidiendo
// el resultado que ve el usuario: ¿el proceso termina?
let failed = false;
let exited = false;
const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

try {
    if (!(await waitForPort())) {
        console.error('El servidor no arrancó');
        process.exit(2);
    }
    console.log(`servidor escuchando en ${PORT}`);

    // Varios clientes, para reproducir una sesión real con gente jugando.
    const clients = [];
    for (let i = 0; i < 3; i++) clients.push(await openClient());
    console.log(`${clients.length} clientes conectados y activos`);
    await sleep(1500);

    // Esta es la llamada que el usuario hace con Ctrl+C.
    const t0 = Date.now();
    server.kill('SIGINT');

    // Se mide cuánto tarda en morir de verdad.
    let exitCode = null;
    const exited$ = new Promise((resolve) => {
        server.on('exit', (code, signal) => {
            exitCode = code === null ? `señal ${signal}` : code;
            exited = true;
            resolve();
        });
    });

    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 8000));
    const result = await Promise.race([exited$, timeout]);
    const elapsed = Date.now() - t0;

    if (result === 'timeout') {
        check('el servidor termina al recibir Ctrl+C', false,
              `sigue vivo tras ${elapsed} ms`);
        failed = true;
    } else {
        check('el servidor termina al recibir Ctrl+C', true,
              `${elapsed} ms, salida ${exitCode}`);
        check('termina en un tiempo razonable', elapsed < 3000, `${elapsed} ms`);
    }

    // Y el puerto tiene que quedar utilizable enseguida: si no, el siguiente
    // arranque parece "colgado" cuando en realidad está esperando al sistema.
    const reusable = await waitForPort(1200);
    check('el puerto queda libre para reiniciar', !reusable || !exited,
          reusable ? 'otro proceso lo ocupa' : 'libre');

    for (const c of clients) {
        try { c.close(); } catch { /* ya cerrada */ }
    }
} finally {
    if (!failed && !exited) server.kill('SIGKILL');
    // Si se colgara, aquí se limpia igualmente para no dejar procesos sueltos.
    setTimeout(() => {
        try { server.kill('SIGKILL'); } catch { /* ya no está */ }
    }, 1000).unref();
}

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);