/* ============================================================================
 * main.js — Arranque, enrutado de pantallas y chat.
 * ----------------------------------------------------------------------------
 * Une las tres piezas: net.js habla con el servidor, menu.js pinta el menú y el
 * vestíbulo, arena.js dibuja la partida. Aquí solo se decide qué pantalla se ve
 * según lo que llega, y se atan los botones sueltos.
 * ==========================================================================*/

window.CB = window.CB || {};

(function () {
    'use strict';

    const { el, setText, show, setClass, toast, intOr } = CB.dom;
    const net = CB.net;
    const menu = CB.menu;
    const arena = CB.arena;

    // ─── Estado de la aplicación ───────────────────────────────────

    const app = {
        screen: 'menu',        // 'menu' | 'lobby' | 'game'
        inRoom: false,
        seat: -1,
        chatOpen: false
    };

    // ─── Pantallas ─────────────────────────────────────────────────

    function goTo(screen) {
        app.screen = screen;
        show(el('screen-menu'), screen === 'menu');
        show(el('screen-lobby'), screen === 'lobby');
        show(el('ui'), screen === 'game');

        // El lienzo se ve difuminado cuando no se está jugando: da profundidad
        // sin robar atención a los menús.
        const stage = el('stage');
        setClass(stage, 'is-idle', screen !== 'game');

        if (screen === 'game') {
            menu.stopPolling();
        } else {
            menu.startPolling();
        }
        setClass(el('loading'), 'is-overlay', false);
    }

    function backToMenu() {
        app.inRoom = false;
        app.seat = -1;
        arena.resetState();
        menu.leaveRoomState();
        menu.resetMenu();
        arena.setPaused(false);
        goTo('menu');
        menu.refreshRooms();
    }

    /** ¿Estamos donde toca según la fase de la sala? */
    function syncScreenWithRoom() {
        if (!app.inRoom) return;

        const phase = menu.room.phase;
        if (phase === 'lobby') {
            goTo('lobby');
            return;
        }
        if (phase === 'playing' || phase === 'finished') {
            // Quien no tiene muro sigue en el vestíbulo mirando el partido.
            if (app.seat < 0) {
                goTo('lobby');
            } else {
                goTo('game');
            }
            return;
        }
        goTo('lobby');
    }

    // ─── Mensajes del servidor ─────────────────────────────────────

    function bindProtocol() {
        net.on('connection', function (info) {
            arena.setConnected(info.connected);
            updateConnectionBadge(info);
            show(el('loading'), !info.connected && !net.state.everConnected);

            if (info.connected) {
                net.startPings();
            } else {
                setText(el('connection-lost-detail'), 'Reintentando…');
                show(el('connection-lost'), true);
            }
        });

        net.on('ping', function (ms) {
            const chip = el('ping-chip');
            setText(chip, ms + ' ms');
            setClass(chip, 'is-bad', ms > 180);
            setClass(chip, 'is-mid', ms > 90 && ms <= 180);
            show(el('conn-ping'), true);
            setText(el('conn-ping'), ms + ' ms');
        });

        net.on('WELCOME', function (message) {
            app.inRoom = true;
            app.seat = intOr(message.seat, -1);
            arena.resetState();
            arena.setSeat(app.seat, message.name);
            goTo('game');
            setText(el('connection-lost-detail'), '');
            show(el('connection-lost'), false);
        });

        net.on('SEATED', function (message) {
            app.inRoom = true;
            app.seat = intOr(message.seat, -1);
            arena.setSeat(app.seat, message.name);
            toast('Muro asignado: ' + message.wall, 'good');
        });

        net.on('ROOM', function (message) {
            const wasInRoom = app.inRoom;
            app.inRoom = true;
            menu.applyRoom(message);

            // El servidor confirma con la lista completa; si además nos ha
            // sentado, SEATED/Y WELCOME ya nos habrán puesto en juego.
            const me = message.players.find(function (p) { return p.you; });
            const serverSeat = me ? intOr(me.seat, -1) : -1;
            if (serverSeat !== app.seat) {
                app.seat = serverSeat;
                arena.setSeat(serverSeat, me ? me.name : '');
            }

            syncScreenWithRoom();
            if (!wasInRoom) {
                show(el('connection-lost'), false);
                if (menu.room.quick) {
                    toast('Entraste en la partida rápida', 'good');
                } else {
                    toast('Sala ' + menu.room.code + ' — comparte el código para que entren', 'good', 4200);
                }
            }
        });

        net.on('ROOMS', function (message) {
            menu.renderRoomList(message);
        });

        net.on('STATE', function (message) {
            arena.applyState(message);
            // Si llega estado estando en el vestíbulo, es que ya se puede jugar.
            if (app.screen !== 'game' && app.seat >= 0 && menu.room.phase !== 'lobby') {
                goTo('game');
            }
        });

        net.on('ERROR', function (message) {
            const text = message.message || 'No se pudo completar la operación';
            toast(text, 'bad', 3600);
            // Errores de sala tienen arreglo en el menú: se vuelve allí con el
            // formulario que-usó abierto para reintentar sin buscar nada.
            if (message.code === 'ROOM_NOT_FOUND' || message.code === 'ROOM_FULL') {
                if (!app.inRoom) {
                    const button = el('btn-open-code');
                    if (button) button.click();
                }
            }
        });

        net.on('REJECT', function (message) {
            toast(message.reason || 'El servidor rechazó la conexión', 'bad', 3600);
            backToMenu();
        });

        net.on('KICKED', function (message) {
            toast(message.reason || 'Te expulsaron de la sala', 'bad', 3600);
            backToMenu();
        });

        net.on('NOTICE', function (message) {
            toast(message.text || '', 'info');
        });

        net.on('CHAT', function (message) {
            chat.append(message.from, message.text);
        });

        net.on('closed', function () {
            arena.releaseAllKeys();
        });
    }

    function updateConnectionBadge(info) {
        const badge = el('conn-indicator');
        if (!badge) return;

        if (info.connected) {
            setText(badge, 'Conectado');
            setClass(badge, 'conn-bad', false);
            setClass(badge, 'conn-good', true);
            show(el('connection-lost'), false);
        } else {
            setText(badge, 'Reconectando…');
            setClass(badge, 'conn-good', false);
            setClass(badge, 'conn-bad', true);
        }
    }

    // ─── Chat ──────────────────────────────────────────────────────

    const chat = (function () {
        const log = () => el('chat-log');
        const form = () => el('chat-form');
        const input = () => el('chat-input');
        const MAX_LINES = 60;

        function append(from, text) {
            const box = log();
            if (!box) return;

            const line = document.createElement('li');
            line.className = 'chat-line';

            const who = document.createElement('span');
            who.className = 'chat-from';
            who.textContent = from || 'Anónimo';

            const body = document.createElement('span');
            body.className = 'chat-text';
            // textContent, nunca innerHTML: lo escribe un jugador, no el servidor.
            body.textContent = text || '';

            line.appendChild(who);
            line.appendChild(body);
            box.appendChild(line);

            while (box.children.length > MAX_LINES) box.removeChild(box.firstChild);
            box.scrollTop = box.scrollHeight;

            show(el('chat-toggle'), true);
        }

        function toggle(force) {
            const next = force === undefined ? !app.chatOpen : force;
            app.chatOpen = next;
            show(el('chat'), next);
            if (next) {
                const node = input();
                if (node) node.focus();
            } else {
                const node = input();
                if (node) node.value = '';
                // Devolver el foco al juego: si no, las teclas irían al input.
                document.activeElement && document.activeElement.blur();
            }
        }

        function bind() {
            const node = form();
            if (node) {
                node.addEventListener('submit', function (event) {
                    event.preventDefault();
                    const field = input();
                    const text = field ? field.value.trim() : '';
                    if (!text) {
                        toggle(false);
                        return;
                    }
                    net.send({ type: 'CHAT', text: text });
                    field.value = '';
                });
            }

            const button = el('chat-toggle');
            if (button) button.addEventListener('click', function () { toggle(); });
        }

        return { append: append, toggle: toggle, bind: bind };
    })();

    // ─── Botones sueltos ───────────────────────────────────────────

    /**
     * Contenido del menú de pausa: depende de si eres el anfitrión, porque solo
     * él puede devolver la partida al vestíbulo.
     */
    function renderPausePanel() {
        const isHost = menu.room.isHost;
        const inRoom = menu.room.code !== '';

        setText(el('pause-note'),
            inRoom
                ? (isHost ? 'Eres el anfitrión de ' + menu.room.code + '.'
                          : 'Estás viendo la partida como espectador.')
                : 'Partida rápida: cualquiera puede relanzarla.');

        show(el('btn-to-lobby'), isHost && inRoom);
    }

    function openPause() {
        arena.setPaused(true);
    }

    function togglePause() {
        if (arena.isPaused()) {
            arena.setPaused(false);
        } else {
            openPause();
        }
    }

    function bindOverlayControls() {
        const resume = el('btn-resume');
        if (resume) resume.addEventListener('click', function () {
            arena.setPaused(false);
            resume.blur();
        });

        const quit = el('btn-quit');
        if (quit) quit.addEventListener('click', function () {
            arena.setPaused(false);
            if (app.inRoom) net.send({ type: 'ROOM_LEAVE' });
            backToMenu();
        });

        const toLobby = el('btn-to-lobby');
        if (toLobby) toLobby.addEventListener('click', function () {
            arena.setPaused(false);
            net.send({ type: 'ROOM_LOBBY' });
            goTo('lobby');
        });

        const restart = el('btn-restart');
        if (restart) restart.addEventListener('click', function () {
            net.send({ type: 'RESTART' });
            restart.blur();
        });

        const matchMenu = el('btn-match-menu');
        if (matchMenu) matchMenu.addEventListener('click', function () {
            openPause();
            matchMenu.blur();
        });

        // Esc: abrir/cerrar el menú de partida, o cerrar el chat.
        window.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            if (app.chatOpen) {
                chat.toggle(false);
                return;
            }
            if (app.screen !== 'game') return;
            event.preventDefault();
            togglePause();
        });

        window.addEventListener('keydown', function (event) {
            if (event.code !== 'KeyT' || event.ctrlKey || event.metaKey) return;
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            event.preventDefault();
            chat.toggle(true);
        });
    }

    // ─── Arranque ──────────────────────────────────────────────────

    function init() {
        const loadingText = el('loading-text');

        if (typeof THREE === 'undefined') {
            if (loadingText) {
                loadingText.textContent = 'No se pudo cargar Three.js (vendor/three.min.js).';
            }
            show(el('loading'), true);
            return;
        }

        try {
            arena.initScene();
        } catch (error) {
            console.error('Fallo al inicializar WebGL', error);
            if (loadingText) loadingText.textContent = 'Tu navegador no pudo iniciar WebGL.';
            show(el('loading'), true);
            return;
        }

        arena.bind();
        menu.bind();
        chat.bind();
        bindProtocol();
        bindOverlayControls();
        arena.setPauseHook(renderPausePanel);

        arena.resetState();
        menu.resetMenu();
        goTo('menu');

        arena.animate();

        document.addEventListener('visibilitychange', net.handleVisibility);
        net.connect();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();