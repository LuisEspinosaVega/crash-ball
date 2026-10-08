// Verifies the per-seat camera: the player's own wall must always end up at the
// bottom of the frame, whichever wall they defend.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8080/';
const OUT = process.argv[3] || join(tmpdir(), 'crashball-camera');
const DEBUG_PORT = 9361;

const CHROME = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
    constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            }
        };
    }
    send(method, params = {}) {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
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

mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(tmpdir(), 'crashball-camera-profile'), 'about:blank',
], { stdio: 'ignore' });

const NAMES = ['izquierda', 'arriba', 'derecha', 'abajo'];
let failures = 0;

try {
    const page = await findPage();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_TO_TEST });
    await sleep(3500);

    const evaluate = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'error');
        return r.result.value;
    };

    await evaluate(`(function(){ document.getElementById('btn-quick').click(); return true; })()`);
    await sleep(2500);

    // Oculta el HUD: aquí lo que se revisa es dónde ha caído el muro.
    await evaluate(`(function(){ document.getElementById('ui').style.opacity = '0'; return true; })()`);

    for (let seat = 0; seat < 4; seat++) {
        await evaluate(`(function(){ window.CB.arena.setSeat(${seat}, 'Prueba'); return true; })()`);
        await sleep(700);

        // Dónde ha caído la pala de ese asiento, en píxeles.
        const pos = await evaluate(`JSON.stringify(window.CB.arena.paddleScreenPosition(${seat}))`);
        const posValue = pos ? JSON.parse(pos) : null;

        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `seat-${seat}-${NAMES[seat]}.png`), Buffer.from(data, 'base64'));

        // Comprobación real, no por altura: la pala propia tiene que estar MÁS
        // abajo en pantalla que la del asiento opuesto. Si la cámara estiver de
        // lado, ambas acabarían a media altura y un simple "y > mitad" no lo
        // detectaría.
        const opposite = JSON.parse(await evaluate(
            `JSON.stringify(window.CB.arena.paddleScreenPosition(${(seat + 2) % 4}))`));
        const viewportHeight = await evaluate('window.innerHeight');
        const ok = posValue && opposite &&
                   posValue.y > opposite.y + viewportHeight * 0.25;
        if (!ok) failures++;

        console.log(`${ok ? 'PASS' : 'FAIL'}  asiento ${seat} (${NAMES[seat]})` +
                    `  y propia=${posValue ? posValue.y : '?'}` +
                    `  y opuesta=${opposite ? opposite.y : '?'}` +
                    `  de ${viewportHeight}  ${ok ? 'de frente, abajo' : 'NO de frente'}`);
    }
} finally {
    chrome.kill();
}

console.log(failures === 0
    ? '\nla cámara queda de frente para los cuatro asientos'
    : `\n${failures} asiento(s) con la cámara de lado`);
process.exit(failures === 0 ? 0 : 1);