// A stand-in for go-server's /monitor API with synthetic data, plus a static
// handler for the page, so the dashboard runs with no Pi behind it.
// Usage: node dev/mock.mjs [--port 8090]   (then open /?api=<same origin>)
// The contract lives in go-server's monitor package. Change both together.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/main.js': ['main.js', 'text/javascript; charset=utf-8'],
};

// One row per render branch in main.js. `ago` is seconds since the service
// started and becomes `since`. The docker row named `docker` is go-server's
// stand-in for "the group can't be read".
const SERVICES = [
    { group: 'system', name: 'nginx', status: 'up', detail: 'running', ago: 400000 },
    { group: 'system', name: 'ssh', status: 'up', detail: 'running', ago: 400000 },
    { group: 'system', name: 'fail2ban', status: 'warn', detail: 'activating' },
    { group: 'system', name: 'postgresql', status: 'down', detail: 'failed' },
    { group: 'pm2', name: 'web-app', status: 'up', cpu: 1.2, mem_mb: 120.5, restarts: 0, ago: 90000 },
    { group: 'pm2', name: 'api-worker', status: 'up', cpu: 12.4, mem_mb: 1530.25, restarts: 3, ago: 7300 },
    { group: 'pm2', name: 'flaky-job', status: 'down', detail: 'errored', restarts: 15 },
    { group: 'pm2', name: 'idle-tool', status: 'stopped', detail: 'stopped', restarts: 0 },
    { group: 'docker', name: 'media-server', status: 'up', detail: 'Up 44 hours' },
    { group: 'docker', name: 'ephemeral-job', status: 'up', detail: 'Up 2 minutes' },
    { group: 'docker', name: 'old-batch', status: 'stopped', detail: 'Exited (0) 3 weeks ago' },
    { group: 'docker', name: 'docker', status: 'down', detail: 'docker ps failed' },
    {
        group: 'redis', name: 'redis', status: 'up', detail: '1.58M · 59 keys', mem_mb: 1.58, ago: 250000,
        stats: { clients: '4', 'hit rate': '56.3%', keys: '59', memory: '1.58M', 'ops/s': '0', 'peak memory': '1.63M', version: '7.0.15' },
    },
    { group: 'database', name: 'app.db', status: 'up', detail: '20.8 MiB', stats: { bytes: '21811200' } },
    { group: 'database', name: 'metrics.db', status: 'up', detail: '2.8 MiB', stats: { bytes: '2968848' } },
];

const EVENTS = [
    { ago: 600, group: 'system', name: 'postgresql', status: 'down', detail: 'failed' },
    { ago: 4000, group: 'pm2', name: 'flaky-job', status: 'down', detail: 'errored' },
    { ago: 9000, group: 'system', name: 'fail2ban', status: 'warn', detail: 'activating' },
    { ago: 86400, group: 'docker', name: 'old-batch', status: 'stopped', detail: 'Exited (0) 3 weeks ago' },
    { ago: 172800, group: 'pm2', name: 'api-worker', status: 'up' },
];

// How each log behaves. A service not listed replays NORMAL, then adds a line a second.
const NORMAL = {
    out: ['\x1b[32mINFO\x1b[0m listening on :3000', '\x1b[36mGET\x1b[0m /health 200 2ms', 'job finished in 41ms'],
    err: ['\x1b[33mWARN\x1b[0m slow query (212ms)', '\x1b[31mERROR\x1b[0m upstream timed out'],
};
const LOGS = {
    'docker/ephemeral-job': { ...NORMAL, gone: { message: "Container's logs ended" } },
};

const TIERS = [
    { table: 'live', step: 5, upTo: 900, peak: false },
    { table: 'samples', step: 60, upTo: 48 * 3600, peak: false },
    { table: 'rollup_5m', step: 300, upTo: 30 * 86400, peak: true },
    { table: 'rollup_1h', step: 3600, upTo: Infinity, peak: true },
];

const MAX_SPAN = 2 * 365 * 86400;
const SPAN_UNITS = { m: 60, h: 3600, d: 86400, y: 365 * 86400 };
const TOTALS = { mem_total: 4049.75, disk_total: 234.21 };
const METRICS = {
    cpu: (t) => 20 + 15 * Math.sin(t / 900) + 5 * Math.sin(t / 37),
    temp: (t) => 58 + 6 * Math.sin(t / 1500),
    load1: (t) => 0.5 + 0.4 * Math.sin(t / 700),
    mem_used: (t) => 2300 + 300 * Math.sin(t / 3000),
    swap_used: (t) => 550 + 20 * Math.sin(t / 2000),
    disk_used: () => 67.05,
    disk_read: (t) => 30 + 25 * Math.sin(t / 211),
    disk_write: (t) => 230 + 200 * Math.sin(t / 173),
    net_rx: (t) => 40 + 30 * Math.sin(t / 97),
    net_tx: (t) => 20 + 15 * Math.sin(t / 131),
};

const nowSec = () => Math.floor(Date.now() / 1000);
const round = (v) => Math.round(Math.max(0, v) * 100) / 100;
const reading = (t) => ({ ...TOTALS, ...Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, round(f(t))])) });

function snapshot() {
    const now = nowSec();
    return {
        sample: { ts: now, ...reading(now) },
        host: { hostname: 'mock-pi', kernel: '6.12.0-mock', cores: 4, uptime: 157304.92, ports: [22, 80, 3000, 5432, 8080] },
        services: SERVICES.map(({ ago, ...s }) => (ago ? { ...s, since: now - ago } : s)),
    };
}

