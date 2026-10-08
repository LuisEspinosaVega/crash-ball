#!/usr/bin/env node
// tools/smoke-test.mjs — end-to-end check against a running Crash Ball server.
//
//   node tools/smoke-test.mjs [port] [host]
//
// Verifies the two things a browser depends on and that are easy to get
// silently wrong: the RFC 6455 handshake (Node's WebSocket rejects a bad
// Sec-WebSocket-Accept, so a successful connect proves SHA-1 + base64) and the
// JSON game protocol. It also proves the simulation actually advances.

// First non-flag argument is the port, the second is the host. Flags may come
// anywhere: `smoke-test.mjs --rooms 8080` and `smoke-test.mjs 8080 --rooms`
// both work, which matters when you are iterating on one suite.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PORT = positional[0] ? Number(positional[0]) : 8080;
const HOST = positional[1] || '127.0.0.1';
const HTTP_BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}`;

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the server instead of assuming it is already up. A freshly built
// binary can take a moment to start, and a bare "fetch failed" is a bad way to
// learn that nothing is listening.
async function waitForServer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'sin respuesta';

    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${HTTP_BASE}/`);
            if (res.status) return true;
        } catch (err) {
            lastError = err.cause?.code || err.message || String(err);
        }
        await sleep(400);
    }

    console.error(`\nNo hay ningun servidor respondiendo en ${HTTP_BASE}`);
    console.error(`ultimo error: ${lastError}\n`);
    console.error('Arranca el servidor antes de lanzar este test, por ejemplo:');
    console.error('  ./build/Release/server.exe 8080        (Windows)');
    console.error('  ./build/server 8080                    (Linux / macOS)\n');
    return false;
}

// ─── Static file serving ───────────────────────────────────────────

// Fetches through fetch() but surfaces the underlying cause, because undici
// reports everything as a bare "fetch failed".
async function httpGet(path) {
    try {
        const res = await fetch(`${HTTP_BASE}${path}`);
        const body = await res.text();
        return { status: res.status, body };
    } catch (err) {
        const cause = err.cause;
        const detail = cause
            ? `${cause.name || ''} ${cause.code || cause.message || ''}`.trim()
            : err.message;
        throw new Error(detail || 'fetch failed');
    }
}

