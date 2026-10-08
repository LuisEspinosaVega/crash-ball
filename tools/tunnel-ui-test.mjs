#!/usr/bin/env node
// Comprueba que la interfaz AVISA cuando el socket no puede abrirse.
//
// Importa por qué no se prueba con un proxy roto de verdad: el comportamiento
// interesante es el nuestro (net.js, main.js, el aviso), no el del túnel. Y un
// proxy a medio hacer devuelve la página corrupta o cuelga Chrome, con lo que
// se acaba midiendo el arnés en vez del producto.
//
// La prueba parte de la página real, servida por el servidor de verdad, y
// sustituye el WebSocket por uno que nunca abre: exactamente lo que hace un
// túnel o un proxy que no reenvían el salto. Lo que se comprueba es que el
// jugador lee un motivo accionable y no un "reintentando…" eterno.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_PORT = Number(process.argv[2] || 9344);
const PAGE_URL = process.argv[3] || 'http://127.0.0.1:8080/';

// Cliente de CDP mínimo: navegar y evaluar.
//
// Va declarado aquí arriba, y no al final, porque el flujo principal que lo usa
// se ejecuta antes de llegar al final del módulo: al declararlo abajo, la clase
// todavía no existe cuando se pide y sale "Cannot access 'Cdp' before
// initialization". Con `class` no hay izado, así que el sitio importa.
class Cdp {
    constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
    open() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('no se pudo hablar con Chrome'));
            this.ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                const slot = this.pending.get(msg.id);
                if (!slot) return;
                this.pending.delete(msg.id);
                clearTimeout(slot.timer);
                slot(msg);
            };
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve) => {
            // Tope por petición: si Chrome no contesta, se dice qué método fue en
            // vez de quedarse esperando para siempre.
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ error: { message: `sin respuesta a ${method}` } });
            }, 15000);
            this.pending.set(id, (msg) => resolve(msg));
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const msg = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true
        });
        if (msg.error) throw new Error(msg.error.message);
        const res = msg.result;
        if (!res) return null;
        if (res.exceptionDetails) {
            throw new Error('error en la página: ' +
                JSON.stringify(res.exceptionDetails).slice(0, 300));
        }
        return res.result ? res.result.value : null;
    }
}

const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
check('se encuentra Chrome', !!chromePath, chromePath || 'no');

if (!chromePath) process.exit(2);

// El destino que se traga la conexión: acepta el TCP y nunca contesta al salto
// a WebSocket. Es el comportamiento exacto de un túnel que no reenvía el
// handshake, y por eso el navegador se queda en CONNECTING sin error ni cierre.
const SWALLOW_PORT = 8087;
const swallow = createServer(() => { /* acepta y no dice nada */ });
await new Promise((r) => swallow.listen(SWALLOW_PORT, '127.0.0.1', r));

