/* ============================================================================
 * ui.js — Utilidades de DOM compartidas por el resto del cliente.
 *
 * Sin framework ni build step: unas pocas funciones que evitan repetir
 * getElementById y las comprobaciones de null en cada módulo.
 * ==========================================================================*/

window.CB = window.CB || {};

CB.dom = (function () {
    'use strict';

    const cache = Object.create(null);

    /** Elemento por id, cacheado. Devuelve null si no existe. */
    function el(id) {
        if (!(id in cache)) cache[id] = document.getElementById(id);
        return cache[id];
    }

    /** Escribe texto solo si cambió: evita reflows en bucles de 60 Hz. */
    function setText(node, text) {
        if (node && node.textContent !== text) node.textContent = text;
    }

    /**
     * Muestra u oculta con la clase .hidden, sin tocar el DOM si no hace falta.
     * Sin segundo argumento alterna el estado y devuelve el resultante, que es
     * lo que permite escribir `showPanel(show(panel) ? null : 'create')`.
     */
    function show(node, visible) {
        if (!node) return false;
        const isVisible = !node.classList.contains('hidden');
        const want = visible === undefined ? !isVisible : !!visible;
        if (want !== isVisible) node.classList.toggle('hidden', !want);
        return want;
    }

    function setClass(node, name, on) {
        if (node) node.classList.toggle(name, !!on);
    }

    function setBarWidth(node, percent) {
        if (node) node.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }

    function num(value) {
        return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    /**
     * Entero con valor por defecto. Distinto de num() a propósito: aquí el
     * fallback sí se aplica, y además acepta los strings que llegan de un
     * <select> ("4") o de un campo que el servidor no mandó.
     */
    function intOr(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = parseInt(value, 10);
        return isFinite(parsed) ? parsed : fallback;
    }

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    /** Factor de interpolación exponencial: 1 - e^(-rate·dt). */
    function smoothing(rate, dt) {
        return 1 - Math.exp(-rate * dt);
    }

    function formatTime(ms) {
        const total = Math.max(0, Math.floor(num(ms) / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    /** Escapa texto para insertarlo como HTML de forma segura. */
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─── Avisos flotantes ──────────────────────────────────────────

    const toastBox = () => el('toasts');

    /**
     * Aviso breve en la esquina. `kind` es 'info' | 'good' | 'bad'.
     * Se autodestruye; no hace falta limpiar nada a mano.
     */
    function toast(text, kind, ms) {
        const box = toastBox();
        if (!box) return;

        const node = document.createElement('div');
        node.className = 'toast' + (kind ? ' toast-' + kind : '');
        node.textContent = text;
        box.appendChild(node);

        // Doble animación (entrada + salida) y luego fuera del DOM.
        window.setTimeout(() => node.classList.add('is-out'), (ms || 2600));
        window.setTimeout(() => {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, (ms || 2600) + 400);
    }

    /** Copia texto al portapapeles con reserva para navegadores sin permiso. */
    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                () => toast('Copiado: ' + text, 'good'),
                () => fallbackCopy(text)
            );
            return;
        }
        fallbackCopy(text);
    }

    function fallbackCopy(text) {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
            document.execCommand('copy');
            toast('Copiado: ' + text, 'good');
        } catch (error) {
            toast('No se pudo copiar', 'bad');
        }
        document.body.removeChild(area);
    }

    // ─── Almacenamiento tolerante a fallos ──────────────────────────
    // El juego funciona en modo privado con el almacenamiento bloqueado; solo
    // se pierde la comodidad de recordar el nombre y la sala.

    function load(key, fallback) {
        try {
            const value = window.localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function save(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (error) {
            /* sin persistencia: no es motivo para romper nada */
        }
    }

    function remove(key) {
        try {
            window.localStorage.removeItem(key);
        } catch (error) {
            /* idem */
        }
    }

    return {
        el: el,
        setText: setText,
        show: show,
        setClass: setClass,
        setBarWidth: setBarWidth,
        num: num,
        intOr: intOr,
        clamp: clamp,
        smoothing: smoothing,
        formatTime: formatTime,
        escapeHtml: escapeHtml,
        toast: toast,
        copyText: copyText,
        load: load,
        save: save,
        remove: remove
    };
})();