#!/usr/bin/env node
// tools/browser-test.mjs — loads the game in real headless Chrome and reports
// what actually happened: uncaught exceptions, console errors, whether the
// WebSocket connected, whether the 3D canvas came up, and whether the HUD is
// being fed live state. Saves a screenshot so the rendering can be eyeballed.
//
//   node tools/browser-test.mjs [url] [screenshotPath]
//
// Uses the Chrome DevTools Protocol directly over Node's built-in WebSocket,
// so it needs no npm packages. Chrome must be installed; pass its path in the
// CHROME_PATH environment variable if it is somewhere unusual.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8080/';
const SHOT_PATH = process.argv[3] || join(tmpdir(), 'crashball-shot.png');
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
    console.error('No Chrome/Edge binary found. Set CHROME_PATH.');
    process.exit(2);
}

if (!(await waitForServer())) process.exit(2);

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast with a clear message rather than loading a page that cannot work.
async function waitForServer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'sin respuesta';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(URL_TO_TEST);
            if (res.status) return true;
        } catch (err) {
            lastError = err.cause?.code || err.message || String(err);
        }
        await sleep(400);
    }
    console.error(`\nNo hay ningun servidor respondiendo en ${URL_TO_TEST}`);
    console.error(`ultimo error: ${lastError}\n`);
    console.error('Arranca el servidor antes de lanzar este test, por ejemplo:');
    console.error('  ./build/Release/server.exe 8080        (Windows)');
    console.error('  ./build/server 8080                    (Linux / macOS)\n');
    return false;
}

const userDataDir = join(tmpdir(), `cb-chrome-${Date.now()}`);
mkdirSync(userDataDir, { recursive: true });

const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--enable-unsafe-swiftshader',   // software WebGL in headless
    '--use-angle=swiftshader',
    '--window-size=1280,800',
    '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
], { stdio: 'ignore' });

// ─── Tiny CDP client ───────────────────────────────────────────────

class Cdp {
    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = [];
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('CDP socket error'));
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve: res, reject: rej } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
                    else res(msg.result);
                } else if (msg.method) {
                    for (const handler of this.handlers) handler(msg);
                }
            };
        });
    }

    on(handler) { this.handlers.push(handler); }

    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`${method} timed out`));
                }
            }, 30000);
        });
    }
}

async function findPageTarget() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('Chrome DevTools endpoint never became available');
}

// ─── Run ───────────────────────────────────────────────────────────

const consoleErrors = [];
const consoleWarnings = [];
const consoleLogs = [];
const exceptions = [];

