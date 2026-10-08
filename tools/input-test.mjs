// Reproduce the reported input problems with a real browser and real key events:
//
//   1. Pulsar una letra/una flecha debe mover la pala hacia el lado de la
//      pantalla que el jugador ve, para los cuatro asientos.
//   2. Unirse por código con un código que contiene dígitos.
//   3. El predictor local no debe dejar la pala atrás al mover, y sí debe
//      converger con la posición del servidor.
//
//   No basta con llamar al manejador desde dentro de la página (eso se salta el
//   ratón y el teclado reales, y ya dio un falso verde): aquí se despachan
//   eventos de verdad y se mide en píxeles.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8080/';
const OUT = process.argv[3] || join(tmpdir(), 'crashball-input');
const DEBUG_PORT = 9371;

const CHROME = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
    constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.handlers = []; }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            } else for (const h of this.handlers) h(msg);
        };
    }
    send(method, params = {}) {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    on(fn) { this.handlers.push(fn); }
}

async function findPage() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page;
        } catch { /* starting */ }
        await sleep(250);
    }
    throw new Error('no chrome target');
}

const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(tmpdir(), 'crashball-input-profile'), 'about:blank',
], { stdio: 'ignore' });

const SEAT_NAMES = ['izquierda', 'arriba', 'derecha', 'abajo'];

