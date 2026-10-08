/* ============================================================================
 * net.js — Transporte: WebSocket, reconexión y sesión.
 * ----------------------------------------------------------------------------
 * Un solo sitio donde vive "cómo hablo con el servidor". Todo lo demás se
 * suscribe a tipos de mensaje con on() y no sabe nada de sockets.
 *
 * Decisiones que importan para jugar online:
 *
 *  · La URL se deriva de location, no de un puerto fijo. Con ws:// en local y
 *    wss:// detrás de un proxy HTTPS (nginx, Caddy) funciona igual, porque el
 *    proxy reenvía el WebSocket al mismo proceso de C++.
 *
 *  · Reconexión con espera creciente y reconsideration inmediata al volver a
 *    la pestaña. El servidor guarda la sesión (sessionId) y devuelve el muro
 *    que tenías, así que caerse 3 s no cuesta la partida.
 *
 *  · PING propio cada 3 s para medir el ping real y detectar conexiones
 *    zombis antes que el servidor.
 * ==========================================================================*/

window.CB = window.CB || {};

CB.net = (function () {
    'use strict';

    const PING_INTERVAL_MS = 3000;
    const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
    const SESSION_KEY = 'cb.sessionId';

    // Cuánto se espera a que el socket abra antes de darlo por imposible. Un
    // WebSocket que no puede establecerse (túnel que no reenvía el salto,
    // proxy que corta la conexión) no dispara ni onopen ni onclose: se queda
    // en CONNECTING para siempre. Sin este reloj la interfaz se queda
    // indefinidamente en "reintentando…" sin decir por qué.
    const OPEN_TIMEOUT_MS = 7000;

    const state = {
        socket: null,
        connected: false,
        everConnected: false,
        pingMs: 0,
        sessionId: '',
        attempts: 0,
        pingTimer: null,
        reconnectTimer: null,
        paused: false,          // se pone true al ocultar la pestaña
        pendingPing: 0,
        openTimer: null,
        sawError: false,      // el último socket llegó a dar error
        // Por qué no hay conexión, en palabras que se puedan arreglar. Vale la
        // pena distinguir: 'nunca-abre' y 'se-cae' son fallos distintos con
        // causas distintas, y el jugador no puede adivinarlo.
        lastFailure: ''
    };

    /**
     * Identidad del jugador ante el servidor.
     *
     * La genera el CLIENTE y no el servidor a propósito: es lo que permite
     * reconectar y recuperar el mismo muro, e incluso entrar desde otro
     * dispositivo si te pasan el identificador. El servidor solo comprueba que
     * tenga forma de identificador.
     */
    function sessionId() {
        if (state.sessionId) return state.sessionId;

        let stored = CB.dom.load(SESSION_KEY, '');
        if (!/^[0-9a-f]{8,32}$/.test(stored)) {
            stored = randomHex();
            CB.dom.save(SESSION_KEY, stored);
        }
        state.sessionId = stored;
        return stored;
    }

    function randomHex() {
        const bytes = new Uint8Array(16);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
        return out;
    }

    const handlers = Object.create(null);

    /** Suscribe un manejador para un tipo de mensaje. Devuelve la función para quitarlo. */
    function on(type, handler) {
        if (!handlers[type]) handlers[type] = [];
        handlers[type].push(handler);
        return function off() {
            const list = handlers[type];
            const index = list.indexOf(handler);
            if (index >= 0) list.splice(index, 1);
        };
    }

    function emit(type, message) {
        const list = handlers[type];
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](message);
            } catch (error) {
                // Un manejador roto no puede tumbar el bus entero.
                console.error('Fallo en el manejador de ' + type, error);
            }
        }
    }

    function wsUrl() {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // location.host incluye el puerto, así que sirve tanto para localhost
        // como para un dominio detrás de proxy.
        return scheme + '//' + location.host;
    }

    function setConnected(connected, reason) {
        if (state.connected === connected && !reason) return;
        state.connected = connected;
        state.lastFailure = connected ? '' : (reason || state.lastFailure);
        emit('connection', {
            connected: connected,
            pingMs: state.pingMs,
            // El motivo viaja con el evento para que la interfaz pueda decir
            // algo útil en vez de un "reintentando…" infinito.
            reason: state.lastFailure,
            attempts: state.attempts
        });
    }

    /**
     * Texto que explica el fallo en lenguaje de "qué hago ahora".
     *
     * Se decide por lo que el navegador ya nos cuenta. Un WebSocket que no
     * puede establecerse por un túnel o un proxy que no reenvían el salto no
     * da error: se queda abriendo. Por eso el caso Interesting es "no abre",
     * no "da error".
     */
    function failureText(reason, attempts) {
        if (reason === 'never-opened') {
            // Aquí NO se puede saber cuál de las dos cosas pasa: desde el
            // navegador, "el servidor no está" y "el proxy no reenvía el salto a
            // WebSocket" se ven igual: los dos son un socket que no abre. Por eso
            // se nombran las dos, en vez de culpar a una y enviar al jugador a
            // mirar donde no es. Fíjate en que la página (HTTP) sí se ve: eso
            // descarta "no hay servidor" y señala al túnel o al proxy.
            const secure = location.protocol === 'https:';
            return secure
                ? 'El servidor no acepta la conexión segura (wss). Si usas un túnel o ' +
                  'proxy, comprueba que reenvía el salto a WebSocket; con HTTP sí ' +
                  'funciona, con el salto no.'
                : 'La página carga pero el socket no abre: o el servidor no está ' +
                  'arrancado, o el túnel o proxy no reenvía el salto a WebSocket.';
        }
        if (reason === 'error') {
            return 'Se perdió la conexión con el servidor.';
        }
        if (attempts > 3) {
            return 'Sin conexión con el servidor. Reintentando…';
        }
        return 'Conectando…';
    }

    function connect() {
        if (state.socket) {
            const ready = state.socket.readyState;
            if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return;
        }
        clearReconnect();

        const url = wsUrl();
        let socket;
        try {
            socket = new WebSocket(url);
        } catch (error) {
            console.warn('No se pudo abrir el WebSocket', error);
            scheduleReconnect();
            return;
        }
        state.socket = socket;

        // Un socket que no puede establecerse no lanza error ni cierra: se
        // queda en CONNECTING. Este reloj convierte ese silencio en un motivo
        // que la interfaz puede mostrar.
        state.openTimer = window.setTimeout(function () {
            if (state.socket !== socket) return;
            if (socket.readyState === WebSocket.OPEN) return;
            try { socket.close(); } catch (error) { /* ya está cerrando */ }
            state.socket = null;
            setConnected(false, 'never-opened');
            scheduleReconnect();
        }, OPEN_TIMEOUT_MS);

        socket.onopen = function () {
            if (state.openTimer !== null) {
                window.clearTimeout(state.openTimer);
                state.openTimer = null;
            }
            state.attempts = 0;
            state.everConnected = true;
            setConnected(true);

            // Intenta recuperar la sesión anterior. Si el servidor no la
            // reconoce no contesta nada y seguimos en el menú, que es el
            // comportamiento correcto.
            const room = CB.dom.load('cb.room', '');
            if (room) {
                send({ type: 'RESUME', code: room, sessionId: sessionId() });
            }
        };

        socket.onmessage = function (event) {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (error) {
                console.warn('Mensaje ilegible del servidor', error);
                return;
            }
            if (!message || typeof message !== 'object') return;

            if (message.type === 'PONG') {
                state.pingMs = Math.round(performance.now() - message.t);
                emit('ping', state.pingMs);
                return;
            }
            if (message.type === 'HELLO' && message.sessionId) {
                // Servidores antiguos generan la identidad aquí; los nuevos la
                // reciben del cliente. Guardarla hace que una recarga del
                // navegador no pierda la partida.
                if (!state.sessionId) {
                    state.sessionId = message.sessionId;
                    CB.dom.save(SESSION_KEY, message.sessionId);
                }
                return;
            }
            emit(message.type, message);
            emit('*', message);
        };

        socket.onerror = function () {
            // onclose llega siempre después y se encarga del reintento. Aquí
            // solo se anota que hubo error, para poder distinguirlo de un
            // socket que simplemente nunca llegó a abrir.
            state.sawError = true;
        };

        socket.onclose = function () {
            if (state.openTimer !== null) {
                window.clearTimeout(state.openTimer);
                state.openTimer = null;
            }
            if (state.socket === socket) state.socket = null;
            const reason = state.sawError ? 'error' : 'closed';
            state.sawError = false;
            setConnected(false, reason);
            emit('closed', {});
            stopPings();
            if (!state.paused) scheduleReconnect();
        };
    }

    function scheduleReconnect() {
        if (state.reconnectTimer !== null) return;
        const delay = BACKOFF_MS[Math.min(state.attempts, BACKOFF_MS.length - 1)];
        state.attempts++;
        state.reconnectTimer = window.setTimeout(function () {
            state.reconnectTimer = null;
            connect();
        }, delay);
    }

    function clearReconnect() {
        if (state.reconnectTimer !== null) {
            window.clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }
    }

    function send(message) {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
        try {
            state.socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.warn('No se pudo enviar', message && message.type, error);
            return false;
        }
    }

    // ─── Latido ────────────────────────────────────────────────────

    function startPings() {
        stopPings();
        const beat = function () {
            if (state.connected) send({ type: 'PING', t: performance.now() });
        };
        beat();
        state.pingTimer = window.setInterval(beat, PING_INTERVAL_MS);
    }

    function stopPings() {
        if (state.pingTimer !== null) {
            window.clearInterval(state.pingTimer);
            state.pingTimer = null;
        }
    }

    /**
     * Al ocultar la pestaña no se puede ni enviar ni recibir de forma fiable.
     * Se corta la conexión a propósito para no arrastrar un socket muerto y se
     * reintenta nada más volver, con la sesión intacta.
     */
    function handleVisibility() {
        const hidden = document.visibilityState === 'hidden';
        if (hidden === state.paused) return;
        state.paused = hidden;

        if (hidden) {
            stopPings();
        } else {
            clearReconnect();
            state.attempts = 0;
            connect();
            if (state.connected) startPings();
        }
    }

    /** Cierre limpio: sin reconexiones ni fugas al abandonar la página. */
    function shutdown() {
        clearReconnect();
        stopPings();
        state.paused = true;
        if (state.socket) {
            state.socket.onclose = null;
            state.socket.close();
            state.socket = null;
        }
    }

    return {
        state: state,
        sessionId: sessionId,
        connect: connect,
        send: send,
        on: on,
        startPings: startPings,
        stopPings: stopPings,
        handleVisibility: handleVisibility,
        shutdown: shutdown,
        failureText: function (info) {
            return failureText(info && info.reason, (info && info.attempts) || 0);
        }
    };
})();