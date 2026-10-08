#!/usr/bin/env node
// tools/smoke-test.mjs — end-to-end check against a running Crash Ball server.
//
//   node tools/smoke-test.mjs [port] [host]
//
// Verifies the two things a browser depends on and that are easy to get
// silently wrong: the RFC 6455 handshake (Node's WebSocket rejects a bad
// Sec-WebSocket-Accept, so a successful connect proves SHA-1 + base64) and the
// JSON game protocol. It also proves the simulation actually advances.

const PORT = process.argv[2] ? Number(process.argv[2]) : 8080;
const HOST = process.argv[3] || '127.0.0.1';
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

    for (const asset of ['/game.js', '/styles.css', '/vendor/three.min.js', '/favicon.png']) {
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

        const finish = (label, extra = '') => {
            try { ws.close(); } catch { /* already closed */ }
            check(label, false, extra);
            resolve();
        };

        const timeout = setTimeout(() => {
            finish('WebSocket handshake completes',
                   'no WELCOME within 10s');
        }, 10000);

        ws.onerror = (err) => {
            clearTimeout(timeout);
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

            clearTimeout(timeout);
            ws.close();
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

    await testHttp();
    console.log('');
    await testGame();
    console.log('');
    await testMultiplayer();

    if (!process.argv.includes('--quick')) {
        console.log('');
        await testLifecycle();
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
})();
