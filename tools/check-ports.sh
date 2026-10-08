#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-ports.sh — comprueba qué puertos usa tu VPS antes de desplegar
# ─────────────────────────────────────────────────────────────────────────────
#
# Para qué: un despliegue puede fallar por un puerto ya ocupado, y el error que
# da Docker ("port is already allocated") no dice qué lo ocupa ni por qué. Este
# script responde a las dos preguntas antes de que te_curras con el despliegue.
#
# CrashBall NO necesita ningún puerto del host, porque Dokploy lo enruta por la
# red interna. Esto se verifica igualmente, porque hay un momento en que
# necesitas un puerto libre: cuando pruebas en local.
#
# Uso:
#   bash tools/check-ports.sh              # informe de lo que hay en uso
#   bash tools/check-ports.sh 18080        # ¿está libre el 18080?
#
# No necesita permisos de root. Si algo no puede verse por permisos, lo dice en
# lugar de fingir que está libre.

set -uo pipefail

# Colores solo si la salida es una terminal de verdad. Sin esto, al redirigir a
# un fichero (un log de Dokploy, un `> informe.txt`) los códigos de escape se
# escriben tal cual y el informe sale lleno de basura tipo "[0;32m".
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
    DIM=$(tput dim); OFF=$(tput sgr0)
else
    GREEN=''; YELLOW=''; RED=''; DIM=''; OFF=''
fi

printf '%s\n' "════════════════════════════════════════════════════════════"
printf '%s\n' " Crash Ball Arena — puertos del VPS"
printf '%s\n' "════════════════════════════════════════════════════════════"
printf '\n'

have() { command -v "$1" >/dev/null 2>&1; }

# ── Puertos publicados por contenedores ─────────────────────────────────────
# Esta es la lista que de verdad importa: son los que Docker reserva en el host
# y los que mueven error si dos apps piden el mismo.
printf '%s\n' "── Puertos publicados por contenedores ──────────────────────${DIM}"
if have docker; then
    PORTS_DOCKER=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -v '^$' || true)
    if [ -z "$PORTS_DOCKER" ]; then
        printf '%s\n' "  (ningún contenedor publicando puertos)"
    else
        printf '%s\n' "$PORTS_DOCKER" | while IFS='|' read -r name ports; do
            [ -z "$name" ] && continue
            printf '  %s\n' "$name"
            printf '%s\n' "$ports" | grep -oE '[0-9]+->' | tr -d '->' | while read -r p; do
                printf '      puerto %s\n' "$p"
            done
        done
    fi
else
    printf '%s\n' "  docker no está instalado o no está en el PATH"
fi
printf '\n'

# ── Puertos en escucha en el host ───────────────────────────────────────────
printf '%s\n' "── Puertos en escucha en el host ───────────────────────────${DIM}"
LISTEN=""
if have ss; then
    LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' || true)
elif have netstat; then
    LISTEN=$(netstat -ltn 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' || true)
fi

if [ -z "$LISTEN" ]; then
    printf '%s\n' "  (no se pudo leer la lista; hace falta ss o netstat)"
else
    printf '%s\n' "$LISTEN" | sort -n -u | while read -r p; do
        [ -z "$p" ] && continue
        printf '  %s\n' "$p"
    done
    printf '%s\n' "  ${DIM}($(printf '%s\n' "$LISTEN" | wc -l | tr -d ' ') puertos)${OFF}"
fi
printf '\n'

# ── Comprobación de un puerto concreto ──────────────────────────────────────
check_port() {
    port="$1"
    printf '%s\n' "── Comprobación del puerto $port ──────────────────────────${OFF}"

    # Dentro de un contenedor, el espacio de puertos es propio. Por eso el
    # 8080 interno no puede chocar con nada del host, ni aunque otra app lo use.
    printf '  %sDocker%s   : el 8080 interno del contenedor no puede chocar con\n' "$DIM" "$OFF"
    printf '                nada del host (cada contenedor tiene su espacio).\n'
    printf '  %sAviso%s    : Dokploy enruta el dominio por la red interna, así que\n' "$DIM" "$OFF"
    printf '                CrashBall no necesita puerto del host.\n\n'

    in_use=0
    if printf '%s\n' "$LISTEN" | grep -qx "$port"; then
        in_use=1
        printf '  %s✗ OCUPADO%s en el host.\n' "$RED" "$OFF"
        printf '    Si pruebas en local con -p, elige otro puerto.\n'
    else
        printf '  %s✓ libre%s en el host.\n' "$GREEN" "$OFF"
    fi

    # Puertos típicos de Dokploy: convencen de dejarles sitio y saber qué son
    # si aparece unoOccupied en el informe.
    case "$port" in
        3000|3001) printf '    %sOjo%s: %s es habitual en Dokploy.\n' "$YELLOW" "$OFF" "$port" ;;
        8080)      printf '    %sOjo%s: 8080 es el puerto por defecto de Dokploy.\n' "$YELLOW" "$OFF" ;;
        80|443)    printf '    %sOjo%s: %s lo usa el proxy inverso de Dokploy.\n' "$YELLOW" "$OFF" "$port" ;;
    esac

    if [ "$in_use" -eq 0 ]; then
        printf '\n  %sListo para usar.%s\n' "$GREEN" "$OFF"
    else
        printf '\n  %sNo lo uses para -p; para Dokploy da igual.%s\n' "$YELLOW" "$OFF"
    fi
    exit 0
}

if [ $# -ge 1 ]; then
    case "$1" in
        -h|--help)
            printf '%s\n' "uso: bash tools/check-ports.sh [puerto]"
            exit 0 ;;
        *[!0-9]*|'')
            printf '%s\n' "El puerto tiene que ser un número." >&2
            exit 1 ;;
        *)
            check_port "$1" ;;
    esac
fi

printf '%s\n' "── Para comprobar uno concreto ───────────────────────────────${OFF}"
printf '%s\n' "  bash tools/check-ports.sh 18080"
printf '\n'
printf '%s\n' "── Nota ───────────────────────────────────────────────────────${OFF}"
printf '%s\n' "  CrashBall no publica ningún puerto del host (el compose no tiene"
printf '%s\n' "  sección 'ports' a propósito), así que no puede interferir con tus"
printf '%s\n' "  demás aplicaciones. Esta lista es para cuando pruebes en local."
printf '\n'