#!/usr/bin/env node
// Comprueba que CrashBall NO toca las demás aplicaciones del VPS.
//
// El riesgo concreto que se quiere evitar: publicar un puerto del host es la
// única forma que tiene esta app de molestar a otra, y el síntoma es un
// despliegue que falla con "port is already allocated", o peor, una app
// existente que deja de responder.
//
// La prueba reproduce el escenario: otra aplicación ocupa el 8080 del host (el
// puerto por defecto de Dokploy, el más probable), y se levanta CrashBall a la
// vez. Si el compose no publica puertos, ambos conviven.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const IMAGE = process.argv[2] || 'crashball:latest';
const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('error', (e) => resolve({ code: 127, out: e.message }));
        child.on('close', (code) => resolve({ code, out }));
    });
}

// El compose desplegado no debe publicar puertos. Se comprueba sobre el
// fichero de verdad, no sobre una copia: es lo que se sube al VPS.
console.log('AISlamiento respecto a las demás aplicaciones\n');

const compose = await docker(['compose', 'config']);
const publishes = /published:\s*\d+/.test(compose.out);
check('el compose NO publica ningún puerto del host',
      !publishes,
      publishes ? 'publica puertos: puede chocar con otra app' : 'sin sección ports');

const run = (await docker(['compose', 'config', '--services'])).out.trim().split('\n')[0];
check('el compose define un servicio', !!run, run || 'ninguno');

// ── Escenario real: otra app con el 8080 del host ──────────────────────────
await docker(['rm', '-f', 'cb-test-otra', 'cb-test-crashball']);

const otra = await docker(['run', '-d', '--name', 'cb-test-otra',
                           '-p', '127.0.0.1:8080:80', 'nginx:alpine']);
check('la otra aplicación ocupa el puerto 8080 del host',
      otra.code === 0, otra.code === 0 ? 'levantada' : otra.out.trim().slice(0, 120));
await sleep(3000);

const arriba = await docker(['run', '-d', '--name', 'cb-test-crashball', IMAGE]);
check('CrashBall arranca con la otra app en 8080',
      arriba.code === 0,
      arriba.code === 0 ? 'sin conflicto de puertos'
                        : arriba.out.trim().slice(0, 160));
await sleep(5000);

// La otra app no puede verse afectada: es el punto del asunto.
const otraViva = await docker(['exec', 'cb-test-otra', 'nginx', '-t']);
check('la otra aplicación sigue intacta',
      otraViva.code === 0, otraViva.code === 0 ? 'nginx sigue bien' : otraViva.out.trim().slice(0, 120));

const health = await docker(['inspect', '--format', '{{.State.Health.Status}}', 'cb-test-crashball']);
check('CrashBall queda sano',
      health.out.includes('healthy') || health.out.includes('starting'),
      health.out.trim());

// Y el juego se sirve desde dentro, sin tocar el host.
const sirve = await docker(['exec', 'cb-test-crashball', 'curl', '-fsS',
                           '-o', '/dev/null', '-w', '%{http_code}',
                           'http://127.0.0.1:8080/']);
check('el juego se sirve dentro del contenedor',
      sirve.out.trim().endsWith('200'), `HTTP ${sirve.out.trim()}`);

await docker(['rm', '-f', 'cb-test-otra', 'cb-test-crashball']);

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);