async function testHttp() {
    let html = null;
    try {
        const res = await httpGet('/');
        html = res.body;
        check('GET / returns 200', res.status === 200, `status ${res.status}`);
        check('GET / serves the game page', /Crash Ball/i.test(html));
        check('GET / references the vendored Three.js',
              html.includes('vendor/three.min.js'));
        check('GET / declares a local favicon', html.includes('rel="icon"'));
        // Only src/href targets matter: a data: URI or an xmlns is not a
        // network request.
        check('GET / makes no external requests',
              !/(?:src|href)\s*=\s*["']https?:\/\//i.test(html));
    } catch (err) {
        check('GET / returns 200', false, String(err));
    }

    for (const asset of ['/js/ui.js', '/js/net.js', '/js/menu.js', '/js/arena.js',
                         '/js/main.js', '/styles.css', '/vendor/three.min.js', '/favicon.png']) {
        try {
            const res = await httpGet(asset);
            check(`GET ${asset}`, res.status === 200 && res.body.length > 0,
                  `status ${res.status}, ${res.body.length} bytes`);
        } catch (err) {
            check(`GET ${asset}`, false, String(err));
        }
    }

    try {
        // Percent-encoded so fetch does not normalise it away client-side.
        const res = await httpGet('/%2e%2e/CMakeLists.txt');
        check('path traversal is refused', res.status === 404,
              `status ${res.status}`);
    } catch (err) {
        check('path traversal is refused', false, String(err));
    }

    try {
        const res = await httpGet('/no-such-file.txt');
        check('unknown path returns 404', res.status === 404,
              `status ${res.status}`);
    } catch (err) {
        check('unknown path returns 404', false, String(err));
    }

    // Only public/ is exposed; the source backup next to it must not be.
    for (const path of ['/legacy/game.js', '/%2e%2e/legacy/game.js',
                        '/vendor/%2e%2e/%2e%2e/CMakeLists.txt']) {
        try {
            const res = await httpGet(path);
            check(`backup/source is not served: ${path}`, res.status === 404,
                  `status ${res.status}`);
        } catch (err) {
            check(`backup/source is not served: ${path}`, false, String(err));
        }
    }
}

// ─── Rooms ─────────────────────────────────────────────────────────
//
// The lobby is what turns this from "one match everybody shares" into something
// you can actually play online: create a room, share the code, the host starts
// when everyone is in. These checks drive that flow end to end.

const CODE_PATTERN = /^[A-Z2-9]{5}$/;   // the server's alphabet

function openRawClient() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const client = { ws, messages: [], rooms: null, states: [], errors: [], seat: -1,
                         chat: [], sessionId: '' };

        const timer = setTimeout(() => reject(new Error('no HELLO')), 8000);

        ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error('socket error'));
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            client.messages.push(msg.type);
            if (msg.type === 'HELLO') {
                client.sessionId = msg.sessionId;
                clearTimeout(timer);
                resolve(client);
            } else if (msg.type === 'ROOM') {
                client.room = msg;
            } else if (msg.type === 'ROOMS') {
                client.rooms = msg;
            } else if (msg.type === 'STATE') {
                client.states.push(msg);
            } else if (msg.type === 'ERROR' || msg.type === 'REJECT') {
                client.errors.push(msg);
            } else if (msg.type === 'CHAT') {
                client.chat.push(msg);
            } else if (msg.type === 'SEATED') {
                client.seat = msg.seat;
            }
        };

        ws.onopen = () => {};
    });
}

// Espera a que un predicado sobre el estado local devuelva algo truthy.
// (La función waitFor() de la sección de ciclo de vida tiene otra firma.)
const until = (predicate, budgetMs, stepMs = 120) => new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs;
    (async () => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return resolve(value);
            await sleep(stepMs);
        }
        return reject(new Error('timeout'));
    })();
});

