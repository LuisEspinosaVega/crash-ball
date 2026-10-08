// Captures the menu and the lobby so the layout can be reviewed by eye.
//   node tools/shots.mjs http://127.0.0.1:8091/ <outdir>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8091/';
const OUT = process.argv[3] || join(tmpdir(), 'crashball-shots');
const DEBUG_PORT = 9345;

const CHROME = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
    constructor(url) {
        this.url = url;
        this.next = 1;
        this.pending = new Map();
        this.handlers = [];
    }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            } else {
                for (const h of this.handlers) h(msg);
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
    on(fn) { this.handlers.push(fn); }
}

async function findPage() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page;
        } catch { /* chrome still starting */ }
        await sleep(250);
    }
    throw new Error('no chrome page target');
}

mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(tmpdir(), 'crashball-shots-profile'), 'about:blank',
], { stdio: 'ignore' });

try {
    const page = await findPage();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_TO_TEST });
    await sleep(3500);

    const shot = async (name) => {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
        console.log('escrito', join(OUT, name));
    };

    await shot('1-menu.png');

    await cdp.send('Runtime.evaluate', {
        expression: `(function(){
            document.getElementById('btn-create').click();
            document.getElementById('btn-open-code').click();
            document.getElementById('input-room-title').value = 'Sala de los amigos';
            return true;
        })()`,
    });
    await sleep(600);
    await shot('2-menu-formularios.png');

    await cdp.send('Runtime.evaluate', {
        expression: `(function(){
            document.getElementById('input-name').value = 'Ana';
            document.getElementById('btn-create-go').click();
            return true;
        })()`,
    });
    await sleep(1500);
    await shot('3-lobby.png');

    // Add a second player through a second socket so the roster is not lonely.
    const joiner = new WebSocket('ws://' + new URL(URL_TO_TEST).host);
    await new Promise((r) => { joiner.onopen = r; });
    const code = await new Promise((resolve) => {
        joiner.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === 'ROOM') resolve(m.code);
        };
        joiner.send(JSON.stringify({ type: 'ROOM_CREATE', name: 'Beto', humanSlots: 2 }));
    });
    joiner.send(JSON.stringify({ type: 'ROOM_JOIN', code, name: 'Beto' }));
    await sleep(1200);
    await shot('4-lobby-con-gente.png');

    // Open the chat from the room.
    await cdp.send('Runtime.evaluate', {
        expression: `(function(){ window.CB.net.send({type:'CHAT', text:'hola a todos'}); return true; })()`,
    });
    await sleep(500);
    await shot('5-chat.png');

    await cdp.send('Runtime.evaluate', {
        expression: `(function(){ document.getElementById('btn-start').click(); return true; })()`,
    });
    await sleep(2500);
    await shot('6-partida.png');

    await cdp.send('Runtime.evaluate', {
        expression: `(function(){ window.CB.arena.setPaused(true); return true; })()`,
    });
    await sleep(400);
    await shot('7-pausa.png');

    joiner.close();
} finally {
    chrome.kill();
}