try {
    const page = await findPageTarget();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();

    cdp.on((msg) => {
        if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            exceptions.push(d.exception?.description || d.text);
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            const text = msg.params.args
                .map((a) => a.value ?? a.description ?? a.type).join(' ');
            if (msg.params.type === 'error') consoleErrors.push(text);
            else if (msg.params.type === 'warning') consoleWarnings.push(text);
            else consoleLogs.push(text);
        } else if (msg.method === 'Log.entryAdded') {
            const entry = msg.params.entry;
            if (entry.level === 'error') consoleErrors.push(entry.text);
            else if (entry.level === 'warning') consoleWarnings.push(entry.text);
        }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    console.log(`Loading ${URL_TO_TEST} in ${chromePath.split(/[\\/]/).pop()}\n`);
    await cdp.send('Page.navigate', { url: URL_TO_TEST });

    // ── Menú ────────────────────────────────────────────────────────
    // The client no longer joins by itself: it opens on the menu, so the test
    // has to walk the flow a real player does. Only then do the HUD checks
    // below mean anything.
    await sleep(3500);

    const menuProbe = `(function () {
        const visible = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01;
        };
        const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
        return JSON.stringify({
            menuVisible: visible('screen-menu'),
            loadingVisible: visible('loading'),
            gameUiVisible: visible('ui'),
            quick: !!document.getElementById('btn-quick'),
            create: !!document.getElementById('btn-create'),
            code: !!document.getElementById('btn-open-code'),
            rooms: !!document.getElementById('room-list'),
            conn: txt('conn-indicator'),
            stageIdle: (document.getElementById('stage') || {}).className || ''
        });
    })()`;

    const menu = JSON.parse((await cdp.send('Runtime.evaluate', {
        expression: menuProbe, returnByValue: true,
    })).result.value);

    check('the menu is the first thing you see', menu.menuVisible === true);
    check('the loading overlay is gone once connected', menu.loadingVisible === false);
    check('the game HUD stays hidden until a match starts', menu.gameUiVisible === false);
    check('the menu offers quick play, create and join by code',
          menu.quick && menu.create && menu.code && menu.rooms);
    check('the menu reports the connection', /conectad/i.test(String(menu.conn)), `conn="${menu.conn}"`);

    // ── Crear sala ─────────────────────────────────────────────────
    // Clicks the real button and reads the DOM, so a handler wired to the wrong
    // element cannot pass unnoticed.
    await cdp.send('Runtime.evaluate', {
        expression: `(function () {
            var name = document.getElementById('input-name');
            if (name) name.value = 'Navegador';
            document.getElementById('btn-create').click();
            document.getElementById('input-room-title').value = 'Sala del test';
            document.getElementById('btn-create-go').click();
            return true;
        })()`,
    });
    await sleep(1500);

    const lobbyProbe = `(function () {
        const visible = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && Number(s.opacity) > 0.01;
        };
        const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
        return JSON.stringify({
            lobbyVisible: visible('screen-lobby'),
            code: txt('lobby-code'),
            players: Array.prototype.map.call(
                document.querySelectorAll('#lobby-players .player-name'),
                function (n) { return n.textContent; }),
            startVisible: visible('btn-start'),
            rules: txt('lobby-rules')
        });
    })()`;

    const lobby = JSON.parse((await cdp.send('Runtime.evaluate', {
        expression: lobbyProbe, returnByValue: true,
    })).result.value);

    check('creating a room opens the lobby', lobby.lobbyVisible === true);
    check('the lobby shows a 5-letter share code',
          /^[A-Z2-9]{5}$/.test(String(lobby.code || '').trim()), `code="${lobby.code}"`);
    check('the lobby lists the creator', (lobby.players || []).length === 1,
          (lobby.players || []).join(', '));
    check('the host gets the start button', lobby.startVisible === true);

    // ── Iniciar partida ────────────────────────────────────────────
    await cdp.send('Runtime.evaluate', {
        expression: `(function () { document.getElementById('btn-start').click(); return true; })()`,
    });

    // Give the page time to fetch assets, open the socket, and run a few frames.
    await sleep(6000);

    const probe = `(function () {
        const canvas = document.querySelector('canvas');
        const cls = (id) => { const el = document.getElementById(id); return el ? el.className : null; };
        const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
        const fill = (id) => { const el = document.getElementById(id); return el ? el.style.width : null; };
        const visible = (id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01;
        };
        return JSON.stringify({
            canvas: !!canvas,
            canvasW: canvas ? canvas.width : 0,
            canvasH: canvas ? canvas.height : 0,
            loadingVisible: visible('loading'),
            uiVisible: visible('ui'),
            menuVisible: visible('screen-menu'),
            lostVisible: visible('connection-lost'),
            roundNumber: txt('round-number'),
            roundTime: txt('round-time'),
            seatLabel: txt('seat-label'),
            roomChip: txt('room-chip'),
            hpNames: [0,1,2,3].map(function (i) { return txt('hb-' + i + '-name'); }),
            hpValues: [0,1,2,3].map(function (i) { return txt('hb-' + i + '-hp'); }),
            hpFills: [0,1,2,3].map(function (i) { return fill('hb-' + i + '-fill'); }),
            seatColors: [0,1,2,3].map(function (i) {
                var el = document.getElementById('hb-' + i);
                return el ? el.style.getPropertyValue('--seat') : null;
            }),
            localSeats: [0,1,2,3].filter(function (i) {
                const el = document.getElementById('hb-' + i);
                return el && el.className.indexOf('is-local') !== -1;
            }),
            bodyChars: document.body.innerText.length
        });
    })()`;

    const first = JSON.parse((await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value);

    await sleep(2500);
    const second = JSON.parse((await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value);

    // ── Verdict ──
    check('page loads with no uncaught exception', exceptions.length === 0,
          exceptions.slice(0, 2).join(' | '));
    check('no console errors', consoleErrors.length === 0,
          consoleErrors.slice(0, 3).join(' | '));
    check('WebSocket connected (loading overlay hidden)', first.loadingVisible === false);
    check('game UI became visible', first.uiVisible === true);
    check('the lobby gives way to the match', first.menuVisible === false);
    check('disconnect banner is hidden', first.lostVisible === false);
    check('Three.js canvas exists and is sized',
          first.canvas && first.canvasW > 0 && first.canvasH > 0,
          `${first.canvasW}x${first.canvasH}`);
    check('HUD shows a round number', /Ronda\s*\d+/.test(String(first.roundNumber)),
          `round="${first.roundNumber}"`);
    check('HUD shows the local seat wall', !!first.seatLabel && first.seatLabel.length > 0,
          `seat="${first.seatLabel}"`);
    check('HUD shows which room we are playing in',
          /Sala [A-Z2-9]{5}|Partida rápida/.test(String(first.roomChip)),
          `room="${first.roomChip}"`);
    check('each health bar carries its seat colour',
          first.seatColors.filter(Boolean).length === 4 &&
          new Set(first.seatColors).size === 4,
          first.seatColors.join(' '));
    check('health bars are labelled from server state',
          first.hpNames.every((n) => !!n && n.length > 0),
          first.hpNames.join(', '));
    check('health bars report hp values',
          first.hpValues.every((v) => v !== null && v !== ''),
          first.hpValues.join(', '));
    check('exactly one health bar is marked as the local player',
          first.localSeats.length === 1, `seats ${first.localSeats.join(',')}`);
    check('round clock is ticking (live STATE reaches the DOM)',
          second.roundTime !== first.roundTime,
          `${first.roundTime} -> ${second.roundTime}`);

    // ── Keyboard input reaches the page ──
    const dashBefore = (await cdp.send('Runtime.evaluate', {
        expression: `(function(){var e=document.getElementById('dash-fill');return e?e.style.width:null;})()`,
        returnByValue: true,
    })).result.value;

    await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
        code: 'Space', key: ' ',
    });
    await sleep(150);
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
        code: 'Space', key: ' ',
    });
    await sleep(250);

    const dashAfter = (await cdp.send('Runtime.evaluate', {
        expression: `(function(){var e=document.getElementById('dash-fill');return e?e.style.width:null;})()`,
        returnByValue: true,
    })).result.value;

    check('Space is handled by the page (dash indicator reacts)',
          dashBefore !== dashAfter, `dash fill ${dashBefore} -> ${dashAfter}`);

    check('no console errors after input', consoleErrors.length === 0,
          consoleErrors.slice(0, 3).join(' | '));

    // ── Screenshot ──
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(SHOT_PATH), { recursive: true });
    writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
    console.log(`\nScreenshot: ${SHOT_PATH}`);

    if (consoleLogs.length) {
        console.log(`\nPage console (${consoleLogs.length} lines, first 5):`);
        for (const line of consoleLogs.slice(0, 5)) console.log(`  ${line}`);
    }
    if (consoleWarnings.length) {
        console.log(`\nWarnings: ${consoleWarnings.slice(0, 3).join(' | ')}`);
    }

    cdp.ws.close();
} catch (err) {
    check('browser test ran to completion', false, String(err));
} finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
