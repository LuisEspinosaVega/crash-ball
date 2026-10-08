# syntax=docker/dockerfile:1
#
# Dockerfile — Crash Ball Arena
#
# Pensado para Dokploy: compila en la propia imagen y entrega un runtime mínimo.
# El juego es un binario C++ que además sirve los archivos estáticos, así que no
# hace falta Node, nginx ni nada más en tiempo de ejecución.
#
# La imagen final lleva el binario y public/, nada más. Eso importa: el servidor
# abre un socket por conexión entrante, y un runtime con shell y utilidades de
# sobra es superficie de ataque que aquí no hace falta.

# ─── Compilación ───────────────────────────────────────────────────
# Se compila con la imagen oficial de CMake sobre Debian, en lugar de la de
# Alpine: Alpine usa musl y el código está escrito y probado contra glibc. Musl
# se comporta distinto en algunos detalles de red y de hilos, que es justo lo
# que este servidor no necesita que cambie.
FROM cmake:3.27-bookworm AS build

WORKDIR /src

# Primero solo el código nativo: si esto no cambia, la copia de las fuentes (la
# capa más lenta) se reutiliza de la caché y las reconstrucciones son rápidas.
COPY CMakeLists.txt ./
COPY Server ./Server

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build --config Release -j "$(nproc)"

# ─── Comprobación antes de publicar ────────────────────────────────
# El selftest es offline y tarda un segundo: si el binario de la imagen se rompe
# al compilar en Linux (que es distinto de compilar en Windows), el despliegue
# falla aquí y no con un servidor raro en producción.
RUN ./build/server --selftest

# ─── Runtime ───────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# ca-certificates no hace falta si no hay HTTPS aquí (el proxy inverso de
# Dokploy lo termina). Se instala curl solo para el HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Usuario sin privilegios. El servidor no escribe nada en disco, así que no
# necesita ser root, y no queremos que lo sea.
RUN useradd --system --create-home --shell /usr/sbin/nologin crashball

WORKDIR /app

COPY --from=build /src/build/server /app/server
COPY public /app/public

# PUBLIC_DIR es explícito porque el directorio de trabajo de un contenedor es
# fijo: sin esto el servidor buscaría ./public por rutas relativas y, si no lo
# encuentra, arranca igual y no sirve nada. Es un fallo silencioso que en un
# despliegue parece un problema de red.
ENV PUBLIC_DIR=/app/public

USER crashball

# Coincide con el puerto por defecto del servidor y con el que Dokploy publica.
EXPOSE 8080

# Comprobación de vida: si el contenedor deja de servir, Dokploy lo reinicia.
# Se consulta el HTML, que es lo mismo que ve un jugador al abrir la URL.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/ > /dev/null || exit 1

ENTRYPOINT ["/app/server"]