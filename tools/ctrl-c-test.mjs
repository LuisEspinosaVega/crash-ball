#!/usr/bin/env node
// Comprueba que el servidor se apaga con Ctrl+C, con un evento de consola real.
//
// Por qué este test es necesario: en Windows, child.kill('SIGINT') llama a
// TerminateProcess y mata el proceso sin pasar por el manejador de señales, así
// que "el proceso muere" no demuestra nada sobre el apagado ordenado (de hecho
// daba verde con el servidor roto). Aquí se envía de verdad el CTRL_BREAK_EVENT
// de consola que genera Ctrl+C.
//
// El servidor se lanza con detached:true, que en Windows lo convierte en líder
// de su propio grupo de procesos: así el evento va solo a él.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = process.argv[2] || join(ROOT, 'build', 'Release', 'server.exe');
const PORT = Number(process.argv[3] || 8086);
const CLIENTS = Number(process.argv[4] || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CTRL_BREAK_EVENT (1) sí se puede dirigir a un grupo de procesos concreto.
// CTRL_C_EVENT (0) se reparte por toda la consola y mataría también a Node.
const BREAK_EVENT = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Ctrl {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint ev, uint grp, uint pid);
}
'@
Add-Type -TypeDefinition $sig
$ok = [Ctrl]::GenerateConsoleCtrlEvent(1, [uint32]$args[0], [uint32]$args[0])
if ($ok) { "SENT" } else { "FAILED:" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
`;

function openClient() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'JOIN', name: 'Cliente persistente' }));
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

const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

console.log(`Ctrl+C real (CTRL_BREAK_EVENT) contra ${BIN}`);
console.log(`puerto ${PORT}, ${CLIENTS} clientes conectados\n`);

// detached:true = líder de su propio grupo de procesos en Windows.
const server = spawn(BIN, [String(PORT), 'easy', '1'],
                     { stdio: 'ignore', detached: true });
const pid = server.pid;
console.log(`servidor pid ${pid}`);

let exited = false;
let exitInfo = null;
server.on('exit', (code, signal) => {
    exited = true;
    exitInfo = code === null ? `señal ${signal}` : `código ${code}`;
});

try {
    const up = await waitForPort(10000);
    check('el servidor arranca y responde', up);
    if (!up) throw new Error('no arrancó');

    // Escena real: gente jugando cuando se pulsa Ctrl+C.
    const clients = [];
    try {
        for (let i = 0; i < CLIENTS; i++) clients.push(await openClient());
        console.log(`${clients.length} clientes conectados y jugando`);
        await sleep(1200);
    } catch (err) {
        check('el servidor acepta clientes', false, String(err));
    }
    check(`el servidor acepta ${CLIENTS} clientes`, clients.length === CLIENTS);

    // El Ctrl+C de verdad.
    const sentAt = Date.now();
    const sent = await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-Command', BREAK_EVENT, String(pid)],
                 (err, stdout) => resolve((stdout || '').trim()));
    });
    console.log(`evento de consola enviado: ${sent}`);

    const end = Date.now() + 12000;
    while (Date.now() < end && !exited) await sleep(100);
    const elapsed = Date.now() - sentAt;

    if (!exited) {
        check('el servidor termina al pulsar Ctrl+C', false,
              `sigue vivo ${elapsed} ms después del evento`);
        check('termina en un tiempo razonable', false, `${elapsed} ms`);
    } else {
        check('el servidor termina al pulsar Ctrl+C', true, `${elapsed} ms, ${exitInfo}`);
        check('termina en un tiempo razonable', elapsed < 3000, `${elapsed} ms`);
    }

    // Y lo importante para volver a arrancar: el puerto queda utilizable.
    const reusable = await waitForPort(1500);
    check('el puerto queda libre para reiniciar', !reusable,
          reusable ? 'ocupado' : 'libre');

    for (const c of clients) {
        try { c.close(); } catch { /* ya cerrada */ }
    }
} finally {
    if (!exited) {
        // Limpieza: si se colgara, no dejamos procesos sueltos.
        try { server.kill('SIGKILL'); } catch { /* ya no está */ }
    }
}

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);