async function testRooms() {
    const host = await openRawClient();
    const guest = await openRawClient();

    // ── Crear ──
    host.ws.send(JSON.stringify({
        type: 'ROOM_CREATE', name: 'Anfitrion', title: 'Sala de prueba',
        roundsToWin: 3, difficulty: 'medium', humanSlots: 2
    }));

    let room = null;
    try {
        room = await until(() => host.room, 8000);
    } catch (err) {
        check('ROOM_CREATE returns the room', false, String(err));
        host.ws.close(); guest.ws.close();
        return;
    }

    check('ROOM_CREATE returns the room', true, `código ${room.code}`);
    check('the room code is 5 unambiguous letters', CODE_PATTERN.test(room.code), room.code);
    check('the creator is the host', room.isHost === true && room.hostId >= 0);
    check('a new room waits in the lobby', room.phase === 'lobby');
    check('the room carries its settings',
          room.config && room.config.roundsToWin === 3 &&
          room.config.difficulty === 'medium' && room.config.humanSlots === 2,
          JSON.stringify(room.config));
    check('the roster starts with one player',
          Array.isArray(room.players) && room.players.length === 1 &&
          room.players[0].name === 'Anfitrion');

    // ── Unirse por código ──
    guest.ws.send(JSON.stringify({ type: 'ROOM_JOIN', code: room.code, name: 'Invitado' }));
    let guestRoom = null;
    try {
        guestRoom = await until(() => guest.room, 8000);
    } catch (err) {
        // Say what actually arrived: "timeout" alone hid a real bug for a while.
        const seen = guest.messages.join(',');
        const why = guest.errors.map((e) => e.code + ':' + e.message).join(' | ');
        check('ROOM_JOIN by code works', false,
              `${String(err)} · recibidos [${seen}] · errores [${why}]`);
        host.ws.close(); guest.ws.close();
        return;
    }
    check('ROOM_JOIN by code works', true, `${guestRoom.players.length} jugadores`);
    check('the guest is not the host', guestRoom.isHost === false);
    check('both players see each other',
          guestRoom.players.length === 2 &&
          guestRoom.players.every((p) => p.name === 'Anfitrion' || p.name === 'Invitado'),
          guestRoom.players.map((p) => p.name).join(', '));

    // El anfitrión recibe la actualización del vestíbulo.
    const hostSeesTwo = await until(() => host.room.players.length === 2, 8000).catch(() => null);
    check('the host is told about the new arrival', !!hostSeesTwo);

    // ── El salón no empieza solo ──
    await sleep(500);
    check('the lobby does not start by itself',
          host.room.phase === 'lobby' && host.states.length === 0);

    // ── Solo el anfitrión inicia ──
    guest.ws.send(JSON.stringify({ type: 'ROOM_START' }));
    await sleep(400);
    check('a non-host cannot start the match',
          guest.room.phase === 'lobby' &&
          guest.errors.some((e) => e.code === 'NOT_HOST'),
          guest.errors.map((e) => e.code).join(',') || `phase ${guest.room.phase}`);

    // ── Inicio del anfitrión ──
    host.ws.send(JSON.stringify({ type: 'ROOM_START' }));

    let seated = null;
    try {
        seated = await until(() => host.states.length > 3 ? host : null, 8000);
    } catch (err) {
        seated = null;
    }
    check('the host can start the match', !!seated);
    if (seated) {
        const phase = host.room.phase;
        check('the room is now playing', phase === 'playing', `phase ${phase}`);

        const me = host.room.players.find((p) => p.you);
        const meState = host.states[host.states.length - 1].players.find((p) => p.seat === me.seat);
        check('the host got a wall', me.seat >= 0 && !!meState && meState.bot === false,
              `asiento ${me.seat}`);
        check('free walls are covered by bots',
              host.states[host.states.length - 1].players.filter((p) => p.bot).length === 2,
              `${host.states[host.states.length - 1].players.filter((p) => p.bot).length} bots`);

        const guestSeated = await until(() => guest.seat >= 0 ? guest.seat : null, 8000)
            .catch(() => -1);
        check('the guest was seated too', guestSeated >= 0 && guestSeated !== me.seat,
              `anfitrión ${me.seat}, invitado ${guestSeated}`);
    }

    // ── Chat ──
    guest.ws.send(JSON.stringify({ type: 'CHAT', text: 'hola' }));
    const heard = await until(() => host.chat.length > 0 ? host.chat[0] : null, 5000)
        .catch(() => null);
    check('chat reaches the other player',
          !!heard && heard.from === 'Invitado' && heard.text === 'hola',
          heard ? `${heard.from}: ${heard.text}` : 'no llegó');

    // ── Salir de la sala ──
    // Leaving does not erase you: the entry stays as "away" and the wall is
    // held (played by the AI) for the grace window, so coming back is instant.
    guest.ws.send(JSON.stringify({ type: 'ROOM_LEAVE' }));
    const after = await until(() => {
        const view = host.room;
        return view && view.players.some((p) => p.online === false) ? view : null;
    }, 8000).catch(() => null);
    check('leaving keeps the entry but marks the player as away',
          !!after && after.players.some((p) => p.name === 'Invitado' && p.online === false),
          after ? after.players.map((p) => `${p.name}:${p.online}`).join(', ') : 'nunca se actualizó');

    // Reconnecting with the same session must hand the wall back. A real browser
    // keeps its sessionId in localStorage, so the new connection presents the
    // old one; that is what the server matches on.
    const back = await openRawClient();
    back.ws.send(JSON.stringify({
        type: 'RESUME', code: room.code, sessionId: guest.sessionId
    }));
    const resumed = await until(() => back.seat >= 0 ? back : null, 8000).catch(() => null);
    check('a returning session gets its wall back', !!resumed,
          resumed ? `asiento ${resumed.seat}` : 'no recuperó el asiento');

    back.ws.close();

    host.ws.close();
    guest.ws.close();
}