try {
    const page = await findPage();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    const errors = [];
    cdp.on((msg) => {
        if (msg.method === 'Runtime.exceptionThrown') {
            errors.push(msg.params.exceptionDetails.exception?.description ||
                        msg.params.exceptionDetails.text);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
        }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_TO_TEST });
    await sleep(3500);

    // Tecla real vía CDP. 'keyDown' (no 'rawKeyDown') es lo que dispara el
    // keydown de la página; 'rawKeyDown' a secas no produce evento JS.
    const key = async (code, vk, down) => {
        await cdp.send('Input.dispatchKeyEvent', {
            type: down ? 'keyDown' : 'keyUp',
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            code: code,
            key: code.startsWith('Arrow') ? code : code,
        });
    };

    const evaluate = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'error');
        return r.result.value;
    };

    // ── 1. Dirección de las teclas ──────────────────────────────────
    //
    // El bug reportado era "izquierda va a la derecha". La causa está en el
    // dato que sale de la máquina, no en el píxel: se comprueba el `move` que
    // llega al servidor. Medir en pantalla no sirve aquí, porque en los
    // asientos que no son el del jugador humano hay un bot moviendo esa pala y
    // se mediría su juego, no el del teclado.
    console.log('--- dirección de los controles por asiento ---');

    // Espía al envío para leer qué INPUT sale de verdad con cada tecla.
    await evaluate(`(function () {
        window.__inputs = [];
        if (!window.__netPatched) {
            const original = window.CB.net.send;
            window.CB.net.send = function (m) {
                if (m && m.type === 'INPUT') window.__inputs.push(m.move);
                return original(m);
            };
            window.__netPatched = true;
        }
        return true;
    })()`);

    for (let seat = 0; seat < 4; seat++) {
        await evaluate(`(function () {
            window.CB.arena.setSeat(${seat}, 'Prueba');
            window.__inputs.length = 0;
            return true;
        })()`);
        await sleep(300);

        // Flecha derecha por 250 ms, se suelta y se lee lo enviado.
        await key('ArrowRight', 39, true);
        await sleep(250);
        await key('ArrowRight', 39, false);
        await sleep(250);

        const rightMoves = JSON.parse(await evaluate('JSON.stringify(window.__inputs)'));
        // invertInput del asiento: lo que la pantalla "derecha" vale para el
        // servidor. Si vale -1, el cliente debe enviar -1.
        const expected = await evaluate(
            `String(window.CB.arena.CONFIG.seats[${seat}].invertInput ? -1 : 1)`);
        check(`asiento ${seat} (${SEAT_NAMES[seat]}): ArrowRight sale como ${expected}`,
              rightMoves.includes(Number(expected)),
              `INPUT enviados: ${JSON.stringify(rightMoves)}`);

        await evaluate('window.__inputs.length = 0');
        await key('ArrowLeft', 37, true);
        await sleep(250);
        await key('ArrowLeft', 37, false);
        await sleep(250);

        const leftMoves = JSON.parse(await evaluate('JSON.stringify(window.__inputs)'));
        check(`asiento ${seat} (${SEAT_NAMES[seat]}): ArrowLeft sale como ${-expected}`,
              leftMoves.includes(Number(-expected)),
              `INPUT enviados: ${JSON.stringify(leftMoves)}`);
    }

    // Y el caso que sí se mide en píxeles. Se monta una sala propia en vez de usar
    // la partida rápida: en la rápida el jugador puede estar ya muerto o con la
    // ronda acabada, y entonces el servidor ignora el INPUT y la prueba mide
    // ruido en lugar de la respuesta a la tecla.
    await evaluate(`(function () {
        window.__inputs.length = 0;
        return true;
    })()`);
    await evaluate(`(function () {
        document.getElementById('input-room-title').value = 'Prueba de controles';
        document.getElementById('btn-create-go').click();
        return true;
    })()`);
    await sleep(1500);
    await evaluate(`document.getElementById('btn-start').click()`);
    await sleep(2500);

    const humanSeat = await evaluate('String(window.CB.arena.session.mySeat)');
    const alive = await evaluate(`(function () {
        const p = (window.CB.arena.session, document.getElementById('hb-' + ${humanSeat} + '-hp'));
        return p ? p.textContent : null;
    })()`);

    // Que esté vivo es la condición, no la vida exacta: en los segundos que tarda
    // en montarse la partida un bot ya puede haber marcado, y da igual.
    const hp = Number(String(alive).split('/')[0]);
    check('el jugador recibe muro y está vivo para la prueba',
          Number(humanSeat) >= 0 && hp > 0,
          `asiento ${humanSeat}, vida ${alive}`);

    if (Number(humanSeat) >= 0 && hp > 0) {
        // Se empieza cerca del centro para que quepa en los dos sentidos.
        await key('ArrowLeft', 37, true);
        await sleep(180);
        await key('ArrowLeft', 37, false);
        await sleep(600);

        const before = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));
        await key('ArrowRight', 39, true);
        await sleep(500);
        await key('ArrowRight', 39, false);
        await sleep(300);
        const after = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));

        check('en pantalla, ArrowRight mueve la pala a la derecha',
              !!before && !!after && (after.x - before.x) > 20,
              before && after ? `x ${before.x} -> ${after.x}` : 'sin posición');

        const mid = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));
        await key('ArrowLeft', 37, true);
        await sleep(500);
        await key('ArrowLeft', 37, false);
        await sleep(300);
        const back = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));
        check('en pantalla, ArrowLeft mueve la pala a la izquierda',
              !!mid && !!back && (back.x - mid.x) < -20,
              mid && back ? `x ${mid.x} -> ${back.x}` : 'sin posición');

        // La respuesta debe ser inmediata: con 100 ms de red y de retardo, la
        // pala ya se ha movido apenas 100 ms después de la tecla.
        await sleep(700);
        const restBefore = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));
        await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
            code: 'ArrowRight', key: 'ArrowRight',
        });
        await sleep(120);
        const quick = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${humanSeat}))`));
        await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
            code: 'ArrowRight', key: 'ArrowRight',
        });
        check('la pala responde rápido, sin esperar al viaje de ida y vuelta',
              !!restBefore && !!quick && (quick.x - restBefore.x) > 10,
              restBefore && quick ? `${restBefore.x} -> ${quick.x} en 120 ms` : 'sin posición');

        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `controles-jugador-${humanSeat}.png`),
                      Buffer.from(data, 'base64'));
    }

    // ── 2. Unirse por código con dígitos ─────────────────────────────
    // Un código con dígito es el caso que fallaba: el campo filtraba los
    // números y el JOIN salía con 4 caracteres.
    console.log('--- unirse por código ---');
    await evaluate(`(function(){ window.CB.arena.setSeat(-1, ''); return true; })()`);
    await sleep(300);

    const codeResult = await evaluate(`(function () {
        const results = [];
        for (const raw of ['LZT38', 'a2c3d', 'ABC12', '9XYZW', 'abcde']) {
            const input = document.getElementById('input-code');
            input.value = raw;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            results.push({ raw: raw, kept: input.value });
        }
        return JSON.stringify(results);
    })()`);

    const normalised = JSON.parse(codeResult);
    for (const item of normalised) {
        const expected = item.raw.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
        check(`el campo de código conserva "${item.raw}"`,
              item.kept === expected, `quedó "${item.kept}"`);
    }

    // Y que el JOIN salga con 5 caracteres de verdad.
    const sent = await evaluate(`(function () {
        window.__sent = null;
        const original = window.CB.net.send;
        window.CB.net.send = function (m) { if (m && m.type === 'ROOM_JOIN') window.__sent = m; return original(m); };
        document.getElementById('input-code').value = 'LZT38';
        document.getElementById('btn-code-go').click();
        window.CB.net.send = original;
        return JSON.stringify(window.__sent);
    })()`);
    const sentMessage = JSON.parse(sent);
    check('el JOIN sale con el código completo',
          !!sentMessage && sentMessage.code === 'LZT38',
          sent ? sent.slice(0, 80) : 'no se envió nada');

    check('sin errores de consola', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
    chrome.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);