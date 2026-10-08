/* ============================================================================
 * Crash Ball Arena — cliente del navegador (Three.js r128, sin build step)
 * ----------------------------------------------------------------------------
 * El servidor es la ÚNICA autoridad sobre la partida. Este cliente no simula
 * física: solo (a) envía la intención del jugador y (b) interpola y dibuja el
 * último mensaje STATE recibido, para que 20-60 Hz de red se vean suaves a
 * cualquier tasa de refresco.
 *
 * Organización:
 *   1. Configuración            6. Entidades (pala / pelota)
 *   2. DOM y utilidades         7. Red (WebSocket, JOIN, reconexión)
 *   3. Estado en memoria        8. Aplicación del estado del servidor
 *   4. Mapeo de coordenadas     9. Bucle de render e interpolación
 *   5. Escena Three.js         10. Entrada de teclado y arranque
 * ==========================================================================*/
(function () {
    'use strict';

    /* ─── 1. Configuración ─────────────────────────────────────────────── */

    const CONFIG = {
        // El cliente lo sirve el propio servidor de juego, así que el puerto
        // del WebSocket es siempre el de la página. Solo se usa 8080 como
        // respaldo para cuando el HTML se abre desde otro sitio (file://).
        serverPort: location.port || 8080,
        joinName: 'Jugador',
        arenaHalf: 150,            // mundo de juego: x,y ∈ [-150, 150]
        hpMax: 15,
        paddleLength: 50,
        paddleThickness: 12,
        paddleHeight: 14,
        paddleBevel: 1.5,
        ballRadius: 8,
        // Ritmo de suavizado (1/s) del lerp exponencial; independiente del FPS.
        paddleLerpRate: 20,
        ballLerpRate: 22,
        reconnectDelayMs: 3000,
        // Estimación local del enfriamiento del dash: es SOLO un indicador
        // visual y nunca bloquea el envío (el servidor decide de verdad).
        dashCooldownMs: 1500,
        cameraBase: { y: 420, z: 420 },   // con fov 45 encuadra los 300x300
        fov: 45,
        seatColors: ['#00e5ff', '#ff4081', '#7c4dff', '#00c853'],
        // Muro que defiende cada asiento y eje de juego por el que se desliza.
        seats: [
            { wall: 'left',   label: 'izquierda', slide: 'y' },
            { wall: 'top',    label: 'arriba',    slide: 'x' },
            { wall: 'right',  label: 'derecha',   slide: 'y' },
            { wall: 'bottom', label: 'abajo',     slide: 'x' }
        ]
    };

    /* ─── 2. DOM y utilidades ──────────────────────────────────────────── */

    function byId(id) {
        return document.getElementById(id);
    }

    /** Escribe texto solo si el nodo existe y el valor cambió (evita reflows). */
    function setText(el, text) {
        if (el && el.textContent !== text) {
            el.textContent = text;
        }
    }

    /** Muestra/oculta con la clase .hidden sin tocar el DOM si no hace falta. */
    function show(el, visible) {
        if (!el) return;
        if (visible === !el.classList.contains('hidden')) return;
        el.classList.toggle('hidden', !visible);
    }

    function setClass(el, name, on) {
        if (el) el.classList.toggle(name, !!on);
    }

    /** Ancho porcentual de una barra (0-100). */
    function setBarWidth(el, percent) {
        if (el) el.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }

    /** Número finito o 0: blinda el render contra campos ausentes o corruptos. */
    function num(value) {
        return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    /** Factor de interpolación exponencial: 1 - e^(-rate·dt). */
    function smoothing(rate, dt) {
        return 1 - Math.exp(-rate * dt);
    }

    function formatTime(ms) {
        const totalSeconds = Math.max(0, Math.floor(num(ms) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    const dom = {
        stage: byId('stage'),
        loading: byId('loading'),
        loadingText: byId('loading-text'),
        connectionLost: byId('connection-lost'),
        connectionLostDetail: byId('connection-lost-detail'),
        countdown: byId('countdown'),
        ui: byId('ui'),
        roundNumber: byId('round-number'),
        roundTime: byId('round-time'),
        roundGoal: byId('round-goal'),
        seatLabel: byId('seat-label'),
        dashIndicator: byId('dash-indicator'),
        dashLabel: byId('dash-label'),
        dashFill: byId('dash-fill'),
        overlayRound: byId('overlay-round'),
        overlayRoundTitle: byId('overlay-round-title'),
        overlayRoundText: byId('overlay-round-text'),
        overlayMatch: byId('overlay-match'),
        overlayMatchTitle: byId('overlay-match-title'),
        overlayMatchText: byId('overlay-match-text'),
        btnRestart: byId('btn-restart'),
        // Una entrada por asiento; las filas viven en index.html para que el
        // marcado sea verificable (nada de HTML generado desde JS).
        health: [
            { row: byId('hb-0'), name: byId('hb-0-name'), fill: byId('hb-0-fill'), hp: byId('hb-0-hp') },
            { row: byId('hb-1'), name: byId('hb-1-name'), fill: byId('hb-1-fill'), hp: byId('hb-1-hp') },
            { row: byId('hb-2'), name: byId('hb-2-name'), fill: byId('hb-2-fill'), hp: byId('hb-2-hp') },
            { row: byId('hb-3'), name: byId('hb-3-name'), fill: byId('hb-3-fill'), hp: byId('hb-3-hp') }
        ]
    };

    /* ─── 3. Estado en memoria ─────────────────────────────────────────── */

    // Conexión y identidad.
    const net = {
        socket: null,
        reconnectTimer: null,
        mySeat: -1,
        myName: CONFIG.joinName
    };

    // Objetos Three.js (se crean una vez y se reutilizan siempre).
    const world = {
        scene: null,
        camera: null,
        renderer: null,
        clock: null
    };

    // Entidades renderizables.
    const entities = {
        paddles: [],   // índice = asiento (0..3), siempre las cuatro
        balls: []      // pool que solo crece; las sobrantes se ocultan
    };

    // Recursos compartidos (se liberan al descargar la página).
    const assets = {
        paddleGeometry: null,
        ballGeometry: null,
        ballMaterial: null,
        wallSlabGeometry: null,
        wallLineGeometry: null,
        wallMaterials: [],
        sceneExtras: []   // suelos, rejilla, aros, muros: se liberan en teardown()
    };

    // Último estado autoritativo recibido.
    const serverState = {
        round: null,
        players: [],
        balls: []
    };

    // Texto del aviso que se muestra mientras se reintenta la conexión.
    const RETRY_NOTICE = 'Reintentando cada 3 s…';

    // Entrada de teclado: se guarda por código de tecla para que ArrowLeft y
    // KeyA mantenidos a la vez se cancelen correctamente al soltar uno.
    const pressed = Object.create(null);
    const DIRECTION_BY_CODE = {
        ArrowLeft: 'left',
        KeyA: 'left',
        ArrowRight: 'right',
        KeyD: 'right'
    };
    let lastSentMove = null;   // null = desconocido (tras reconectar)
    let dashSentAt = 0;
    let lastDashLabel = '';

    /* ─── 4. Mapeo de coordenadas ──────────────────────────────────────── */

    /**
     * Juego (x, y) -> mundo Three.js: worldX = x, worldZ = -y, +Y arriba.
     * Así el +y del juego apunta "hacia el fondo de la pantalla".
     * `height` es la altura a la que flota la pieza (centro de la geometría).
     */
    function toWorld(x, y, height, out) {
        return out.set(x, height, -y);
    }

    /** Busca un jugador por su campo `seat` (nunca se asume players[i].seat === i). */
    function findPlayer(seat) {
        for (let i = 0; i < serverState.players.length; i++) {
            const player = serverState.players[i];
            if (player && num(player.seat) === seat) return player;
        }
        return null;
    }

    function playerLabel(player) {
        const base = typeof player.name === 'string' && player.name
            ? player.name
            : 'Jugador ' + (num(player.seat) + 1);
        return player.bot ? base + ' · BOT' : base;
    }

    /** Nombre del asiento ganador, o null si `winner` es -1 (empate). */
    function winnerLabel(winner) {
        if (typeof winner !== 'number' || winner < 0) return null;
        const player = findPlayer(winner);
        return player ? playerLabel(player) : 'Jugador ' + (winner + 1);
    }

    /* ─── 5. Escena Three.js ───────────────────────────────────────────── */

    function initScene() {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a1a);
        // Densidad baja: a ~590 unidades de la cámara el velo es sutil, no opaco.
        scene.fog = new THREE.FogExp2(0x0a0a1a, 0.0009);

        const camera = new THREE.PerspectiveCamera(
            CONFIG.fov,
            window.innerWidth / Math.max(1, window.innerHeight),
            1,
            2000
        );

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        const host = dom.stage || document.body;
        host.appendChild(renderer.domElement);

        world.scene = scene;
        world.camera = camera;
        world.renderer = renderer;

        scene.add(new THREE.AmbientLight(0x4a5578, 0.9));
        const sun = new THREE.DirectionalLight(0xffffff, 0.85);
        sun.position.set(160, 320, 200);
        scene.add(sun);

        buildArena(scene);
        createPaddleEntities();
        onWindowResize();
    }

    /** Suelo, rejilla, aro central y los cuatro muros (uno por asiento). */
    function buildArena(scene) {
        const size = CONFIG.arenaHalf * 2;

        const floorGeometry = new THREE.PlaneGeometry(size, size);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0x111634,
            emissive: 0x050a1e,
            roughness: 0.9,
            metalness: 0.1
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        scene.add(floor);
        assets.sceneExtras.push({ object: floor, materials: [floorMaterial], geometries: [floorGeometry] });

        const grid = new THREE.GridHelper(size, 24, 0x1e2a5a, 0x161d3d);
        grid.position.y = 0.05;
        grid.material.transparent = true;
        grid.material.opacity = 0.55;
        scene.add(grid);
        assets.sceneExtras.push({ object: grid, materials: [grid.material], geometries: [grid.geometry] });

        const ringGeometry = new THREE.TorusGeometry(60, 0.9, 6, 72);
        const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x2b3d80, transparent: true, opacity: 0.85 });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        scene.add(ring);
        assets.sceneExtras.push({ object: ring, materials: [ringMaterial], geometries: [ringGeometry] });

        // Muros: una losa translúcida con un filo brillante en su cara interior.
        // Orientación local: el largo va en X y el filo en +Z; cada muro gira su
        // grupo para que +Z mire hacia el centro de la arena.
        assets.wallSlabGeometry = new THREE.BoxGeometry(size, 20, 6);
        assets.wallLineGeometry = new THREE.BoxGeometry(size, 2, 2);

        const wallDefs = [
            { seat: 0, x: -153, z: 0,    rotationY: Math.PI / 2 },   // izquierda
            { seat: 1, x: 0,    z: -153, rotationY: 0 },             // arriba (y=+150)
            { seat: 2, x: 153,  z: 0,    rotationY: -Math.PI / 2 },  // derecha
            { seat: 3, x: 0,    z: 153,  rotationY: Math.PI }        // abajo (y=-150)
        ];

        for (let i = 0; i < wallDefs.length; i++) {
            const def = wallDefs[i];
            const color = CONFIG.seatColors[def.seat];

            const slabMaterial = new THREE.MeshStandardMaterial({
                color: color,
                emissive: color,
                emissiveIntensity: 0.35,
                roughness: 0.4,
                metalness: 0.3,
                transparent: true,
                opacity: 0.22
            });
            const lineMaterial = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9 });
            assets.wallMaterials.push(slabMaterial, lineMaterial);

            const group = new THREE.Group();
            const slab = new THREE.Mesh(assets.wallSlabGeometry, slabMaterial);
            const line = new THREE.Mesh(assets.wallLineGeometry, lineMaterial);
            line.position.set(0, 10, 2.2);
            group.add(slab);
            group.add(line);
            group.position.set(def.x, 10, def.z);
            group.rotation.y = def.rotationY;
            scene.add(group);

            assets.sceneExtras.push({ object: group, materials: [], geometries: [] });
        }
    }

    /** Mantiene la arena entera visible; en pantallas estrechas aleja la cámara. */
    function onWindowResize() {
        if (!world.camera || !world.renderer) return;

        const width = window.innerWidth;
        const height = Math.max(1, window.innerHeight);
        const aspect = width / height;

        world.camera.aspect = aspect;
        // Con aspect < 1.4 el encuadre horizontal aprieta: se separa la cámara.
        const pullBack = aspect < 1.4 ? Math.min(1.4 / Math.max(aspect, 0.45), 2.6) : 1;
        world.camera.position.set(0, CONFIG.cameraBase.y * pullBack, CONFIG.cameraBase.z * pullBack);
        world.camera.lookAt(0, 0, 0);
        world.camera.updateProjectionMatrix();
        world.renderer.setSize(width, height);
    }

    /* ─── 6. Entidades: palas y pelotas ───────────────────────────────── */

    /**
     * Rectángulo redondeado (en realidad un estadio, porque el radio es media
     * altura) en el plano XY. Se usan arcos reales en vez de curvas cuadráticas
     * para que el contorno coincida exactamente con el tamaño nominal.
     */
    function roundedRectangleShape(width, height, radius) {
        const halfW = width / 2;
        const halfH = height / 2;
        const r = Math.min(radius, halfW, halfH);
        const shape = new THREE.Shape();
        shape.moveTo(-halfW + r, -halfH);
        shape.lineTo(halfW - r, -halfH);
        shape.absarc(halfW - r, -halfH + r, r, -Math.PI / 2, 0, false);
        shape.lineTo(halfW, halfH - r);
        shape.absarc(halfW - r, halfH - r, r, 0, Math.PI / 2, false);
        shape.lineTo(-halfW + r, halfH);
        shape.absarc(-halfW + r, halfH - r, r, Math.PI / 2, Math.PI, false);
        shape.lineTo(-halfW, -halfH + r);
        shape.absarc(-halfW + r, -halfH + r, r, Math.PI, Math.PI * 1.5, false);
        return shape;
    }

    /**
     * Geometría única de pala (~50 x 12 x 14, esquinas redondeadas).
     * La sección se dibuja en XY y se extruye en Z, así que se gira -90° en X
     * para dejar el largo en X, el grosor en Z y la altura en Y.
     * Las dimensiones se reducen por el bisel para que el tamaño final sea el
     * nominal (el bisel expande la forma hacia fuera).
     */
    function getPaddleGeometry() {
        if (assets.paddleGeometry) return assets.paddleGeometry;

        const bevel = CONFIG.paddleBevel;
        const geometry = new THREE.ExtrudeGeometry(
            roundedRectangleShape(
                CONFIG.paddleLength - bevel * 2,
                CONFIG.paddleThickness - bevel * 2,
                (CONFIG.paddleThickness - bevel * 2) / 2
            ),
            {
                depth: CONFIG.paddleHeight - bevel * 2,
                bevelEnabled: true,
                bevelThickness: bevel,
                bevelSize: bevel,
                bevelSegments: 2,
                curveSegments: 4,
                steps: 1
            }
        );
        geometry.rotateX(-Math.PI / 2);
        geometry.center();
        assets.paddleGeometry = geometry;
        return geometry;
    }

    function createPaddleEntities() {
        for (let seat = 0; seat < CONFIG.seats.length; seat++) {
            const color = CONFIG.seatColors[seat];
            const material = new THREE.MeshStandardMaterial({
                color: color,
                emissive: color,
                emissiveIntensity: 0.5,
                roughness: 0.35,
                metalness: 0.55,
                transparent: true,
                opacity: 1
            });

            const mesh = new THREE.Mesh(getPaddleGeometry(), material);
            // Seats 0 y 2 patinan por el eje y del juego (= eje Z del mundo).
            mesh.rotation.y = CONFIG.seats[seat].slide === 'y' ? Math.PI / 2 : 0;
            mesh.visible = false;
            world.scene.add(mesh);

            entities.paddles.push({
                mesh: mesh,
                material: material,
                target: new THREE.Vector3(),
                opacityTarget: 0,
                glowTarget: 0.5,
                snap: true
            });
        }
    }

    function getBallAssets() {
        if (!assets.ballGeometry) {
            assets.ballGeometry = new THREE.SphereGeometry(CONFIG.ballRadius, 24, 16);
            assets.ballMaterial = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0x7ff6ff,
                emissiveIntensity: 1.1,
                roughness: 0.15,
                metalness: 0.4
            });
        }
    }

    function createBallEntity() {
        getBallAssets();
        const mesh = new THREE.Mesh(assets.ballGeometry, assets.ballMaterial);
        mesh.visible = false;
        world.scene.add(mesh);
        return { mesh: mesh, target: new THREE.Vector3(), active: false, snap: true };
    }

    /* ─── 7. Red ───────────────────────────────────────────────────────── */

    function connect() {
        if (net.socket && (net.socket.readyState === WebSocket.OPEN ||
                           net.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        // Mismo host y mismo puerto que la página; funciona en localhost, en
        // otro puerto y desde otra máquina de la red.
        const url = 'ws://' + location.hostname + ':' + CONFIG.serverPort;
        let socket;
        try {
            socket = new WebSocket(url);
        } catch (error) {
            console.warn('No se pudo abrir el WebSocket:', error);
            scheduleReconnect();
            return;
        }
        net.socket = socket;

        socket.onopen = function () {
            console.log('Conectado a ' + url);
            setText(dom.connectionLostDetail, RETRY_NOTICE);
            show(dom.loading, false);
            show(dom.connectionLost, false);
            show(dom.ui, true);

            resetRenderingState();          // sin palas ni pelotas viejas
            send({ type: 'JOIN', name: CONFIG.joinName });
            sendMoveIfChanged(true);        // reanuncia la tecla que siga pulsada
        };

        socket.onmessage = function (event) {
            handleMessage(event.data);
        };

        socket.onerror = function () {
            // onclose llega después y se encarga del reintento.
            console.warn('Error en la conexión WebSocket');
        };

        socket.onclose = function () {
            if (net.socket !== socket) return;   // ya hay otra conexión en curso
            console.log('Desconectado del servidor');
            resetRenderingState();
            setText(dom.connectionLostDetail, RETRY_NOTICE);
            show(dom.connectionLost, true);
            scheduleReconnect();
        };
    }

    function scheduleReconnect() {
        if (net.reconnectTimer !== null) return;
        net.reconnectTimer = window.setTimeout(function () {
            net.reconnectTimer = null;
            connect();
        }, CONFIG.reconnectDelayMs);
    }

    function send(message) {
        if (!net.socket || net.socket.readyState !== WebSocket.OPEN) return false;
        net.socket.send(JSON.stringify(message));
        return true;
    }

    function handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            console.warn('Mensaje del servidor ilegible', error);
            return;
        }
        if (!message || typeof message !== 'object') return;

        if (message.type === 'WELCOME') {
            net.mySeat = typeof message.seat === 'number' ? message.seat : -1;
            net.myName = typeof message.name === 'string' && message.name ? message.name : CONFIG.joinName;
            updateSeatLabel();
        } else if (message.type === 'STATE') {
            applyState(message);
        } else if (message.type === 'REJECT') {
            // El servidor puede rechazar el JOIN (partida llena, ya empezada…).
            setText(dom.connectionLostDetail, typeof message.reason === 'string' && message.reason
                ? 'La partida rechazó la conexión: ' + message.reason
                : 'La partida rechazó la conexión.');
            show(dom.connectionLost, true);
        }
    }

    /* ─── 8. Aplicación del estado del servidor ────────────────────────── */

    function applyState(state) {
        serverState.round = state.round && typeof state.round === 'object' ? state.round : null;
        serverState.players = Array.isArray(state.players) ? state.players : [];
        serverState.balls = Array.isArray(state.balls) ? state.balls : [];

        syncPaddleTargets();
        syncBallTargets();
        updateHud();
        updateHealthBars();
        updateCountdown();
        updateOverlays();
    }

    /** Fija posición/visibilidad/opacidad destino de cada pala (sin simular). */
    function syncPaddleTargets() {
        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            const player = findPlayer(seat);

            if (!player) {
                // Asiento sin jugador: nada que dibujar.
                entity.mesh.visible = false;
                entity.opacityTarget = 0;
                entity.snap = true;
                continue;
            }

            toWorld(num(player.x), num(player.y), CONFIG.paddleHeight / 2, entity.target);

            const alive = player.alive !== false && num(player.hp) > 0;
            entity.opacityTarget = alive ? 1 : 0.18;
            entity.glowTarget = !alive ? 0.05 : (player.dashing ? 1.5 : 0.5);

            if (!entity.mesh.visible) {
                // Reaparece (inicio de ronda/reconexión): salta, no se desliza.
                entity.mesh.visible = true;
                entity.snap = true;
            }
        }
    }

    /**
     * Ajusta el pool de pelotas al número que reporta el servidor: crece si
     * hacen falta y oculta las sobrantes. Nunca se destruyen meshes por mensaje.
     */
    function syncBallTargets() {
        const balls = serverState.balls;

        for (let i = 0; i < balls.length; i++) {
            const data = balls[i];
            if (!data) continue;
            if (!entities.balls[i]) entities.balls[i] = createBallEntity();

            const entity = entities.balls[i];
            toWorld(num(data.x), num(data.y), CONFIG.ballRadius, entity.target);
            if (!entity.active) {
                entity.active = true;
                entity.snap = true;
            }
            entity.mesh.visible = true;
        }

        for (let i = balls.length; i < entities.balls.length; i++) {
            const entity = entities.balls[i];
            entity.active = false;
            entity.snap = true;
            entity.mesh.visible = false;
        }
    }

    function updateHud() {
        const round = serverState.round;
        const roundNumber = round ? Math.max(1, Math.round(num(round.roundNumber))) : 1;

        setText(dom.roundNumber, round ? 'Ronda ' + roundNumber : 'Ronda —');
        setText(dom.roundTime, formatTime(round ? round.gameTime : 0));
        setText(dom.roundGoal, round && num(round.roundsToWin) > 0
            ? 'Primero a ' + Math.round(num(round.roundsToWin))
            : '');
        updateSeatLabel();
    }

    function updateSeatLabel() {
        if (net.mySeat < 0 || net.mySeat >= CONFIG.seats.length) {
            setText(dom.seatLabel, 'Tú: —');
            return;
        }
        const player = findPlayer(net.mySeat);
        const name = player ? playerLabel(player) : net.myName;
        setText(dom.seatLabel, 'Tú: ' + name + ' · muro ' + CONFIG.seats[net.mySeat].label);
    }

    function updateHealthBars() {
        for (let seat = 0; seat < dom.health.length; seat++) {
            const row = dom.health[seat];
            const player = findPlayer(seat);

            if (!player) {
                setText(row.name, 'Asiento ' + (seat + 1) + ' libre');
                setText(row.hp, '—');
                setBarWidth(row.fill, 0);
                setClass(row.row, 'is-empty', true);
                setClass(row.row, 'is-dead', false);
                setClass(row.row, 'is-local', false);
                continue;
            }

            const hp = clamp(Math.round(num(player.hp)), 0, CONFIG.hpMax);
            const alive = player.alive !== false && hp > 0;
            const isLocal = seat === net.mySeat;

            setText(row.name, playerLabel(player) + (isLocal ? ' (tú)' : ''));
            setText(row.hp, hp + '/' + CONFIG.hpMax);
            setBarWidth(row.fill, (hp / CONFIG.hpMax) * 100);
            setClass(row.row, 'is-empty', false);
            setClass(row.row, 'is-dead', !alive);
            setClass(row.row, 'is-local', isLocal);
        }
    }

    /**
     * `countdown` no documenta unidad: se acepta segundos (<10) o milisegundos.
     * Fuera de 1..10 segundos no se muestra nada.
     */
    function updateCountdown() {
        const round = serverState.round;
        const raw = round ? num(round.countdown) : 0;
        if (raw <= 0) {
            show(dom.countdown, false);
            return;
        }
        const seconds = raw > 10 ? Math.ceil(raw / 1000) : Math.ceil(raw);
        if (seconds <= 0 || seconds > 10) {
            show(dom.countdown, false);
            return;
        }
        setText(dom.countdown, String(seconds));
        show(dom.countdown, true);
    }

    function updateOverlays() {
        const round = serverState.round;
        const matchOver = !!(round && round.matchOver);
        const roundOver = !!(round && round.roundOver);
        const winner = round && typeof round.winner === 'number' ? round.winner : -1;

        if (matchOver) {
            const label = winnerLabel(winner);
            setText(dom.overlayMatchTitle, label ? '¡' + label + ' gana la partida!' : '¡Empate!');
            setText(dom.overlayMatchText, 'Pulsa R o “Reiniciar partida” para jugar otra vez.');
            show(dom.overlayMatch, true);
            show(dom.overlayRound, false);
            return;
        }

        if (roundOver) {
            const label = winnerLabel(winner);
            const roundNumber = Math.max(1, Math.round(num(round.roundNumber)));
            setText(dom.overlayRoundTitle, 'Ronda ' + roundNumber + ' terminada');
            setText(dom.overlayRoundText, label ? 'Gana ' + label : 'Empate');
            show(dom.overlayRound, true);
            show(dom.overlayMatch, false);
            return;
        }

        show(dom.overlayRound, false);
        show(dom.overlayMatch, false);
    }

    /**
     * Devuelve el cliente a un estado limpio (arranque y reconexión): nada de
     * palas o pelotas del servidor anterior, sin overlays y sin HUD obsoleto.
     * Los meshes NO se destruyen: se reutilizan, por eso reconectar no filtra
     * memoria de GPU.
     */
    function resetRenderingState() {
        serverState.round = null;
        serverState.players = [];
        serverState.balls = [];

        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            entity.mesh.visible = false;
            entity.mesh.position.set(0, CONFIG.paddleHeight / 2, 0);
            entity.material.opacity = 0;
            entity.opacityTarget = 0;
            entity.glowTarget = 0.5;
            entity.snap = true;
        }

        for (let i = 0; i < entities.balls.length; i++) {
            const entity = entities.balls[i];
            entity.active = false;
            entity.snap = true;
            entity.mesh.visible = false;
        }

        setText(dom.roundNumber, 'Ronda —');
        setText(dom.roundTime, '00:00');
        setText(dom.roundGoal, '');
        setText(dom.seatLabel, 'Tú: —');
        setText(dom.countdown, '');

        show(dom.countdown, false);
        show(dom.overlayRound, false);
        show(dom.overlayMatch, false);
        updateHealthBars();

        net.mySeat = -1;
        lastSentMove = null;
        dashSentAt = 0;
        lastDashLabel = '';
    }

    /* ─── 9. Bucle de render e interpolación ───────────────────────────── */

    function interpolate(dt) {
        const paddleFactor = smoothing(CONFIG.paddleLerpRate, dt);
        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            if (!entity.mesh.visible) continue;

            if (entity.snap) {
                entity.mesh.position.copy(entity.target);
                entity.material.opacity = entity.opacityTarget;
                entity.snap = false;
            } else {
                entity.mesh.position.lerp(entity.target, paddleFactor);
                entity.material.opacity += (entity.opacityTarget - entity.material.opacity) * paddleFactor;
            }
            entity.material.emissiveIntensity +=
                (entity.glowTarget - entity.material.emissiveIntensity) * paddleFactor;
        }

        const ballFactor = smoothing(CONFIG.ballLerpRate, dt);
        for (let i = 0; i < entities.balls.length; i++) {
            const entity = entities.balls[i];
            if (!entity.active) continue;

            if (entity.snap) {
                entity.mesh.position.copy(entity.target);
                entity.snap = false;
            } else {
                entity.mesh.position.lerp(entity.target, ballFactor);
            }
        }
    }

    /** Indicador de dash puramente local: no condiciona el envío al servidor. */
    function updateDashIndicator() {
        const progress = dashSentAt === 0
            ? 1
            : clamp((performance.now() - dashSentAt) / CONFIG.dashCooldownMs, 0, 1);

        setBarWidth(dom.dashFill, progress * 100);
        setClass(dom.dashIndicator, 'is-ready', progress >= 1);

        const label = progress >= 1
            ? 'DASH LISTO'
            : 'DASH ' + ((CONFIG.dashCooldownMs * (1 - progress)) / 1000).toFixed(1) + 's';
        if (label !== lastDashLabel) {
            lastDashLabel = label;
            setText(dom.dashLabel, label);
        }
    }

    function animate() {
        window.requestAnimationFrame(animate);

        // dt acotado: tras cambiar de pestaña el primer delta puede ser enorme.
        const dt = Math.min(world.clock.getDelta(), 0.1);
        interpolate(dt);
        updateDashIndicator();
        world.renderer.render(world.scene, world.camera);
    }

    /* ─── 10. Entrada y ciclo de vida ──────────────────────────────────── */

    function currentMove() {
        let left = false;
        let right = false;
        for (const code in pressed) {
            if (!pressed[code]) continue;
            if (DIRECTION_BY_CODE[code] === 'left') left = true;
            else if (DIRECTION_BY_CODE[code] === 'right') right = true;
        }
        return (right ? 1 : 0) - (left ? 1 : 0);
    }

    /** Envía INPUT solo cuando la dirección mantenida cambia (no por frame). */
    function sendMoveIfChanged(force) {
        const move = currentMove();
        if (!force && move === lastSentMove) return;
        lastSentMove = move;
        send({ type: 'INPUT', move: move });
    }

    function sendDash() {
        if (send({ type: 'DASH' })) dashSentAt = performance.now();
    }

    function sendRestart() {
        send({ type: 'RESTART' });
    }

    function isMatchOver() {
        return !!(serverState.round && serverState.round.matchOver);
    }

    function onKeyDown(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const onButton = !!(event.target && event.target.tagName === 'BUTTON');

        if (event.code === 'Space' || event.code === 'Enter') {
            if (onButton) return;                 // deja actuar al botón enfocado
            event.preventDefault();
            if (!event.repeat) sendDash();        // una vez por pulsación
            return;
        }

        if (event.code === 'KeyR') {
            event.preventDefault();
            if (isMatchOver()) sendRestart();
            return;
        }

        if (DIRECTION_BY_CODE[event.code]) {
            event.preventDefault();               // sin scroll de página
            pressed[event.code] = true;
            sendMoveIfChanged(false);
        }
    }

    function onKeyUp(event) {
        if (!DIRECTION_BY_CODE[event.code]) return;
        event.preventDefault();
        pressed[event.code] = false;
        sendMoveIfChanged(false);
    }

    /** Al perder el foco hay que soltar todo, o el jugador seguiría moviéndose. */
    function releaseAllKeys() {
        for (const code in pressed) pressed[code] = false;
        sendMoveIfChanged(true);
    }

    /** Libera geometrías, materiales y contexto WebGL al descargar la página. */
    function teardown() {
        const disposePart = function (part) {
            if (!part) return;
            world.scene.remove(part.object);
            for (let i = 0; i < part.geometries.length; i++) part.geometries[i].dispose();
            for (let i = 0; i < part.materials.length; i++) part.materials[i].dispose();
        };

        if (!world.scene) return;

        for (let i = 0; i < assets.sceneExtras.length; i++) disposePart(assets.sceneExtras[i]);
        assets.sceneExtras.length = 0;

        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            world.scene.remove(entity.mesh);
            entity.material.dispose();
        }
        entities.paddles.length = 0;

        for (let i = 0; i < entities.balls.length; i++) {
            world.scene.remove(entities.balls[i].mesh);
        }
        entities.balls.length = 0;

        if (assets.paddleGeometry) assets.paddleGeometry.dispose();
        if (assets.ballGeometry) assets.ballGeometry.dispose();
        if (assets.ballMaterial) assets.ballMaterial.dispose();
        if (assets.wallSlabGeometry) assets.wallSlabGeometry.dispose();
        if (assets.wallLineGeometry) assets.wallLineGeometry.dispose();
        for (let i = 0; i < assets.wallMaterials.length; i++) assets.wallMaterials[i].dispose();
        assets.paddleGeometry = null;
        assets.ballGeometry = null;
        assets.ballMaterial = null;

        if (net.socket) {
            net.socket.onclose = null;      // sin reconexión durante el cierre
            net.socket.close();
        }
        if (net.reconnectTimer !== null) {
            window.clearTimeout(net.reconnectTimer);
            net.reconnectTimer = null;
        }
        if (world.renderer) {
            world.renderer.dispose();
            if (world.renderer.domElement.parentNode) {
                world.renderer.domElement.parentNode.removeChild(world.renderer.domElement);
            }
        }
    }

    function bindEvents() {
        window.addEventListener('resize', onWindowResize);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', releaseAllKeys);
        window.addEventListener('pagehide', teardown);

        if (dom.btnRestart) {
            dom.btnRestart.addEventListener('click', function () {
                sendRestart();
                dom.btnRestart.blur();   // que ESPACIO vuelva a ser dash, no "reiniciar"
            });
        }
    }

    function init() {
        if (typeof THREE === 'undefined') {
            if (dom.loadingText) dom.loadingText.textContent = 'No se pudo cargar Three.js (vendor/three.min.js).';
            return;
        }

        try {
            initScene();
        } catch (error) {
            console.error('Fallo al inicializar WebGL', error);
            if (dom.loadingText) dom.loadingText.textContent = 'Tu navegador no pudo iniciar WebGL.';
            return;
        }

        world.clock = new THREE.Clock();
        bindEvents();
        resetRenderingState();
        animate();
        connect();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