async function testRoomErrors() {
    const solo = await openRawClient();

    // Código inexistente.
    solo.ws.send(JSON.stringify({ type: 'ROOM_JOIN', code: 'ZZZZZ', name: 'Perdido' }));
    const missing = await until(() => solo.errors[0], 5000).catch(() => null);
    check('an unknown room code is refused',
          !!missing && missing.code === 'ROOM_NOT_FOUND',
          missing ? missing.code : 'sin respuesta');

    // Sala llena.
    const host = await openRawClient();
    const a = await openRawClient();
    const b = await openRawClient();

    host.ws.send(JSON.stringify({ type: 'ROOM_CREATE', name: 'Anfitrion', humanSlots: 2 }));
    const room = await until(() => host.room, 8000).catch(() => null);
    check('a 2-slot room can be created', !!room && room.config.humanSlots === 2);

    a.ws.send(JSON.stringify({ type: 'ROOM_JOIN', code: room.code, name: 'Segundo' }));
    await until(() => a.room, 5000).catch(() => null);

    b.ws.send(JSON.stringify({ type: 'ROOM_JOIN', code: room.code, name: 'Tercero' }));
    const full = await until(() => b.errors[0], 5000).catch(() => null);
    check('a full room refuses more players',
          !!full && full.code === 'ROOM_FULL',
          full ? `${full.code}: ${full.message}` : `sin respuesta (code enviado: "${room.code}")`);

    // Listado de salas.
    solo.ws.send(JSON.stringify({ type: 'ROOMS' }));
    const listing = await until(() => solo.rooms, 5000).catch(() => null);
    const listed = listing && Array.isArray(listing.rooms)
        ? listing.rooms.map((r) => r.code)
        : null;
    check('the room list answers with the open rooms',
          !!listing && Array.isArray(listing.rooms) && listed.includes(room.code),
          listed ? listed.join(', ') : 'sin respuesta');

    for (const c of [solo, host, a, b]) {
        try { c.ws.close(); } catch { /* closed */ }
    }
}

// ─── WebSocket game protocol ───────────────────────────────────────

const WALL_AXIS = { left: 'y', right: 'y', top: 'x', bottom: 'x' };

// The paddle slides over +/-124 at 420 units/s, so holding a direction always
// ends exactly on the limit no matter where it started. Asserting the limit is
// reached — rather than that the number grew — makes the check immune to round
// transitions, which legitimately freeze input for a few seconds.
const POS_LIMIT = 124;

async function driveToLimit(send, getState, seat, axis, move, timeoutMs = 9000) {
    send({ type: 'INPUT', move });
    const deadline = Date.now() + timeoutMs;
    let pos = 0;

    while (Date.now() < deadline) {
        await sleep(120);
        const state = getState();
        if (!state) continue;
        if (state.round.roundOver || state.round.matchOver) continue;  // frozen
        pos = state.players[seat][axis];
        if (move > 0 ? pos >= POS_LIMIT - 0.5 : pos <= -POS_LIMIT + 0.5) break;
    }

    send({ type: 'INPUT', move: 0 });
    return pos;
}

