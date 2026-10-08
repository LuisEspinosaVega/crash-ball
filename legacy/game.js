// game.js — Crash Ball Client (Three.js + TCP Socket)

// ─── Configuration ────────────────────────────────────────────────

const CONFIG = {
    serverUrl: 'ws://localhost:8080', // WebSocket URL for game state
    tickRate: 60, // Games per second
    arenaSize: 200,
    paddleSize: 10,
    ballSize: 5,
    colors: [
        '#00e5ff', // Cyan - Player 0
        '#ff4081', // Pink - Player 1
        '#7c4dff', // Purple - Player 2
        '#00c853', // Green - Player 3,
    ],
};

// ─── Three.js Setup ────────────────────────────────────────────────

let scene, camera, renderer, clock;
let arena, floor, wall, balls = [], paddles = [];
let gameState = {};
let lastState = null;

// ─── Initialize Scene ──────────────────────────────────────────────

function initThreeJS() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a1a);
    scene.fog = new THREE.FogExp2(0x0a0a1a, 0.005);

    // Camera
    camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(0, 100, 100);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 0.8);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(100, 100, 100);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Create arena
    createArena();
    createGrid();

    // Handle resize
    window.addEventListener('resize', onWindowResize);

    // Start game
    connectSocket();
    startGameLoop();
}

// ─── Create Arena ──────────────────────────────────────────────────

function createArena() {
    // Floor
    const floorGeo = new THREE.PlaneGeometry(200, 200);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a3a,
        roughness: 0.8,
        metalness: 0.2,
    });
    floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Arena border walls
    const wallGeo = new THREE.PlaneGeometry(200, 15);
    const wallMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a4a,
        roughness: 0.3,
        metalness: 0.5,
    });

    // Wall positions: 4 walls
    const wallPositions = [
        { x: 100, y: 0, rot: 0 },
        { x: -100, y: 0, rot: 0 },
        { x: 0, y: 100, rot: Math.PI / 2 },
        { x: 0, y: -100, rot: Math.PI / 2 },
    ];

    wallPositions.forEach(w => {
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(w.x, 7, w.y);
        wall.rotation.x = Math.PI / 2;
        wall.rotation.z = w.rot;
        wall.receiveShadow = true;
        scene.add(wall);
    });

    // Goal zones (glowing lines at the back)
    const goalGeo = new THREE.PlaneGeometry(30, 2);
    const goalMat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.3,
    });

    // Goal line for each side
    [-100, 100].forEach(x => {
        const goal = new THREE.Mesh(goalGeo, goalMat);
        goal.position.set(x, 0, -5);
        goal.rotation.x = Math.PI / 2;
        goal.rotation.z = x > 0 ? Math.PI / 4 : -Math.PI / 4;
        scene.add(goal);
    });
}

function createGrid() {
    const grid = new THREE.GridHelper(200, 20, 0x2a2a4a, 0x1a1a3a);
    grid.position.y = -0.01;
    scene.add(grid);
}

// ─── Create Paddles & Balls ────────────────────────────────────────

function createPaddle(playerIndex) {
    const color = CONFIG.colors[playerIndex % CONFIG.colors.length];

    const geo = new THREE.SphereGeometry(5, 16, 16);
    const mat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.5,
        roughness: 0.3,
        metalness: 0.7,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    scene.add(mesh);

    return { mesh, playerIndex, color };
}

function createBall(ballIndex) {
    const geo = new THREE.SphereGeometry(3, 12, 12);
    const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x00e5ff,
        emissiveIntensity: 0.8,
        roughness: 0.1,
        metalness: 0.9,
    });

    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    return { mesh, ballIndex, pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0) };
}

// ─── WebSocket Connection ───────────────────────────────────────────

