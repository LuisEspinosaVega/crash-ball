# 🎮 Crash Ball Arena

Juego arcade multijugador: una arena cuadrada donde **cada jugador defiende un
muro**. Mueve tu pala para interceptar la pelota; si pasa, pierdes un punto de
vida. El último en pie gana la ronda, y el primero en ganar 3 rondas gana la
partida.

Un solo ejecutable sirve el cliente web **y** hospeda la partida, así que no
hace falta instalar nada más.

![Crash Ball Arena en marcha](docs/screenshot.png)

---

## Arranque rápido

```bash
cmake -S . -B build
cmake --build build --config Release
./build/Release/server.exe        # Windows
./build/server                    # Linux / macOS
```

Abre **<http://localhost:8080/>** y juega. Los asientos libres los ocupan bots,
así que puedes jugar solo desde el primer segundo.

```bash
./build/Release/server.exe 9000 expert    # otro puerto, bots más duros
```

En Windows también hay un script que hace configurar + compilar + arrancar de
una vez, usando únicamente CMake:

```bat
Server\build.bat              REM puerto 8080, dificultad hard
Server\build.bat 9000 expert  REM puerto y dificultad
```

| Argumento | Por defecto | Descripción |
|-----------|-------------|-------------|
| `puerto` | `8080` | Puerto HTTP + WebSocket |
| `dificultad` | `hard` | `easy` \| `medium` \| `hard` \| `expert` |
| `rondas` | `3` | Rondas para ganar la partida (1–9) |

### Atajos con GNU Make (opcional)

El `Makefile` es **solo un envoltorio cómodo** sobre los comandos de CMake de
arriba, para no escribirlos cada vez. No es necesario para compilar ni jugar.

Ojo: **`make` no es `cmake`**. `cmake` es el generador del sistema de
compilación y en Windows produce un proyecto de Visual Studio que se compila
con MSBuild; `make` es otra herramienta distinta. El `Makefile` necesita **GNU
Make** instalado (`make` o `gmake`), que no viene ni con Windows ni con Visual
Studio. Si no lo tienes, usa `cmake --build` o `build.bat`.

```bash
make build     # configura y compila
make run       # compila y arranca
make test      # compila y ejecuta el test de protocolo
make help      # todas las opciones
```

---

## Controles

| Tecla | Acción |
|-------|--------|
| `←` `→` o `A` `D` | Deslizar la pala por tu muro |
| `Espacio` o `Enter` | **Dash** — pala más larga y golpe 3× más fuerte |
| `R` | Reiniciar la partida (cuando ya terminó) |

Las flechas mueven la pala **a lo largo de tu muro**, que es distinto para cada
asiento. El HUD te dice cuál es el tuyo.

---

## Cómo se juega

- **Arena** de 300×300 unidades con un muro por asiento. Al empezar hay una
  pelota; cada 18 s aparece otra hasta un máximo de 4.
- **Salvar la pelota**: si tu pala está delante, la desvías. El ángulo de salida
  depende de dónde la golpees (centro = recto, bordes = angulado) y la pelota se
  acelera un 5 % por golpe, hasta 1500 u/s.
- **Conceder**: si la pelota toca tu muro fuera de la pala, pierdes 1 de 15
  puntos de vida y la pelota vuelve al centro a velocidad base.
- **Dash**: 0,25 s de pala extendida (×1,7) y multiplicador de golpe ×3, con
  0,45 s de recarga.
- **Eliminación**: a 0 de vida quedas fuera de la ronda.
- **Rondas**: gana el último con vida. Primero en 3 rondas gana la partida.

### Asientos y muros

| Asiento | Muro | Eje de deslizamiento | Color |
|---------|------|----------------------|-------|
| 0 | izquierda | y | `#00e5ff` cian |
| 1 | arriba | x | `#ff4081` rosa |
| 2 | derecha | y | `#7c4dff` morado |
| 3 | abajo | x | `#00c853` verde |

Pueden entrar hasta **4 humanos**; a partir de ahí el servidor rechaza la
conexión con un `REJECT` explicando el motivo. Cuando alguien se va, su muro
vuelve a manos de un bot para que nadie quede sin defensa.

---

## Arquitectura

```
Navegador                          Servidor (C++17, un solo proceso)
┌───────────────────────┐          ┌──────────────────────────────────────┐
│ Three.js (vendorizado)│          │ accept loop (hilo principal)         │
│ render + interpolación│◄───┐     │   ├─ HTTP  → public/  (keep-alive)   │
│ HUD, overlays, input  │    │     │   └─ WebSocket → JOIN/INPUT/DASH     │
└───────────────────────┘    │     │                                      │
                             │     │ 1 hilo por conexión                  │
        HTTP + WebSocket     └─────┤                                      │
        mismo puerto               │ 1 hilo de juego @ ≈60 Hz             │
                                   │   GameEngine.update() → broadcast    │
                                   └──────────────────────────────────────┘
```

**El servidor es la única autoridad.** El cliente no simula física: solo
interpola hacia las posiciones que recibe, así que no puede desincronizarse.

### Ficheros