function testGame() {
    return new Promise((resolve) => {
        const ws = new WebSocket(WS_URL);
        const states = [];
        let welcome = null;
        let opened = false;
        let sawDashing = false;
        // Closing a socket we finished with still fires onerror/onclose; without
        // this the suite would report a bogus handshake failure at the end.
        let settled = false;

        const finish = (label, extra = '') => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* already closed */ }
            check(label, false, extra);
            resolve();
        };

        const timeout = setTimeout(() => {
            finish('WebSocket handshake completes',
                   'no WELCOME within 10s');
        }, 10000);

        ws.onerror = (err) => {
            if (settled) return;
            clearTimeout(timeout);
            settled = true;
            check('WebSocket handshake completes', false,
                  `error: ${err.message || err.type}`);
            resolve();
        };

        ws.onopen = () => {
            opened = true;
            check('WebSocket handshake completes (valid Sec-WebSocket-Accept)',
                  true);
            ws.send(JSON.stringify({ type: 'JOIN', name: 'SmokeTest' }));
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (err) {
                finish('server sends valid JSON', String(err));
                return;
            }

            if (msg.type === 'WELCOME') {
                welcome = msg;
                // Make sure a previously finished match is not left idle.
                ws.send(JSON.stringify({ type: 'RESTART' }));
                check('JOIN is answered with WELCOME', true,
                      `seat ${msg.seat}, wall ${msg.wall}`);
                check('WELCOME carries a seat in 0..3',
                      Number.isInteger(msg.seat) && msg.seat >= 0 && msg.seat <= 3);
                check('WELCOME wall matches the seat',
                      msg.wall === ['left', 'top', 'right', 'bottom'][msg.seat],
                      `seat ${msg.seat} -> ${msg.wall}`);
            } else if (msg.type === 'STATE') {
                states.push({ at: Date.now(), msg });
                if (msg.players && msg.players.some((p) => p.dashing)) {
                    sawDashing = true;
                }
            } else if (msg.type === 'REJECT') {
                finish('JOIN is accepted', `rejected: ${msg.reason}`);
            }
        };

        // Drive the test forward once state is flowing.
        (async () => {
            await sleep(1200);
            if (!opened || !welcome) {
                clearTimeout(timeout);
                finish('JOIN is answered with WELCOME', 'timed out');
                return;
            }

            // ── Shape of the state message ──
            const latest = states[states.length - 1]?.msg;
            check('STATE messages are flowing', states.length > 10,
                  `${states.length} in ~1.2s`);
            check('STATE has 4 players',
                  Array.isArray(latest?.players) && latest.players.length === 4);
            check('STATE has a balls array', Array.isArray(latest?.balls));
            check('STATE has round metadata',
                  typeof latest?.round?.roundNumber === 'number' &&
                  typeof latest?.round?.gameTime === 'number' &&
                  typeof latest?.round?.roundsToWin === 'number');
            check('every player reports a wall',
                  latest.players.every((p) =>
                      ['left', 'top', 'right', 'bottom'].includes(p.wall)));
            check('our own seat is marked as human',
                  latest.players[welcome.seat].bot === false);

            const gameTimeAdvances =
                states[states.length - 1].msg.round.gameTime >
                states[0].msg.round.gameTime;
            check('round clock advances', gameTimeAdvances);

            if (latest.balls.length > 0) {
                const first = states.find((s) => s.msg.balls.length > 0)?.msg.balls[0];
                const moved = Math.abs(latest.balls[0].x - first.x) +
                              Math.abs(latest.balls[0].y - first.y);
                check('balls are being simulated', moved > 1, `moved ${moved.toFixed(1)}`);
            } else {
                check('balls are being simulated', false, 'no active balls');
            }

            // ── INPUT actually steers our paddle ──
            const axis = WALL_AXIS[welcome.wall];
            const send = (obj) => ws.send(JSON.stringify(obj));
            const current = () => states[states.length - 1]?.msg;

            const low = await driveToLimit(send, current, welcome.seat, axis, -1);
            check('INPUT move=-1 drives our paddle to the near limit',
                  low <= -POS_LIMIT + 0.5, `${axis} = ${low.toFixed(1)}`);

            const high = await driveToLimit(send, current, welcome.seat, axis, 1);
            check('INPUT move=+1 drives our paddle to the far limit',
                  high >= POS_LIMIT - 0.5, `${axis} = ${high.toFixed(1)}`);

            // Releasing must stop it.
            await sleep(350);
            const stopped = current().players[welcome.seat][axis];
            await sleep(350);
            const stoppedAgain = current().players[welcome.seat][axis];
            check('releasing INPUT stops the paddle',
                  Math.abs(stoppedAgain - stopped) < 8,
                  `${stopped.toFixed(1)} -> ${stoppedAgain.toFixed(1)}`);

            // ── DASH ──
            ws.send(JSON.stringify({ type: 'DASH' }));
            await sleep(120);
            check('DASH sets the dashing flag', sawDashing);

            // ── The match progresses on its own (3 bots are playing) ──
            // The handshake watchdog is no longer relevant from here: this phase
            // legitimately takes tens of seconds, and letting it fire would
            // report a bogus handshake failure.
            clearTimeout(timeout);
            const hpStart = states[0].msg.players.reduce((a, p) => a + p.hp, 0);
            let progressed = false;
            for (let i = 0; i < 120 && !progressed; i++) {
                await sleep(250);
                const s = states[states.length - 1].msg;
                const hpNow = s.players.reduce((a, p) => a + p.hp, 0);
                if (hpNow < hpStart || s.round.roundNumber > states[0].msg.round.roundNumber ||
                    s.round.roundOver) {
                    progressed = true;
                }
            }
            check('the match progresses without client input', progressed,
                  `total hp ${hpStart} -> ` +
                  `${states[states.length - 1].msg.players.reduce((a, p) => a + p.hp, 0)}`);

            ws.close();
            settled = true;
            resolve();
        })();
    });
}

