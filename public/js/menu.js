/* ============================================================================
 * menu.js — Menú principal y vestíbulo de sala.
 * ----------------------------------------------------------------------------
 * Dos pantallas antes de jugar:
 *
 *   Menú    → tu nombre, partida rápida, crear sala, entrar con código y el
 *             listado de salas abiertas (se refresca solo).
 *   Vestíbulo → quién está dentro, quién está listo, ajustes del anfitrión y
 *             el botón que de verdad pone la partida en marcha.
 *
 * Ninguna de las dos toca Three.js: de eso se ocupa arena.js.
 * ==========================================================================*/

window.CB = window.CB || {};

CB.menu = (function () {
    'use strict';

    const { el, setText, show, intOr } = CB.dom;

    const ROOM_POLL_MS = 3000;

    // Espejo del mensaje ROOM del servidor. Solo lectura desde aquí.
    const room = {
        code: '',
        title: '',
        phase: 'lobby',
        isHost: false,
        hostId: -1,
        quick: false,
        config: { roundsToWin: 3, difficulty: 'hard', humanSlots: 4 },
        players: [],
        botSeats: 0
    };

    let pollTimer = null;
    let settingsDirty = false;

    // ─── Nombre ────────────────────────────────────────────────────

    function storedName() {
        return CB.dom.load('cb.name', '');
    }

    function currentName() {
        const input = el('input-name');
        const name = input && input.value.trim();
        return name || storedName() || 'Jugador';
    }

    function rememberName() {
        const input = el('input-name');
        if (!input) return;
        const name = input.value.trim();
        if (name) CB.dom.save('cb.name', name);
    }

    // ─── Menú principal ────────────────────────────────────────────

    function playerName() {
        return currentName();
    }

    function quickPlay() {
        rememberName();
        // La identidad viaja en cada entrada: es lo que permite recuperar el muro
        // si se cae la conexión o se recarga la página.
        CB.net.send({ type: 'QUICK', name: playerName(), sessionId: CB.net.sessionId() });
        // El servidor responde con WELCOME y la partida empieza sola.
    }

    function createRoom() {
        rememberName();
        const titleInput = el('input-room-title');
        const config = {
            title: titleInput ? titleInput.value.trim() : '',
            roundsToWin: intOr(el('select-rounds') && el('select-rounds').value, 3),
            difficulty: (el('select-difficulty') && el('select-difficulty').value) || 'hard',
            humanSlots: intOr(el('select-slots') && el('select-slots').value, 4)
        };
        CB.net.send({
            type: 'ROOM_CREATE',
            name: playerName(),
            sessionId: CB.net.sessionId(),
            title: config.title,
            roundsToWin: config.roundsToWin,
            difficulty: config.difficulty,
            humanSlots: config.humanSlots
        });
        showPanel(null);
    }

    function joinWithCode() {
        rememberName();
        const input = el('input-code');
        const code = normalizeCode(input ? input.value : '');
        if (code.length !== 5) {
            CB.dom.toast('El código tiene 5 letras', 'bad');
            return;
        }
        CB.net.send({ type: 'ROOM_JOIN', code: code, name: playerName(),
                    sessionId: CB.net.sessionId() });
    }

    function joinRoom(code) {
        rememberName();
        CB.net.send({ type: 'ROOM_JOIN', code: code, name: playerName(),
                      sessionId: CB.net.sessionId() });
    }

    function normalizeCode(raw) {
        return String(raw || '')
            .toUpperCase()
            .replace(/[^A-Z]/g, '')
            .slice(0, 5);
    }

    function refreshRooms() {
        CB.net.send({ type: 'ROOMS' });
    }

    function renderRoomList(payload) {
        const list = el('room-list');
        if (!list) return;

        const rooms = Array.isArray(payload && payload.rooms) ? payload.rooms : [];
        list.textContent = '';

        if (rooms.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'room-empty';
            empty.textContent = 'No hay salas abiertas todavía. Crea tú la primera.';
            list.appendChild(empty);
            return;
        }

        for (let i = 0; i < rooms.length; i++) {
            list.appendChild(buildRoomRow(rooms[i]));
        }
    }

    function buildRoomRow(item) {
        const row = document.createElement('li');
        row.className = 'room-row';

        const info = document.createElement('div');
        info.className = 'room-info';

        const title = document.createElement('span');
        title.className = 'room-title';
        title.textContent = item.title || 'Sala sin nombre';

        const code = document.createElement('span');
        code.className = 'room-code';
        code.textContent = item.code;

        const meta = document.createElement('span');
        meta.className = 'room-meta';
        meta.textContent =
            item.players + '/' + item.maxPlayers + ' · ' +
            (item.phase === 'lobby' ? 'en el vestíbulo' :
             item.phase === 'playing' ? 'jugando' : 'terminada') +
            ' · a ' + item.roundsToWin +
            ' · bots ' + item.difficulty;

        info.appendChild(title);
        info.appendChild(code);
        info.appendChild(meta);

        const join = document.createElement('button');
        join.type = 'button';
        join.className = 'btn btn-small' + (item.phase === 'playing' ? ' btn-ghost' : '');
        join.textContent = item.phase === 'playing' ? 'Ver' : 'Entrar';
        join.addEventListener('click', function () { joinRoom(item.code); });

        row.appendChild(info);
        row.appendChild(join);
        return row;
    }

    /**
     * Abre o cierra un subformulario. Solo uno a la vez: abrir el de código
     * cierra el de crear, y al revés.
     *
     * Devuelve true si ha quedado abierto, para poder enfocar el campo
     * correspondiente.
     */
    function togglePanel(which) {
        const target = which === 'create' ? el('panel-create') : el('panel-code');
        const wasHidden = !!target && target.classList.contains('hidden');
        showPanel(wasHidden ? which : null);
        return wasHidden;
    }

    /** Muestra uno de los subformularios del menú, o ninguno. */
    function showPanel(which) {
        show(el('panel-create'), which === 'create');
        show(el('panel-code'), which === 'code');
    }

    function resetMenu() {
        showPanel(null);
        const nameInput = el('input-name');
        if (nameInput) nameInput.value = storedName();
    }

    // ─── Vestíbulo ─────────────────────────────────────────────────

    function applyRoom(payload) {
        room.code = payload.code || '';
        room.title = payload.title || '';
        room.phase = payload.phase || 'lobby';
        room.isHost = !!payload.isHost;
        room.hostId = intOr(payload.hostId, -1);
        room.quick = !!payload.quick;
        room.config = payload.config || room.config;
        room.players = Array.isArray(payload.players) ? payload.players : [];
        room.botSeats = intOr(payload.botSeats, 0);

        if (room.code) {
            CB.dom.save('cb.room', room.code);
        } else {
            CB.dom.remove('cb.room');
        }
        renderLobby();
    }

    function leaveRoomState() {
        room.code = '';
        room.players = [];
        room.isHost = false;
        room.hostId = -1;
        CB.dom.remove('cb.room');
    }

    function renderLobby() {
        const title = el('lobby-title');
        setText(title, room.quick ? 'Partida rápida' : (room.title || 'Sala'));

        const codeButton = el('lobby-code');
        setText(codeButton, room.quick ? '—' : room.code);

        setText(el('lobby-rules'), rulesLabel());

        renderPlayers();
        renderLobbyControls();
    }

    function rulesLabel() {
        const config = room.config || {};
        const slots = intOr(config.humanSlots, 4);
        return 'Primero a ' + intOr(config.roundsToWin, 3) +
            ' rondas · ' + slots + (slots === 1 ? ' jugador' : ' jugadores') +
            ' · bots ' + difficultyLabel(config.difficulty) +
            (room.botSeats > 0 ? ' · ' + room.botSeats + ' muros de bot' : '');
    }

    function difficultyLabel(value) {
        switch (value) {
            case 'easy': return 'fáciles';
            case 'medium': return 'medios';
            case 'expert': return 'expertos';
            case 'hard': return 'difíciles';
            default: return 'difíciles';
        }
    }

    function renderPlayers() {
        const list = el('lobby-players');
        if (!list) return;
        list.textContent = '';

        for (let i = 0; i < room.players.length; i++) {
            list.appendChild(buildPlayerRow(room.players[i]));
        }

        const free = intOr(room.config.humanSlots, 4) - room.players.filter(isPresent).length;
        if (free > 0) {
            const empty = document.createElement('li');
            empty.className = 'player-row is-empty';
            empty.textContent = (free === 1 ? 'Queda 1 plaza libre' : 'Quedan ' + free + ' plazas libres');
            list.appendChild(empty);
        }
    }

    function isPresent(player) {
        return player && player.online !== false;
    }

    function buildPlayerRow(player) {
        const row = document.createElement('li');
        row.className = 'player-row';
        if (player.you) row.classList.add('is-you');
        if (player.host) row.classList.add('is-host');
        if (!isPresent(player)) row.classList.add('is-away');

        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = player.name || 'Jugador';
        if (player.host) {
            const crown = document.createElement('span');
            crown.className = 'player-crown';
            crown.textContent = 'anfitrión';
            name.appendChild(crown);
        }

        const status = document.createElement('span');
        status.className = 'player-status';
        if (!isPresent(player)) {
            status.textContent = 'desconectado';
        } else if (player.ai) {
            status.textContent = 'muro en manos de la IA';
        } else if (player.ready) {
            status.textContent = 'listo';
        } else {
            status.textContent = 'preparándose…';
        }

        row.appendChild(name);
        row.appendChild(status);

        if (room.isHost && !player.you && isPresent(player)) {
            const kick = document.createElement('button');
            kick.type = 'button';
            kick.className = 'btn btn-small btn-ghost';
            kick.textContent = 'Expulsar';
            kick.addEventListener('click', function () {
                CB.net.send({ type: 'KICK', id: intOr(player.id, -1) });
            });
            row.appendChild(kick);
        }

        return row;
    }

    function renderLobbyControls() {
        const inLobby = room.phase === 'lobby';
        const players = room.players;
        const me = players.find(function (p) { return p.you; });
        const everyoneReady = players.filter(isPresent).length > 0 &&
            players.filter(isPresent).every(function (p) { return p.ready || p.host; });

        // El anfitrión ve los ajustes solo antes de empezar.
        show(el('lobby-settings'), room.isHost && inLobby);
        syncSettingsInputs();

        const ready = el('btn-ready');
        show(ready, inLobby);
        setText(ready, me && me.ready ? 'Ya no estoy listo' : 'Marcarme listo');

        const start = el('btn-start');
        show(start, room.isHost && inLobby);
        start.disabled = players.filter(isPresent).length === 0;

        const backToLobby = el('btn-back-lobby');
        show(backToLobby, room.isHost && room.phase === 'finished');

        const note = el('lobby-note');
        const notes = [];
        if (!inLobby) {
            notes.push(room.phase === 'playing'
                ? 'Partida en curso. Puedes verlo todo desde el vestíbulo.'
                : 'Partida terminada.');
        }
        if (room.isHost && inLobby && !everyoneReady) {
            notes.push('Puedes iniciar cuando quieras: los bots cubren los huecos.');
        }
        setText(note, notes.join(' '));
        show(note, notes.length > 0);
    }

    function syncSettingsInputs() {
        if (!settingsDirty) {
            setSelect('lobby-rounds', String(intOr(room.config.roundsToWin, 3)));
            setSelect('lobby-slots', String(intOr(room.config.humanSlots, 4)));
            setSelect('lobby-difficulty', room.config.difficulty || 'hard');
        }
    }

    function setSelect(id, value) {
        const node = el(id);
        if (node && node.value !== value) node.value = value;
    }

    function pushSettings() {
        if (!room.isHost || room.phase !== 'lobby') return;
        settingsDirty = true;
        CB.net.send({
            type: 'ROOM_CONFIG',
            roundsToWin: intOr(el('lobby-rounds') && el('lobby-rounds').value, 3),
            humanSlots: intOr(el('lobby-slots') && el('lobby-slots').value, 4),
            difficulty: (el('lobby-difficulty') && el('lobby-difficulty').value) || 'hard'
        });
        // El servidor reenvía el ROOM ya normalizado; se limpia la marca para
        // que la siguiente respuesta vuelva a mandar sobre los selects.
        window.setTimeout(function () { settingsDirty = false; }, 400);
    }

    function sendReady() {
        const me = room.players.find(function (p) { return p.you; });
        CB.net.send({ type: 'READY', ready: !(me && me.ready) });
    }

    function startMatch() {
        CB.net.send({ type: 'ROOM_START' });
    }

    function backToLobby() {
        CB.net.send({ type: 'ROOM_LOBBY' });
    }

    function leaveRoom() {
        CB.net.send({ type: 'ROOM_LEAVE' });
    }

    // ─── Listado de salas ──────────────────────────────────────────

    function startPolling() {
        stopPolling();
        refreshRooms();
        pollTimer = window.setInterval(refreshRooms, ROOM_POLL_MS);
    }

    function stopPolling() {
        if (pollTimer !== null) {
            window.clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // ─── Enlaces ───────────────────────────────────────────────────

    function bind() {
        const quick = el('btn-quick');
        if (quick) quick.addEventListener('click', quickPlay);

        const create = el('btn-create');
        if (create) create.addEventListener('click', function () {
            togglePanel('create');
        });

        const openCode = el('btn-open-code');
        if (openCode) openCode.addEventListener('click', function () {
            const opened = togglePanel('code');
            const input = el('input-code');
            if (opened && input) input.focus();
        });

        const createGo = el('btn-create-go');
        if (createGo) createGo.addEventListener('click', createRoom);

        const codeGo = el('btn-code-go');
        if (codeGo) codeGo.addEventListener('click', joinWithCode);

        const codeInput = el('input-code');
        if (codeInput) {
            // Cinco letras en mayúsculas y sin espacios, sin tener que pensarlo.
            codeInput.addEventListener('input', function () {
                const clean = normalizeCode(codeInput.value);
                if (clean !== codeInput.value) codeInput.value = clean;
            });
            codeInput.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    joinWithCode();
                }
            });
        }

        const refresh = el('btn-refresh-rooms');
        if (refresh) refresh.addEventListener('click', refreshRooms);

        const nameInput = el('input-name');
        if (nameInput) nameInput.addEventListener('change', rememberName);

        const ready = el('btn-ready');
        if (ready) ready.addEventListener('click', sendReady);

        const start = el('btn-start');
        if (start) {
            start.addEventListener('click', startMatch);
            start.addEventListener('click', function () { start.blur(); });
        }

        const back = el('btn-back-lobby');
        if (back) back.addEventListener('click', backToLobby);

        const leave = el('btn-leave-room');
        if (leave) leave.addEventListener('click', leaveRoom);

        const codeBox = el('lobby-code');
        if (codeBox) {
            codeBox.addEventListener('click', function () {
                if (room.quick || !room.code) return;
                CB.dom.copyText(room.code);
            });
        }

        for (const id of ['lobby-rounds', 'lobby-slots', 'lobby-difficulty']) {
            const node = el(id);
            if (node) node.addEventListener('change', pushSettings);
        }
    }

    return {
        room: room,
        bind: bind,
        resetMenu: resetMenu,
        applyRoom: applyRoom,
        leaveRoomState: leaveRoomState,
        renderRoomList: renderRoomList,
        startPolling: startPolling,
        stopPolling: stopPolling,
        refreshRooms: refreshRooms,
        currentName: currentName,
        normalizeCode: normalizeCode,
        rulesLabel: rulesLabel
    };
})();