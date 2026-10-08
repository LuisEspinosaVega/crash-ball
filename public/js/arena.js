/* ============================================================================
 * arena.js — Escena 3D, HUD y entrada.
 * ----------------------------------------------------------------------------
 * El servidor es la ÚNICA autoridad sobre la partida: aquí no se simula física.
 * Solo se hace lo que corresponde a un cliente que llega a 60 Hz de red:
 *
 *   · Recibir instantáneas (STATE) y guardarlas en un buffer con marca de
 *     tiempo.
 *   · Dibujar con ~100 ms de retraso interpolando entre las dos instantáneas
 *     que rodean ese instante. Es lo que separa "juego fluido" de "pelota que
 *     da saltos" cuando la red se pone nerviosa: con retraso fijo siempre hay
 *     dos muestras y siempre se dibuja "el pasado reciente" en vez del último
 *     salto.
 *   · Traducir teclado y pantalla táctil en mensajes INPUT/DASH.
 * ==========================================================================*/

window.CB = window.CB || {};

CB.arena = (function () {
    'use strict';

    const { el, setText, show, setClass, setBarWidth, num, clamp, smoothing } = CB.dom;

    const CONFIG = {
        arenaHalf: 150,          // mundo de juego: x,y ∈ [-150, 150]
        hpMax: 15,
        paddleLength: 50,
        paddleThickness: 12,
        paddleHeight: 14,
        paddleBevel: 1.5,
        ballRadius: 8,

        // Deben coincidir con las constantes del servidor (game_state.h). Si
        // divergen, el predictor acumularía error hasta que la corrección lo
        // teletransporte de golpe.
        paddleSpeed: 420,      // PADDLE_SPEED
        posLimit: 124,         // ARENA_HALF - PADDLE_HALF_LEN

        // Retardo de interpolación. 100 ms es el punto dulce en una red de casa:
        // por debajo se ve el efecto de los saltos de red, por encima se nota
        // la latencia. Por VPN o túnel el RTT se dispara, así que el retardo se
        // mide en tiempo real (ver ping.js) y se queda en el mínimo: el
        // predictor local cubre lo que la red no da.
        interpolationDelayMs: 100,
        interpolationDelayMinMs: 45,
        interpolationDelayMaxMs: 160,
        // Suavizado extra al perseguir la muestra, por si el buffer se queda
        // corto (p. ej. tras una pausa larga de la pestaña).
        catchUpLerpRate: 18,
        paddleLerpRate: 24,
        ballLerpRate: 26,

        cameraBase: { y: 420, z: 420 },
        fov: 45,
        // Giro de cámara por asiento, en radianes. La idea: la pared del
        // jugador queda SIEMPRE abajo del encuadre, mirando de frente. Quien
        // defiende el muro derecho ve la arena girada 180°, no de través.
        seatColors: ['#00e5ff', '#ff4081', '#7c4dff', '#00c853'],
        // cameraYaw = giro de la cámara alrededor del centro, para que el muro
        // del jugador quede SIEMPRE en primer plano (abajo del encuadre).
        //
        // La cuenta: el juego va de (x,y) a (x, -y) en el mundo, así que la
        // cámara neutra (yaw 0) se sitúa en worldZ = +d, es decir, del lado del
        // muro "abajo" del juego. Al girarla, el muro más cercano a la cámara es
        // el que toca:
        //   yaw 0     → muro abajo    (seat 3)
        //   yaw π/2   → muro derecha  (seat 2)   cámara en worldX = +d
        //   yaw π     → muro arriba   (seat 1)
        //   yaw 3π/2  → muro izquierda (seat 0)  cámara en worldX = -d
        seats: [
            { wall: 'left', label: 'izquierda', slide: 'y', cameraYaw: Math.PI * 1.5,
              invertInput: true },
            { wall: 'top', label: 'arriba', slide: 'x', cameraYaw: Math.PI,
              invertInput: true },
            { wall: 'right', label: 'derecha', slide: 'y', cameraYaw: Math.PI * 0.5,
              invertInput: false },
            { wall: 'bottom', label: 'abajo', slide: 'x', cameraYaw: 0,
              invertInput: false }
        ]
    };

    // ─── Estado ────────────────────────────────────────────────────

    const world = {
        scene: null,
        camera: null,
        renderer: null,
        clock: null,
        ready: false,
        cameraYaw: 0     // giro actual; lo decide tu asiento
    };

    const entities = { paddles: [], balls: [] };

    const assets = {
        paddleGeometry: null,
        ballGeometry: null,
        ballMaterial: null,
        wallSlabGeometry: null,
        wallLineGeometry: null,
        wallMaterials: [],
        sceneExtras: []
    };

    const session = {
        mySeat: -1,
        myName: '',
        roomCode: '',
        phase: 'lobby'
    };

    // Buffer de instantáneas: { at, state }. Se recorta solo.
    const buffer = { frames: [], maxFrames: 40 };

    const latest = {
        round: null,
        players: [],
        balls: []
    };

    let lastFrameAt = 0;
    let dashReadyAt = 0;         // estimación local, nunca bloquea el envío
    let lastDashLabel = '';
    let lastSentMove = null;
    let connected = false;
    let paused = false;
    let onPauseShown = null;

    const pressed = Object.create(null);
    const touchState = { left: false, right: false };
    const DIRECTION_BY_CODE = {
        ArrowLeft: 'left',
        KeyA: 'left',
        ArrowRight: 'right',
        KeyD: 'right'
    };

    // ─── Escena ────────────────────────────────────────────────────

    function initScene() {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a1a);
        scene.fog = new THREE.FogExp2(0x0a0a1a, 0.0009);

        const camera = new THREE.PerspectiveCamera(
            CONFIG.fov,
            window.innerWidth / Math.max(1, window.innerHeight),
            1,
            2000
        );

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        const host = el('stage') || document.body;
        host.appendChild(renderer.domElement);

        world.scene = scene;
        world.camera = camera;
        world.renderer = renderer;
        world.clock = new THREE.Clock();

        scene.add(new THREE.AmbientLight(0x4a5578, 0.9));
        const sun = new THREE.DirectionalLight(0xffffff, 0.85);
        sun.position.set(160, 320, 200);
        scene.add(sun);

        buildArena(scene);
        createPaddleEntities();
        onWindowResize();
        world.ready = true;
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
            { seat: 0, x: -153, z: 0, rotationY: Math.PI / 2 },   // izquierda
            { seat: 1, x: 0, z: -153, rotationY: 0 },            // arriba (y=+150)
            { seat: 2, x: 153, z: 0, rotationY: -Math.PI / 2 },   // derecha
            { seat: 3, x: 0, z: 153, rotationY: Math.PI }         // abajo (y=-150)
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

    /**
     * Coloca la cámara para el asiento del jugador: siempre de frente a su muro,
     * con su pala abajo y la arena abriéndose hacia arriba.
     *
     * Sin esto la cámara es fija y quien defiende el muro izquierdo juega con la
     * pala a un lado y la pelota entrando de perfil, que es jugablemente mal.
     * Girar el escenario entero en vez de mover la cámara deja intactos el HUD,
     * las coordenadas del servidor y el mapeo de entrada: solo cambia desde
     * dónde se mira.
     */
    function applyCameraForSeat(seat) {
        const rotation = seat >= 0 && seat < CONFIG.seats.length
            ? CONFIG.seats[seat].cameraYaw
            : 0;
        if (world.cameraYaw === rotation) return;
        world.cameraYaw = rotation;
        onWindowResize();
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

        // La cámara se coloca en el radio del yaw alrededor del centro de la
        // arena. Ojo: hay que girar el VECTOR de posición a mano. Usar
        // camera.rotateY() solo orienta la cámara, no la mueve, y por eso el
        // muro quedaba de lado en lugar de enfrente.
        const distance = CONFIG.cameraBase.y * pullBack;
        const yaw = world.cameraYaw;
        world.camera.position.set(
            distance * Math.sin(yaw),
            distance,
            distance * Math.cos(yaw)
        );
        world.camera.up.set(0, 1, 0);
        world.camera.lookAt(0, 0, 0);
        world.camera.updateProjectionMatrix();
        world.renderer.setSize(width, height);
    }

    // ─── Entidades ─────────────────────────────────────────────────

    /**
     * Rectángulo redondeado (un estadio, porque el radio es media altura) en el
     * plano XY. Arcos reales en vez de curvas cuadráticas para que el contorno
     * coincida exactamente con el tamaño nominal.
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
            // Asientos 0 y 2 patinan por el eje y del juego (= eje Z del mundo).
            mesh.rotation.y = CONFIG.seats[seat].slide === 'y' ? Math.PI / 2 : 0;
            mesh.visible = false;
            world.scene.add(mesh);

            entities.paddles.push({
                mesh: mesh,
                material: material,
                opacityTarget: 0,
                glowTarget: 0.5,
                snap: true
            });
        }
    }

    function createBallEntity() {
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
        const mesh = new THREE.Mesh(assets.ballGeometry, assets.ballMaterial);
        mesh.visible = false;
        world.scene.add(mesh);
        return { mesh: mesh, active: false, snap: true };
    }

    /** Juego (x, y) -> mundo Three.js: worldX = x, worldZ = -y, +Y arriba. */
    function toWorld(x, y, height, mesh) {
        mesh.position.set(x, height, -y);
    }

    // ─── Recepción de estado ───────────────────────────────────────

    function applyState(state) {
        latest.round = state.round && typeof state.round === 'object' ? state.round : null;
        latest.players = Array.isArray(state.players) ? state.players : [];
        latest.balls = Array.isArray(state.balls) ? state.balls : [];

        if (latest.round && latest.round.phase) session.phase = latest.round.phase;
        if (typeof state.room === 'string') session.roomCode = state.room;

        // Copia profunda de lo que se va a dibujar más tarde: el objeto del
        // mensaje se recicla al siguiente STATE.
        buffer.frames.push({
            at: performance.now(),
            players: latest.players.map(function (p) {
                return { x: num(p.x), y: num(p.y), alive: p.alive, hp: num(p.hp), dashing: p.dashing };
            }),
            balls: latest.balls.map(function (b) { return { x: num(b.x), y: num(b.y) }; })
        });
        if (buffer.frames.length > buffer.maxFrames) buffer.frames.shift();
        lastFrameAt = buffer.frames[buffer.frames.length - 1].at;

        updateHud();
        updateHealthBars();
        updateCountdown();
        updateMatchOverlay();
    }

    function findPlayer(seat) {
        for (let i = 0; i < latest.players.length; i++) {
            const player = latest.players[i];
            if (player && num(player.seat) === seat) return player;
        }
        return null;
    }

    function playerLabel(player) {
        const base = (player && typeof player.name === 'string' && player.name)
            ? player.name
            : 'Jugador ' + (num(player && player.seat) + 1);
        return player && player.bot ? base + ' · BOT' : base;
    }

    function winnerLabel(winner) {
        if (typeof winner !== 'number' || winner < 0) return null;
        const player = findPlayer(winner);
        return player ? playerLabel(player) : 'Jugador ' + (winner + 1);
    }

    // ─── Interpolación ─────────────────────────────────────────────

    /**
     * Predicción de la pala propia.
     *
     * La pala del jugador no se dibuja como llega del servidor: se avanza aquí
     * con la misma velocidad y el mismo tope que usa el motor, y luego se
     * corrige gently hacia lo que confirme el servidor. Es lo que quita la
     * sensación de "lag" al mover, porque la respuesta a la tecla es inmediata
     * en vez de esperar un viaje de ida y vuelta.
     *
     * El servidor sigue siendo la autoridad: esto solo Adelanta lo que él ya
     * va a decir. Si la corrección se pasa de un umbral (por ejemplo,We've been
     * interrupted — the server rejected our input), se teletransporta.
     */
    const prediction = {
        valid: false,
        x: 0,
        y: 0,
        // Correcciones suaves por debajo de este error; por encima, salto.
        snapThreshold: 60,
        // Proporción de error que se corrige en cada cuadro, para que el
        // desfase con el servidor no se note de golpe.
        correctRate: 0.12
    };

    /** Corrección hacia la posición que el servidor acaba de confirmar. */
    function reconcile(seat, targetX, targetY) {
        if (seat !== session.mySeat) return;

        if (!prediction.valid) {
            prediction.x = targetX;
            prediction.y = targetY;
            prediction.valid = true;
            return;
        }

        const dx = targetX - prediction.x;
        const dy = targetY - prediction.y;
        if (Math.abs(dx) > prediction.snapThreshold ||
            Math.abs(dy) > prediction.snapThreshold) {
            prediction.x = targetX;
            prediction.y = targetY;
            return;
        }
        prediction.x += dx * prediction.correctRate;
        prediction.y += dy * prediction.correctRate;
    }

    /**
     * Avanza la predicción un cuadro. Usa los mismos números que el servidor
     * (PADDLE_SPEED, POS_LIMIT) para que no se desvíe por el camino.
     */
    function stepPrediction(dt) {
        if (!prediction.valid || session.mySeat < 0) return;

        const move = lastSentMove;
        if (!move) return;

        const seat = CONFIG.seats[session.mySeat];
        if (!seat) return;

        const step = move * CONFIG.paddleSpeed * dt;
        if (seat.slide === 'x') {
            prediction.x = clamp(prediction.x + step, -CONFIG.posLimit, CONFIG.posLimit);
        } else {
            // El eje y del juego es el -Z del mundo; aquí se razona en y de
            // juego, que es lo que manda el servidor.
            prediction.y = clamp(prediction.y + step, -CONFIG.posLimit, CONFIG.posLimit);
        }
    }

    /**
     * Retardo de dibujo en uso, ajustado a la red real.
     *
     * El retardo tiene que tapar la irregularidad de la red, no la latencia: en
     * una VPN o un túnel (100 ms de ida y vuelta o más) pagar 100 ms de retardo
     * encima de 100 ms de red deja el control blandísimo. Por eso se mide el
     * ping: con red buena se queda en el valor cómodo y con red mala baja al
     * mínimo, porque el predictor local ya evita que la pala se quede quieta.
     */
    function currentDelay() {
        const rtt = CB.net.state.pingMs || 0;
        // Solo cuenta la mitad del RTT: el retardo existe para no dibujar el
        // futuro, no para compensar el viaje de los datos que ya llegaron.
        const wanted = rtt > 0 ? rtt * 0.5 : CONFIG.interpolationDelayMs;
        return clamp(wanted, CONFIG.interpolationDelayMinMs,
                     CONFIG.interpolationDelayMaxMs);
    }

    /**
     * Dibuja el instante `now - delay` interpolando entre las dos instantáneas
     * que lo rodean. Si no hay dos muestras (reconexión, primer frame) cae al
     * último estado conocido y suaviza hacia él.
     */
    function interpolate(dt) {
        if (buffer.frames.length === 0) return;

        const renderAt = performance.now() - currentDelay();
        let older = null;
        let newer = null;

        for (let i = buffer.frames.length - 1; i >= 0; i--) {
            if (buffer.frames[i].at <= renderAt) {
                older = buffer.frames[i];
                newer = buffer.frames[i + 1] || null;
                break;
            }
        }
        if (!older) {
            older = buffer.frames[0];
            newer = buffer.frames[1] || null;
        }
        if (!newer) {
            // Buffer congelado (pestaña en segundo plano, red parada): se dibuja
            // la última muestra y se deja que las entidades la persigan.
            drawFrame(older, null, 0, dt);
            return;
        }

        const span = newer.at - older.at;
        const t = span > 0 ? clamp((renderAt - older.at) / span, 0, 1) : 1;
        drawFrame(older, newer, t, dt);
    }

    function drawFrame(older, newer, t, dt) {
        const paddleFactor = smoothing(CONFIG.paddleLerpRate, dt);

        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            const a = older.players[seat];
            const b = newer ? newer.players[seat] : a;
            if (!a) {
                entity.mesh.visible = false;
                continue;
            }

            let x = b ? a.x + (b.x - a.x) * t : a.x;
            let y = b ? a.y + (b.y - a.y) * t : a.y;

            const alive = a.alive !== false && a.hp > 0;

            // La pala propia no se dibuja donde llega, sino dondeseatribuye el
            // predictor; así responde al instante. El resto van interpoladas.
            if (seat === session.mySeat) {
                reconcile(seat, x, y);
                stepPrediction(dt);
                if (prediction.valid) {
                    x = prediction.x;
                    y = prediction.y;
                }
            }
            entity.opacityTarget = alive ? 1 : 0.18;
            entity.glowTarget = !alive ? 0.05 : (a.dashing ? 1.5 : 0.5);

            if (!entity.mesh.visible) {
                entity.mesh.visible = true;
                entity.snap = true;
            }

            if (entity.snap) {
                entity.mesh.position.set(x, CONFIG.paddleHeight / 2, -y);
                entity.material.opacity = entity.opacityTarget;
                entity.snap = false;
            } else {
                entity.mesh.position.lerp(
                    new THREE.Vector3(x, CONFIG.paddleHeight / 2, -y),
                    newer ? 1 : paddleFactor
                );
                entity.material.opacity += (entity.opacityTarget - entity.material.opacity) * paddleFactor;
            }
            entity.material.emissiveIntensity +=
                (entity.glowTarget - entity.material.emissiveIntensity) * paddleFactor;
        }

        const ballCount = Math.max(older.balls.length, newer ? newer.balls.length : 0);
        while (entities.balls.length < ballCount) entities.balls.push(createBallEntity());

        const ballFactor = smoothing(CONFIG.ballLerpRate, dt);
        for (let i = 0; i < entities.balls.length; i++) {
            const entity = entities.balls[i];
            const a = older.balls[i];
            const b = newer ? newer.balls[i] : a;

            if (!a && !b) {
                entity.active = false;
                entity.mesh.visible = false;
                continue;
            }

            const src = a || b;
            const other = b || a;
            const x = b && a ? a.x + (b.x - a.x) * t : src.x;
            const y = b && a ? a.y + (b.y - a.y) * t : src.y;

            if (!entity.active) {
                entity.active = true;
                entity.snap = true;
            }
            entity.mesh.visible = true;

            const target = new THREE.Vector3(x, CONFIG.ballRadius, -y);
            if (entity.snap) {
                entity.mesh.position.copy(target);
                entity.snap = false;
            } else {
                entity.mesh.position.lerp(target, newer ? 1 : ballFactor);
            }
        }
    }

    // ─── HUD ───────────────────────────────────────────────────────

    function updateHud() {
        const round = latest.round;
        const roundNumber = round ? Math.max(1, Math.round(num(round.roundNumber))) : 1;

        setText(el('round-number'), round ? 'Ronda ' + roundNumber : 'Ronda —');
        setText(el('round-time'), CB.dom.formatTime(round ? round.gameTime : 0));
        setText(el('round-goal'), round && num(round.roundsToWin) > 0
            ? 'Primero a ' + Math.round(num(round.roundsToWin))
            : '');
        updateSeatLabel();
        setText(el('room-chip'), session.roomCode ? 'Sala ' + session.roomCode : 'Partida rápida');
    }

    function updateSeatLabel() {
        const label = el('seat-label');
        if (session.mySeat < 0 || session.mySeat >= CONFIG.seats.length) {
            setText(label, 'Tú: spectator');
            setClass(label, 'is-spectator', session.phase !== 'lobby');
            return;
        }
        setClass(label, 'is-spectator', false);
        const player = findPlayer(session.mySeat);
        const name = player ? playerLabel(player) : session.myName;
        setText(label, 'Tú: ' + name + ' · muro ' + CONFIG.seats[session.mySeat].label);
    }

    function updateHealthBars() {
        for (let seat = 0; seat < CONFIG.seats.length; seat++) {
            const row = healthRow(seat);
            if (!row) continue;
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
            const isLocal = seat === session.mySeat;

            setText(row.name, playerLabel(player) + (isLocal ? ' (tú)' : ''));
            setText(row.hp, hp + '/' + CONFIG.hpMax);
            setBarWidth(row.fill, (hp / CONFIG.hpMax) * 100);
            setClass(row.row, 'is-empty', false);
            setClass(row.row, 'is-dead', !alive);
            setClass(row.row, 'is-local', isLocal);
        }
    }

    function healthRow(seat) {
        if (!healthRow.cache) healthRow.cache = [];
        if (!healthRow.cache[seat]) {
            const row = el('hb-' + seat);
            // El color del asiento vive en una variable CSS: una sola fuente
            // de verdad para la fila de vida y para el resto de la interfaz.
            if (row) row.style.setProperty('--seat', CONFIG.seatColors[seat]);
            healthRow.cache[seat] = {
                row: row,
                name: el('hb-' + seat + '-name'),
                fill: el('hb-' + seat + '-fill'),
                hp: el('hb-' + seat + '-hp')
            };
        }
        return healthRow.cache[seat];
    }

    /**
     * `countdown` viene en segundos. Solo se muestra dentro de un rango
     * razonable: fuera de eso es ruido, no información.
     */
    function updateCountdown() {
        const round = latest.round;
        const raw = round ? num(round.countdown) : 0;
        if (raw <= 0) {
            show(el('countdown'), false);
            return;
        }
        const seconds = Math.ceil(raw);
        if (seconds <= 0 || seconds > 10) {
            show(el('countdown'), false);
            return;
        }
        setText(el('countdown'), String(seconds));
        show(el('countdown'), true);
    }

    function updateMatchOverlay() {
        const round = latest.round;
        const matchOver = !!(round && round.matchOver);

        if (matchOver) {
            const label = winnerLabel(typeof round.winner === 'number' ? round.winner : -1);
            setText(el('overlay-match-title'), label ? '¡' + label + ' gana!' : '¡Empate!');
            setText(el('overlay-match-text'),
                'Pulsa R o el botón para la revancha.');
            // Relanzar decide el anfitrión de la sala; en partida rápida cualquiera
            // puede hacerlo, que es como funcionaba antes de las salas.
            const canRestart = CB.menu.room.quick || CB.menu.room.isHost;
            show(el('btn-restart'), canRestart);
            show(el('overlay-match'), true);
            return;
        }
        show(el('overlay-match'), false);
    }

    /** Indicador de dash puramente local: no condiciona el envío al servidor. */
    function updateDashIndicator() {
        const indicator = el('dash-indicator');
        const now = performance.now();
        const progress = dashReadyAt === 0 ? 1 : clamp((now - dashReadyAt) / 1500, 0, 1);

        setBarWidth(el('dash-fill'), progress * 100);
        setClass(indicator, 'is-ready', progress >= 1);

        const label = progress >= 1 ? 'DASH LISTO' : 'DASH ' + ((1500 * (1 - progress)) / 1000).toFixed(1) + 's';
        if (label !== lastDashLabel) {
            lastDashLabel = label;
            setText(el('dash-label'), label);
        }
    }

    // ─── Entrada ───────────────────────────────────────────────────

    /**
     * Dirección que se envía al servidor, ya en coordenadas del juego.
     *
     * Al girar la cámara para dejar el muro del jugador delante, la pantalla se
     * invierte en unos asientos: ahí "pulsar derecha" equivale a mover el muro
     * en sentido negativo. `invertInput` de cada asiento lo corrige, para que
     * la tecla que pulsas mueva siempre la pala hacia donde ves.
     */
    function currentMove() {
        const left = pressed.ArrowLeft || pressed.KeyA || touchState.left;
        const right = pressed.ArrowRight || pressed.KeyD || touchState.right;
        const screenMove = (right ? 1 : 0) - (left ? 1 : 0);

        const seat = session.mySeat;
        const invert = seat >= 0 && seat < CONFIG.seats.length
            && CONFIG.seats[seat].invertInput;
        return invert ? -screenMove : screenMove;
    }

    /** Envía INPUT solo cuando la dirección mantenida cambia (no por frame). */
    function sendMoveIfChanged(force) {
        const move = currentMove();
        if (!force && move === lastSentMove) return;
        lastSentMove = move;
        CB.net.send({ type: 'INPUT', move: move });
    }

    function sendDash() {
        if (session.mySeat < 0) return;
        if (CB.net.send({ type: 'DASH' })) dashReadyAt = performance.now();
    }

    function sendRestart() {
        CB.net.send({ type: 'RESTART' });
    }

    function onKeyDown(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Con el chat abierto, las teclas son para el chat.
        if (document.activeElement && document.activeElement.tagName === 'INPUT') {
            if (event.code === 'Escape') document.activeElement.blur();
            return;
        }

        const onButton = !!(event.target && event.target.tagName === 'BUTTON');

        if (event.code === 'Space' || event.code === 'Enter') {
            if (onButton) return;
            event.preventDefault();
            if (!event.repeat) sendDash();
            return;
        }

        if (event.code === 'KeyR') {
            event.preventDefault();
            if (latest.round && latest.round.matchOver) sendRestart();
            return;
        }

        if (DIRECTION_BY_CODE[event.code]) {
            event.preventDefault();
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
        touchState.left = false;
        touchState.right = false;
        sendMoveIfChanged(true);
    }

    function bindTouch() {
        const touchCapable = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
        show(el('touch-controls'), touchCapable && session.mySeat >= 0);
        if (!touchCapable) return;

        const hold = function (id, key) {
            const node = el(id);
            if (!node) return;
            const down = function (event) {
                event.preventDefault();
                touchState[key] = true;
                sendMoveIfChanged(false);
            };
            const up = function (event) {
                event.preventDefault();
                touchState[key] = false;
                sendMoveIfChanged(false);
            };
            node.addEventListener('touchstart', down, { passive: false });
            node.addEventListener('touchend', up, { passive: false });
            node.addEventListener('touchcancel', up, { passive: false });
            node.addEventListener('mousedown', down);
            node.addEventListener('mouseup', up);
            node.addEventListener('mouseleave', up);
        };
        hold('touch-left', 'left');
        hold('touch-right', 'right');

        const dash = el('touch-dash');
        if (dash) {
            dash.addEventListener('touchstart', function (e) {
                e.preventDefault();
                sendDash();
            }, { passive: false });
            dash.addEventListener('mousedown', function (e) {
                e.preventDefault();
                sendDash();
            });
        }
    }

    // ─── Ciclo de vida ─────────────────────────────────────────────

    /** Vuelve a un estado limpio (arranque, reconexión, cambio de sala). */
    function resetState() {
        buffer.frames.length = 0;
        lastFrameAt = 0;
        latest.round = null;
        latest.players = [];
        latest.balls = [];
        session.mySeat = -1;
        // Sin muro no hay desde dónde mirar: la cámara vuelve a su sitio, que si
        // no el menú y el vestíbulo saldrían torcidos de la última partida.
        applyCameraForSeat(-1);
        lastSentMove = null;
        dashReadyAt = 0;
        lastDashLabel = '';

        for (let seat = 0; seat < entities.paddles.length; seat++) {
            const entity = entities.paddles[seat];
            entity.mesh.visible = false;
            entity.mesh.position.set(0, CONFIG.paddleHeight / 2, 0);
            entity.material.opacity = 0;
            entity.opacityTarget = 0;
            entity.snap = true;
        }
        for (let i = 0; i < entities.balls.length; i++) {
            entities.balls[i].active = false;
            entities.balls[i].snap = true;
            entities.balls[i].mesh.visible = false;
        }

        setText(el('round-number'), 'Ronda —');
        setText(el('round-time'), '00:00');
        setText(el('round-goal'), '');
        setText(el('seat-label'), 'Tú: —');
        setText(el('room-chip'), 'Sala —');
        show(el('countdown'), false);
        show(el('overlay-match'), false);
        updateHealthBars();
    }

    function setSeat(seat, name) {
        session.mySeat = typeof seat === 'number' ? seat : -1;
        session.myName = name || session.myName;
        applyCameraForSeat(session.mySeat);
        bindTouch();
        updateSeatLabel();
        // El predictor arranca desde la posición real del servidor: si no, la
        // pala daría un salto al sentarte.
        prediction.valid = false;
    }

    function setConnected(value) {
        connected = value;
        if (value) {
            // Al volver la conexión hay que reanunciar la tecla que siga pulsada:
            // el servidor se quedó con el último INPUT recibido.
            lastSentMove = null;
            sendMoveIfChanged(true);
        } else {
            setClass(el('room-chip'), 'is-bad', true);
        }
    }

    function setPaused(value) {
        paused = value;
        show(el('overlay-pause'), value);
        if (value) {
            releaseAllKeys();
            // Quien abra la pausa (tecla Esc, botón, cualquier vía) tiene que
            // refrescar el panel; si no, el menú puede ofrecer acciones que no
            // te corresponden.
            if (onPauseShown) onPauseShown();
        }
    }

    /** main.js lo usa para rellenar el panel de pausa con lo que puede hacer. */
    function setPauseHook(hook) {
        onPauseShown = hook;
    }

    function isPaused() { return paused; }
    function isConnected() { return connected; }

    function animate() {
        window.requestAnimationFrame(animate);
        if (!world.ready) return;

        // dt acotado: tras cambiar de pestaña el primer delta puede ser enorme.
        const dt = Math.min(world.clock.getDelta(), 0.1);
        interpolate(dt);
        updateDashIndicator();
        world.renderer.render(world.scene, world.camera);
    }

    /** Libera geometrías, materiales y contexto WebGL. */
    function teardown() {
        const disposePart = function (part) {
            if (!part || !world.scene) return;
            world.scene.remove(part.object);
            for (let i = 0; i < part.geometries.length; i++) part.geometries[i].dispose();
            for (let i = 0; i < part.materials.length; i++) part.materials[i].dispose();
        };

        if (!world.scene) return;

        for (let i = 0; i < assets.sceneExtras.length; i++) disposePart(assets.sceneExtras[i]);
        assets.sceneExtras.length = 0;

        for (let seat = 0; seat < entities.paddles.length; seat++) {
            world.scene.remove(entities.paddles[seat].mesh);
            entities.paddles[seat].material.dispose();
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

        if (world.renderer) {
            world.renderer.dispose();
            const canvas = world.renderer.domElement;
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }
        world.ready = false;
    }

    /**
     * Dónde cae en pantalla la pala de un asiento, en píxeles. Solo para
     * pruebas: comprueba que la cámara deja el muro de cada jugador abajo del
     * encuadre, en vez de de lado.
     */
    function paddleScreenPosition(seat) {
        const entity = entities.paddles[seat];
        if (!entity || !entity.mesh.visible || !world.camera) return null;
        const projected = entity.mesh.position.clone().project(world.camera);
        return {
            x: Math.round((projected.x * 0.5 + 0.5) * window.innerWidth),
            y: Math.round((-projected.y * 0.5 + 0.5) * window.innerHeight)
        };
    }

    function bind() {
        window.addEventListener('resize', onWindowResize);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', releaseAllKeys);
        window.addEventListener('pagehide', teardown);
    }

    return {
        CONFIG: CONFIG,
        session: session,
        initScene: initScene,
        bind: bind,
        applyState: applyState,
        setSeat: setSeat,
        setConnected: setConnected,
        setPaused: setPaused,
        setPauseHook: setPauseHook,
        isPaused: isPaused,
        isConnected: isConnected,
        resetState: resetState,
        sendRestart: sendRestart,
        releaseAllKeys: releaseAllKeys,
        animate: animate,
        teardown: teardown,
        updateSeatLabel: updateSeatLabel,
        refreshTouchControls: bindTouch,
        paddleScreenPosition: paddleScreenPosition
    };
})();