// ─── Multiplayer: seats, independent input, caps, bot handback ─────

function openClient(name) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const client = { ws, name, seat: -1, wall: null, states: [], rejected: null };

        const timer = setTimeout(() => reject(new Error(`${name}: no WELCOME`)), 8000);

        ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`${name}: socket error`));
        };
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'WELCOME') {
                client.seat = msg.seat;
                client.wall = msg.wall;
                // If the match already finished, the server sits idle until
                // asked to restart; the request is ignored mid-match. Doing it
                // here makes every phase run against a live match.
                ws.send(JSON.stringify({ type: 'RESTART' }));
                clearTimeout(timer);
                resolve(client);
            } else if (msg.type === 'REJECT') {
                client.rejected = msg.reason;
                clearTimeout(timer);
                resolve(client);
            } else if (msg.type === 'STATE') {
                client.states.push(msg);
                if (client.states.length > 400) client.states.shift();
            }
        };
        ws.onopen = () => ws.send(JSON.stringify({ type: 'JOIN', name }));
    });
}

const latest = (client) => client.states[client.states.length - 1];

async function testMultiplayer() {
    const players = [];
    try {
        for (let i = 0; i < 4; i++) {
            players.push(await openClient(`P${i + 1}`));
        }
    } catch (err) {
        check('four humans can join', false, String(err));
        for (const p of players) p.ws.close();
        return;
    }

    const seats = players.map((p) => p.seat);
    check('four humans can join',
          players.every((p) => p.seat >= 0), `seats ${seats.join(', ')}`);
    check('each human gets a distinct seat',
          new Set(seats).size === 4, `seats ${seats.join(', ')}`);

    // Wait for everyone's first STATE before reading names out of it.
    await sleep(600);
    check('seat names are preserved',
          players.every((p, i) => latest(p)?.players[p.seat]?.name === `P${i + 1}`),
          players.map((p, i) => `seat ${p.seat}="${latest(p)?.players[p.seat]?.name}"`).join(' '));

    // A fifth human must be refused rather than stealing a seat.
    let fifth = null;
    try {
        fifth = await openClient('P5');
        check('a fifth human is rejected', fifth.rejected !== null,
              fifth.rejected || `got seat ${fifth.seat}`);
        check('the rejected client is told why',
              typeof fifth.rejected === 'string' && fifth.rejected.length > 0,
              String(fifth.rejected));
        // The server closes the socket after rejecting.
        await sleep(300);
    } catch (err) {
        check('a fifth human is rejected', false, String(err));
    }

    // Independent input. Both paddles are driven to OPPOSITE ends of their own
    // walls at the same time: that can only happen if each connection really
    // owns its own paddle.
    const a = players[0];
    const b = players[1];
    const axisA = WALL_AXIS[a.wall];
    const axisB = WALL_AXIS[b.wall];

    const [limitA, limitB] = await Promise.all([
        driveToLimit((o) => a.ws.send(JSON.stringify(o)), () => latest(a), a.seat, axisA, 1),
        driveToLimit((o) => b.ws.send(JSON.stringify(o)), () => latest(b), b.seat, axisB, -1),
    ]);

    check('player A drives its own paddle to one end',
          limitA >= POS_LIMIT - 0.5,
          `${axisA} = ${limitA.toFixed(1)} (seat ${a.seat}, muro ${a.wall})`);
    check('player B drives its own paddle to the opposite end',
          limitB <= -POS_LIMIT + 0.5,
          `${axisB} = ${limitB.toFixed(1)} (seat ${b.seat}, muro ${b.wall})`);
    check('one player cannot move another player\'s paddle',
          latest(a).players[a.seat][axisA] >= POS_LIMIT - 0.5 &&
          latest(a).players[b.seat][axisB] <= -POS_LIMIT + 0.5);

    check('all four clients receive state',
          players.every((p) => p.states.length > 10),
          players.map((p) => p.states.length).join('/'));

    // Leaving hands the wall back to a bot so nobody is left undefended.
    const leavingSeat = b.seat;
    b.ws.close();
    await sleep(1200);
    const reoccupied = latest(a)?.players[leavingSeat];
    check('a vacated seat is handed back to a bot',
          reoccupied?.bot === true && reoccupied?.present === true,
          `seat ${leavingSeat}: bot=${reoccupied?.bot}, name=${reoccupied?.name}`);

    for (const p of players) { try { p.ws.close(); } catch { /* closed */ } }
    if (fifth) { try { fifth.ws.close(); } catch { /* closed */ } }
}