function parseSpan(s) {
    const n = Number(s.slice(0, -1));
    const unit = SPAN_UNITS[s.at(-1)];
    if (s.length < 2 || !Number.isInteger(n) || n < 1 || !unit) return null;
    return Math.min(n * unit, MAX_SPAN);
}

// history leaves a hole mid-range (except live) so the charts' gap handling runs.
function history(span) {
    const tier = TIERS.find((t) => span <= t.upTo);
    const end = Math.floor(nowSec() / tier.step) * tier.step;
    const count = Math.floor(span / tier.step);
    const gapAt = Math.floor(count / 2);
    const ts = [];
    for (let i = count - 1; i >= 0; i--) {
        const inGap = tier.table !== 'live' && i >= gapAt && i < gapAt + 6;
        if (!inGap) ts.push(end - i * tier.step);
    }
    const readings = ts.map(reading);
    const series = {};
    for (const key of Object.keys(readings[0])) {
        series[key] = readings.map((r) => r[key]);
        if (tier.peak) series[`${key}_max`] = readings.map((r) => (key in TOTALS ? r[key] : round(r[key] * 1.35 + 1)));
    }
    return { tier: tier.table, step: tier.step, ts, series };
}

function storage() {
    const now = nowSec();
    const table = (name, step, rows, capacity, retention) => ({ table: name, step, rows, capacity, retention, oldest: Math.round(now - (retention * rows) / capacity), newest: now });
    return {
        path: './metrics.db', file_bytes: 2400256, wal_bytes: 568592, free_bytes: 0,
        tables: [
            table('samples', 60, 2750, 2880, 172800),
            table('rollup_5m', 300, 4430, 8640, 2592000),
            table('rollup_1h', 3600, 10560, 17520, 63072000),
            { table: 'service_events', rows: EVENTS.length, capacity: 0, retention: 7776000, oldest: now - 172800, newest: now - 600 },
        ],
    };
}

function sendJSON(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
}

function openStream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    const timers = [];
    req.on('close', () => timers.forEach(clearInterval));
    return { write: (s) => res.write(s), every: (ms, fn) => timers.push(setInterval(fn, ms)) };
}

function serveStream(req, res) {
    const sse = openStream(req, res);
    sse.write('retry: 5000\n');
    const send = () => sse.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    send();
    sse.every(5000, send);
}

function serveLogs(req, res, group, name, params) {
    const known = ['pm2', 'docker'].includes(group) && SERVICES.some((s) => s.group === group && s.name === name && s.name !== group);
    if (!known) return sendJSON(res, 404, { error: group === 'pm2' ? 'Unknown pm2 process' : 'Unknown container' });
    const log = LOGS[`${group}/${name}`] ?? NORMAL;
    const base = log[params.get('stream') === 'err' ? 'err' : 'out'];
    const line = (seq) => `${base[seq % base.length]} #${seq}`;
    const replay = Math.min(Number(params.get('lines')) || 200, 40);
    const sse = openStream(req, res);
    const send = (lines) => sse.write(`data: ${JSON.stringify({ lines })}\n\n`);
    send(Array.from({ length: replay }, (_, i) => line(i)));
    if (log.gone) {
        sse.write(`event: gone\ndata: ${JSON.stringify(log.gone)}\n\n`);
        return res.end();
    }
    let seq = replay;
    sse.every(1000, () => send([line(seq++)]));
}

async function serveFile(res, [file, type]) {
    res.writeHead(200, { 'Content-Type': type });
    res.end(await readFile(ROOT + file));
}

async function route(req, res) {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const logsPath = path.match(/^\/monitor\/logs\/([^/]+)\/([^/]+)$/);
    if (PAGES[path]) return serveFile(res, PAGES[path]);
    if (path === '/favicon.ico') return res.writeHead(204).end();
    if (path === '/monitor/stream') return serveStream(req, res);
    if (logsPath) return serveLogs(req, res, decodeURIComponent(logsPath[1]), decodeURIComponent(logsPath[2]), url.searchParams);
    if (path === '/monitor/history') {
        const range = url.searchParams.get('range') || '1h';
        const span = parseSpan(range);
        return span ? sendJSON(res, 200, history(span)) : sendJSON(res, 400, { error: `invalid range "${range}"` });
    }
    if (path === '/monitor/events') {
        const limit = Number(url.searchParams.get('limit'));
        const rows = EVENTS.slice(0, Math.min(limit >= 1 ? limit : 50, 500));
        return sendJSON(res, 200, rows.map(({ ago, ...e }) => ({ ts: nowSec() - ago, ...e })));
    }
    if (path === '/monitor/storage') return sendJSON(res, 200, storage());
    sendJSON(res, 404, { error: 'Not found' });
}

export function start({ port = 8090 } = {}) {
    const server = createServer((req, res) => route(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJSON(res, 500, { error: 'mock failed' });
    }));
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }),
        }));
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const flag = process.argv.indexOf('--port');
    const port = Number(flag > 0 ? process.argv[flag + 1] : process.env.PORT || 8090);
    const { url } = await start({ port });
    console.log(`Mock monitor API on ${url}\nOpen ${url}/?api=${url}`);
}
