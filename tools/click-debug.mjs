// Reproduce the user's report with REAL mouse clicks instead of element.click():
// if this fails while the scripted test passes, the problem is hit-testing or
// pointer events, not the handler wiring.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8080/';
const DEBUG_PORT = 9351;

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

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(tmpdir(), 'crashball-click-profile'), 'about:blank',
], { stdio: 'ignore' });

const errors = [];
try {
    const page = await findPage();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    cdp.on((msg) => {
        if (msg.method === 'Runtime.exceptionThrown') {
            errors.push('EXCEPCION: ' + (msg.params.exceptionDetails.exception?.description
                || msg.params.exceptionDetails.text));
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            errors.push('CONSOLA: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
        }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_TO_TEST });
    await sleep(3500);

    const evaluate = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description };
        return { value: r.result.value };
    };

    // What is actually on top at the button's coordinates?
    const probe = (id) => `(function () {
        const el = document.getElementById('${id}');
        if (!el) return JSON.stringify({ missing: true });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const stack = document.elementsFromPoint(cx, cy).map(function (n) {
            return (n.id ? '#' + n.id : n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''));
        });
        return JSON.stringify({
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            visible: getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) > 0.01,
            pointerEvents: getComputedStyle(el).pointerEvents,
            topAtPoint: top ? (top.id ? '#' + top.id : top.tagName + '.' + String(top.className).split(' ')[0]) : null,
            stack: stack,
            inViewport: r.top >= 0 && r.bottom <= window.innerHeight
        });
    })()`;

    for (const id of ['btn-quick', 'btn-create', 'btn-open-code']) {
        const r = await evaluate(probe(id));
        console.log(id, r.error ? 'ERROR ' + r.error : JSON.stringify(r.value, null, 1));
    }

    // Real click on "Crear sala": does the panel open?
    const before = await evaluate(`document.getElementById('panel-create').classList.contains('hidden')`);
    const box = await evaluate(`(function(){const r=document.getElementById('btn-create').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    const pt = box.value;
    for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
            type, x: pt.x, y: pt.y, button: 'left', clickCount: 1,
        });
    }
    await sleep(500);
    const after = await evaluate(`document.getElementById('panel-create').classList.contains('hidden')`);
    console.log('panel oculto antes:', before.value, '-> despues del clic real:', after.value);

    console.log(errors.length ? 'ERRORES:\n' + errors.join('\n') : 'sin errores de consola');
} finally {
    chrome.kill();
}