// ─── Round and match lifecycle ─────────────────────────────────────
//
// Verifies the pieces that only show up over time: a round actually ends with
// a named winner, roundsWon is credited exactly once (not once per frame, which
// is what the original code did), the next round resets everyone, and once the
// match is decided a RESTART genuinely starts a fresh match.

async function waitFor(getState, predicate, budgetMs, stepMs = 200) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        const state = getState();
        if (state && predicate(state)) return state;
        await sleep(stepMs);
    }
    return null;
}

async function testLifecycle() {
    let client;
    try {
        client = await openClient('Lifecycle');
    } catch (err) {
        check('lifecycle client joins', false, String(err));
        return;
    }

    const state = () => latest(client);
    const scoresOf = (roundsWon) => roundsWon.join('/');

    // The server may already have played rounds before this test connected, so
    // measure the score delta across one round rather than assuming scores
    // start at zero.
    let live = await waitFor(state, (s) => !s.round.roundOver && !s.round.matchOver, 5000);
    if (!live) {
        client.ws.send(JSON.stringify({ type: 'RESTART' }));
        live = await waitFor(state, (s) => !s.round.roundOver && !s.round.matchOver, 15000);
    }
    if (!live) {
        check('a round is in progress to observe', false, 'match never became live');
        client.ws.close();
        return;
    }

    const scoresBefore = live.players.map((p) => p.roundsWon);
    const roundBefore = live.round.roundNumber;

    // ── A round must end with a winner and a single score credit ──
    // Rounds are defensive and can legitimately run for a couple of minutes,
    // so the budget here is generous; use easy bots to make it brisker.
    const ended = await waitFor(state, (s) => s.round.roundOver, 240000);
    if (!ended) {
        check('a round ends on its own', false, 'no round ended within 240s');
        client.ws.close();
        return;
    }

    check('a round ends on its own', true,
          `round ${roundBefore} -> ${ended.round.roundNumber}, ` +
          `winner seat ${ended.round.winner}`);
    check('the finished round names a winner',
          ended.round.winner >= 0 && ended.round.winner < 4,
          `winner=${ended.round.winner}`);

    const scoresAfter = ended.players.map((p) => p.roundsWon);
    check('the round winner is credited exactly one win',
          scoresAfter[ended.round.winner] === scoresBefore[ended.round.winner] + 1,
          `${scoresOf(scoresBefore)} -> ${scoresOf(scoresAfter)} ` +
          `(winner seat ${ended.round.winner})`);
    check('no other player\'s score changes',
          ended.players.every((p, i) =>
              i === ended.round.winner || p.roundsWon === scoresBefore[i]),
          scoresOf(scoresAfter));

    // The score must not keep climbing while the result screen is up.
    await sleep(900);
    const scoresLater = state().players.map((p) => p.roundsWon);
    check('the score does not increment every frame',
          scoresOf(scoresLater) === scoresOf(scoresAfter),
          `${scoresOf(scoresAfter)} -> ${scoresOf(scoresLater)}`);

    check('the result screen counts down',
          typeof state().round.countdown === 'number',
          `countdown=${state().round.countdown}`);

    // ── Either a new round starts, or the match is decided ──
    const advanced = await waitFor(
        state,
        (s) => s.round.matchOver || s.round.roundNumber > ended.round.roundNumber,
        30000);

    if (!advanced) {
        check('the match advances after the result screen', false, 'stuck');
        client.ws.close();
        return;
    }

    if (advanced.round.matchOver) {
        check('the match advances after the result screen', true, 'match decided');
        check('the match names a winner',
              advanced.round.matchWinner >= 0,
              `matchWinner=${advanced.round.matchWinner}`);
        check('the match winner reached the target score',
              advanced.players[advanced.round.matchWinner].roundsWon >=
              advanced.round.roundsToWin,
              `${advanced.players[advanced.round.matchWinner].roundsWon} >= ` +
              `${advanced.round.roundsToWin}`);

        // ── RESTART ──
        client.ws.send(JSON.stringify({ type: 'RESTART' }));
        const restarted = await waitFor(
            state,
            (s) => !s.round.matchOver && s.round.roundNumber === 1,
            8000);

        if (!restarted) {
            check('RESTART begins a fresh match', false, 'no reset observed');
        } else {
            check('RESTART begins a fresh match', true,
                  `round ${restarted.round.roundNumber}`);
            check('RESTART clears every score',
                  restarted.players.every((p) => p.roundsWon === 0),
                  scoresOf(restarted.players.map((p) => p.roundsWon)));
            check('RESTART revives every player at full health',
                  restarted.players.every((p) => p.alive && p.hp > 0),
                  restarted.players.map((p) => p.hp).join('/'));
        }
    } else {
        check('the match advances after the result screen', true,
              `now round ${advanced.round.roundNumber}`);
        check('a new round revives everyone at full health',
              advanced.players.every((p) => p.alive && p.hp === advanced.round.startHealth),
              advanced.players.map((p) => p.hp).join('/'));
        check('a new round clears the previous winner',
              advanced.round.winner === -1, `winner=${advanced.round.winner}`);
    }

    client.ws.close();
}

// ─── Runner ────────────────────────────────────────────────────────

(async () => {
    console.log(`Crash Ball smoke test -> ${WS_URL}\n`);
    if (!(await waitForServer())) process.exit(2);

    // --rooms runs only the lobby suites: seconds instead of the minutes the
    // round/match lifecycle needs, which is what you want while touching rooms.
    if (process.argv.includes('--rooms')) {
        await testRooms();
        console.log('');
        await testRoomErrors();
        const failed = results.filter((r) => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length === 0 ? 0 : 1);
    }

    await testHttp();
    console.log('');
    await testGame();
    console.log('');
    await testMultiplayer();
    console.log('');
    await testRooms();
    console.log('');
    await testRoomErrors();

    if (!process.argv.includes('--quick')) {
        console.log('');
        await testLifecycle();
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
})();