function connectSocket() {
    // Create WebSocket connection
    socket = new WebSocket(CONFIG.serverUrl);

    socket.onopen = () => {
        console.log('Connected to server');
        document.getElementById('loading').style.display = 'none';
        document.getElementById('ui').style.display = 'block';
        updateUI();

        // Send JOIN message
        sendJoin();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch (err) {
            console.error('Message parse error:', err);
        }
    };

    socket.onerror = (err) => {
        console.error('Socket error:', err);
    };

    socket.onclose = () => {
        console.error('Disconnected from server');
        // Reconnect after 3 seconds
        setTimeout(connectSocket, 3000);
    };
}

function sendJoin() {
    const msg = {
        type: 'JOIN',
        data: {
            seat: 0,
            playerType: 0,
            name: 'Player 1'
        }
    };
    socket.send(JSON.stringify(msg));
}

function handleServerMessage(data) {
    gameState = data;

    // Update paddles
    updatePaddlePositions(data);

    // Update balls
    updateBallPositions(data);

    // Update UI
    updateUI();
}

// ─── Update Game Objects ───────────────────────────────────────────

function updatePaddlePositions(data) {
    if (!lastState) {
        lastState = data;
        return;
    }

    if (data.players) {
        data.players.forEach(player => {
            if (!paddles[player.index]) {
                paddles[player.index] = createPaddle(player.index);
            }

            const paddle = paddles[player.index];
            const delta = player.x - lastState.players[player.index].x;

            // Smooth movement
            paddle.mesh.position.set(
                player.x,
                player.y || 0,
                -5 // Fixed depth
            );

            if (player.eliminated) {
                paddle.mesh.material.opacity = 0.3;
                paddle.mesh.material.transparent = true;
            } else {
                paddle.mesh.material.opacity = 1;
                paddle.mesh.material.transparent = false;
            }
        });
    }

    lastState = data;
}

function updateBallPositions(data) {
    // Remove old balls
    for (const ball of balls) {
        scene.remove(ball.mesh);
    }
    balls = [];

    // Create/update balls
    if (data.balls) {
        data.balls.forEach((ball, i) => {
            if (i < balls.length) {
                // Update existing ball
                balls[i].mesh.position.set(
                    ball.pos.x,
                    ball.pos.y,
                    ball.pos.z
                );
                balls[i].vel = { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z };
            } else {
                // Create new ball
                const newBall = createBall(i);
                newBall.pos = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };
                newBall.vel = { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z };
                balls.push(newBall);
            }
        });
    }
}

// ─── UI Updates ────────────────────────────────────────────────────

function updateUI() {
    if (!gameState) return;

    // Player count
    document.getElementById('player-count').textContent = 
        `Jugadores: ${gameState.players ? gameState.players.length : 0}`;

    // Round info
    document.getElementById('round-info').textContent = 
        `Ronda: ${gameState.round?.roundNumber || 1} | Tiempo: ${formatTime(gameState.round?.gameTime || 0)}`;
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// ─── Controls ──────────────────────────────────────────────────────

const keys = {};
document.addEventListener('keydown', (e) => {
    keys[e.code] = true;

    // Send input to server
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        sendInput(-1);
    }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        sendInput(1);
    }
    if (e.code === 'Space' || e.code === 'Enter') {
        sendAttack();
    }
});

document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
});

function sendInput(value) {
    const msg = {
        type: 'INPUT',
        data: {
            player: 0, // Player index (local)
            move: value,
            timestamp: Date.now()
        }
    };
    socket.send(JSON.stringify(msg));
}

function sendAttack() {
    const msg = {
        type: 'ATTACK',
        data: {
            player: 0,
            timestamp: Date.now()
        }
    };
    socket.send(JSON.stringify(msg));
}

// ─── Game Loop ────────────────────────────────────────────────────

function startGameLoop() {
    clock = new THREE.Clock();
    animate();
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    // Update ball physics if we have local physics
    updateBallPhysics(delta);

    // Render
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
}

function updateBallPhysics(delta) {
    // Simple physics for ball movement between server updates
    balls.forEach(ball => {
        ball.mesh.position.add(ball.vel, delta * 0.1);
    });
}

// ─── Window Resize ────────────────────────────────────────────────

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Start ────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    initThreeJS();
});