const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(process.env.TEMP || '.', 'cb-ws-diagnostic')}`,
    'about:blank'
], { stdio: 'ignore' });

const watchdog = setTimeout(() => {
    console.error('\nTIMEOUT: la prueba se ha quedado esperando.');
    child.kill();
    process.exit(3);
}, 90000);
watchdog.unref();

try {
    await waitForCdp(DEBUG_PORT);
    const page = await firstPage(DEBUG_PORT);
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1. Antes de nada: con el servidor en pie, la página conecta bien. Si esto
    //    falla, el resto no dice nada sobre el diagnóstico sino sobre el entorno.
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await sleep(3000);
    const ok = JSON.parse(await cdp.eval(`JSON.stringify({
        ids: document.body ? document.querySelectorAll('[id]').length : 0,
        connected: !!(window.CB && CB.net && CB.net.state.connected)
    })`) || '{}');
    check('la página carga y conecta con el servidor real',
          ok.ids > 10 && ok.connected === true,
          `${ok.ids} elementos, conectado=${ok.connected}`);

    // 2. Ahora se rompe el socket a propósito y se reinicia el transporte. El
    //    WebSocket sustituido se queda en CONNECTING y nunca dispara nada: es
    //    el fallo que el jugador no puede distinguir solo.
    // Todo en una sola evaluación: cada Runtime.evaluate corre en su propio
// contexto, así que las variables de una llamada no se ven en la siguiente.
await cdp.eval(`(() => {
        const Real = window.WebSocket;
        // El destino malicioso: un puerto que acepta la conexión TCP y no
        // contesta nunca al saludo de WebSocket. Es lo que hace un túnel o un
        // proxy mal configurado, y es importante que sea así: si el destino
        // rechazara la conexión, el navegador daría error y no habría nada que
        // diagnosticar. El fallo que importa es el silencio.
        const fake = new Real('ws://127.0.0.1:${SWALLOW_PORT}/');
        Object.defineProperty(fake, 'readyState', { get: () => 0 });
        fake.close = function () {};

        window.WebSocket = function () { return fake; };
        window.WebSocket.prototype = Real.prototype;
        CB.net.shutdown();
        CB.net.connect();
        return true;
    })()`);

    // 3. El aviso tiene que aparecer: el reloj del cliente es de 7 s, así que se
    //    espera con margen.
    await sleep(12000);

    // Antes de mirar la pantalla: ¿qué cree el cliente que ha pasado? Si el
    // reloj no se dispara o el motivo no es 'never-opened', el texto que sale
    // es el de otra causa y el aviso sería engañoso.
    const internal = JSON.parse(await cdp.eval(`JSON.stringify({
        reason: CB.net.state.lastFailure,
        readyState: CB.net.state.socket ? CB.net.state.socket.readyState : 'sin socket',
        connected: CB.net.state.connected,
        openTimer: CB.net.state.openTimer
    })`) || '{}');
    console.log(`  estado interno del cliente: ${JSON.stringify(internal)}`);

    check('el cliente detecta que el socket NUNCA abrió (no que se cayó)',
          internal.reason === 'never-opened',
          `razón="${internal.reason}" readyState=${internal.readyState}`);

    const ui = JSON.parse(await cdp.eval(`(function () {
        const visible = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' &&
                   Number(s.opacity) > 0.01;
        };
        const el = document.getElementById('connection-lost');
        const badge = document.getElementById('conn-indicator');
        return JSON.stringify({
            found: !!el,
            visible: visible('connection-lost'),
            text: el ? (el.textContent || '').trim() : '',
            badge: badge ? badge.textContent.trim() : '',
            badgeCls: badge ? badge.className : ''
        });
    })()`) || '{}');

    check('el aviso de conexión perdida se muestra',
          ui.found === true && ui.visible === true,
          `encontrado=${ui.found} visible=${ui.visible}`);

    // 4. Y tiene que explicar la causa. Un "reintentando…" perpetuo es
    //    exactamente el síntoma que se quería quitar.
    const text = (ui.text || '').toLowerCase();
    const explains = (text.includes('túnel') || text.includes('tunel') ||
                      text.includes('proxy') || text.includes('wss') ||
                      text.includes('websocket') || text.includes('salto') ||
                      text.includes('no acepta')) &&
                     !text.includes('reintentando…');
    check('el aviso explica la causa en vez de solo reintentar',
          explains, `"${ui.text}"`);

    // 5. La cabecera también tiene que avisar, que es donde se mira primero. La
    //    clase mala es conn-bad, no is-bad (esa es del chip de ping).
    check('el indicador de la cabecera avisa de que no hay conexión',
          (ui.badgeCls || '').includes('conn-bad'),
          `"${ui.badge}" (${ui.badgeCls})`);
} catch (err) {
    check('la prueba llega hasta el final', false, err.message);
} finally {
    child.kill();
    clearTimeout(watchdog);
    swallow.close();
}

async function waitForCdp(port, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; }
        catch { /* aún no */ }
        await sleep(200);
    }
    throw new Error('Chrome no abrió el puerto de depuración');
}
async function firstPage(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);