```
space-ball/
├── Server/
│   ├── server.cpp        # red, protocolo, bucle de juego, arranque
│   ├── game_state.h/.cpp # simulación de la arena (autoritativa)
│   ├── websocket.h       # WebSocket RFC 6455 + primitivas de socket
│   ├── json.h            # lector JSON mínimo
│   ├── http_files.h      # servidor de ficheros estáticos
│   ├── build.bat         # script de compilación para Windows
│   ├── ai.h/.cpp         # [sin usar] no está en la build
│   └── network.h         # [sin usar] no está en la build
├── public/
│   ├── index.html        # estructura del HUD y overlays
│   ├── game.js           # escena, red, render, entrada
│   ├── styles.css        # estética neón
│   ├── favicon.png
│   └── vendor/three.min.js  # Three.js r128 local (sin CDN)
├── tools/
│   ├── smoke-test.mjs    # test de protocolo extremo a extremo
│   └── browser-test.mjs  # test en Chrome headless real
├── legacy/               # copia del árbol original, antes de las correcciones
├── CMakeLists.txt
└── Makefile              # atajos opcionales (requiere GNU Make, no CMake)
```

`Server/ai.h`, `Server/ai.cpp` y `Server/network.h` están **fuera de la build**:
implementaban un protocolo binario y una clase `BotBrain` que nada usaba. Se
conservan con un aviso en la cabecera y se pueden borrar.

---

## Protocolo

WebSocket en el mismo puerto que el HTTP. Todos los mensajes son JSON en texto.

**Cliente → servidor**

```json
{"type":"JOIN","name":"Jugador"}
{"type":"INPUT","move":-1}     // -1 | 0 | 1 — estado mantenido, no un pulso
{"type":"DASH"}
{"type":"RESTART"}
```

**Servidor → cliente**

```json
{"type":"WELCOME","seat":0,"name":"Jugador 1","maxPlayers":4,
 "wall":"left","roundsToWin":3,"startHealth":15}
```

```json
{"type":"STATE",
 "round":{"roundNumber":1,"gameTime":12345,"roundOver":false,"matchOver":false,
          "winner":-1,"matchWinner":-1,"countdown":0,"roundsToWin":3,
          "startHealth":15},
 "players":[
   {"seat":0,"name":"Jugador 1","bot":false,"present":true,"alive":true,
    "hp":15,"roundsWon":0,"x":-144.0,"y":-30.0,"vx":0,"vy":0,
    "wall":"left","dashing":false}
 ],
 "balls":[{"x":0.0,"y":0.0,"vx":120.0,"vy":-80.0}]}
```

Se emite un `STATE` por tick (≈60/s). Coordenadas de juego: `x` e `y` en
`[-150, 150]`. El centro de cada pala y el muro que defiende vienen ya
calculados por el servidor.

Unidades: `round.gameTime` va en **milisegundos**; `round.countdown` va en
**segundos**. `round.gameTime` es el tiempo de la ronda en curso, mientras que
`countdown` es lo que queda de la pantalla de resultado antes de la siguiente
ronda.

Cuando la partida queda decidida (`matchOver: true`), el motor se detiene y
espera un `RESTART`; entonces reinicia los marcadores y empieza una partida
nueva. Mientras no llegue ese mensaje el estado permanece congelado.

---

## Verificación

Dos suites, ambas sin dependencias npm (`node:test` no hace falta: usan el
`WebSocket` integrado de Node 22+).

```bash
# Protocolo: HTTP, handshake, JSON, entrada, multijugador, tope de 4 humanos,
# ciclo de ronda/partida y RESTART.
node tools/smoke-test.mjs 8080

# Navegador real: excepciones, errores de consola, canvas, HUD en vivo, teclado
node tools/browser-test.mjs http://127.0.0.1:8080/
```

`browser-test.mjs` lanza Chrome headless por el protocolo DevTools
(`CHROME_PATH` para indicar otro binario) y guarda una captura para revisarla a
ojo.

Estado actual, medido sobre esta build (MSVC, Windows, `hard`, 3 rondas):

| Suite | Resultado |
|-------|-----------|
| `smoke-test.mjs` | **50/50** |
| `browser-test.mjs` | **14/14** |

`smoke-test.mjs --quick` se salta la fase de ciclo de ronda, que es la lenta
(puede tardar un par de minutos porque las rondas son defensivas). Para
ejercitar el final de partida y el `RESTART` en pocos segundos, arranca el
servidor con una sola ronda ganadora y bots fáciles:

```bash
./build/Release/server.exe 8083 easy 1
node tools/smoke-test.mjs 8083
```

---

## Requisitos

- **Compilar**: CMake 3.14+ y un compilador C++17 (MSVC, g++ o clang++). En
  Windows solo hace falta Winsock, que viene con el sistema. **No hace falta
  `make`**: en Windows CMake genera un proyecto de Visual Studio y lo compila
  con MSBuild.
- **Jugar**: un navegador con WebGL. Three.js va vendorizado; no se descarga
  nada de internet.
- **Tests**: Node.js 22+ (por el `WebSocket` global).
- **Opcional**: GNU Make, solo si quieres los atajos del `Makefile`.

---

## Notas de implementación

- **WebSocket real (RFC 6455)**: handshake con SHA-1 + base64, tramas con
  máscara, longitudes de 16/64 bits, fragmentación, ping/pong y close. El código
  original fingía el handshake con un XOR y un GUID mal escrito, que ningún
  navegador acepta.
- **Un hilo por conexión** para leer, un `writeMutex` por conexión para
  escribir. El motor está protegido por un mutex aparte y las secciones críticas
  son mínimas.
- Las conexiones HTTP de tipo keep-alive se cierran tras 15 s de inactividad;
  un WebSocket ya establecido no tiene timeout de lectura.
- La pelota avanza en subpasos para que no atraviese un muro a alta velocidad.
