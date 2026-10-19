// End-to-end check: loads the real page in headless Chromium over the Chrome
// DevTools Protocol and asserts what a person would see.
// Usage: node dev/check.mjs [--api http://localhost:8080]
// Without --api the page reads dev/mock.mjs, started in-process.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './mock.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'dev/out');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const apiFlag = process.argv.indexOf('--api');
const realApi = apiFlag > 0 ? process.argv[apiFlag + 1] : null;

const GONE = 'docker/ephemeral-job';
const RANGES = [
    ['15m', 'every 5 seconds'],
    ['7d', 'five-minute'],
    ['2y', 'hourly'],
    ['1h', 'one reading a minute'],
];

let failed = false;
const report = (status, text) => {
    if (status === 'FAIL') failed = true;
    console.log(`${status.padEnd(4)} ${text}`);
};

async function check(name, fn) {
    try {
        if ((await fn()) === false) report('FAIL', name);
        else report('ok', name);
    } catch (err) {
        report('FAIL', `${name}: ${err.message}`);
    }
}

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (!msg.id) return listeners.forEach((fn) => fn(msg));
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    };
    return {
        send: (method, params = {}) => new Promise((resolve, reject) => {
            pending.set(++nextId, { resolve, reject });
            ws.send(JSON.stringify({ id: nextId, method, params }));
        }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome(profile) {
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { detached: true, stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100; i++) {
        try {
            const port = readFileSync(portFile, 'utf8').split('\n')[0];
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = targets.find((t) => t.type === 'page');
            if (page) return { proc, wsUrl: page.webSocketDebuggerUrl };
        } catch { /* not up yet */ }
        await sleep(100);
    }
    throw new Error(`${CHROME} did not expose a DevTools port`);
}

async function firstSnapshot(api) {
    const res = await fetch(`${api}/monitor/stream`, { signal: AbortSignal.timeout(8000) });
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        const m = text.match(/^data: (.*)$/m);
        if (m) return JSON.parse(m[1]);
    }
    throw new Error('stream sent no snapshot');
}

execFileSync(process.execPath, ['--check', join(ROOT, 'main.js')]);
report('ok', 'main.js parses');

const mock = await start({ port: 0 });
const profile = mkdtempSync(join(tmpdir(), 'monitor-check-'));
let chrome;
const cleanup = () => {
    try { process.kill(-chrome.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
};
const watchdog = setTimeout(() => { report('FAIL', 'run took over 60s'); cleanup(); process.exit(1); }, 60_000);

try {
    chrome = await launchChrome(profile);
    const cdp = await connect(chrome.wsUrl);
    const errors = [];
    const pageError = (text) => { errors.push(text); report('FAIL', `page error: ${text}`); };
    cdp.on(({ method, params }) => {
        if (method === 'Runtime.exceptionThrown') pageError(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
        else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') pageError(params.args.map((a) => a.value ?? a.description).join(' '));
        else if (method === 'Log.entryAdded' && params.entry.level === 'error') pageError(`${params.entry.text} ${params.entry.url ?? ''}`);
    });
    for (const domain of ['Page', 'Runtime', 'Log']) await cdp.send(`${domain}.enable`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const viewport = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await viewport(1280, 900);

    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        return result.value;
    };
    const waitFor = async (expression, what, timeout = 8000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await evaluate(expression).catch(() => false)) return;
            await sleep(100);
        }
        throw new Error(`timed out waiting for ${what}`);
    };
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const shots = [];
    const shoot = async (name) => {
        const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
        const width = await evaluate('window.innerWidth');
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
        const file = join(OUT, `${name}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        shots.push(file);
    };
    const open = async (query = '') => {
        const api = realApi ?? mock.url;
        await cdp.send('Page.navigate', { url: `${mock.url}/?api=${encodeURIComponent(api)}${query}` });
        await waitFor(`(document.querySelector('#tiles .value')?.textContent ?? '–') !== '–'`, 'the CPU tile to fill');
    };
    const chartCards = `[...document.querySelectorAll('#charts .chart')]`;
    const hasCharts = `${chartCards}.length === 6 && ${chartCards}.every((c) => c.querySelector('canvas'))`;

    mkdirSync(OUT, { recursive: true });
    const snapshot = await firstSnapshot(realApi ?? mock.url);
    await open();

    await check('tiles filled', () => evaluate(`document.querySelector('#tiles .value').textContent.trim() !== '–'`));
    await check('six chart cards with a canvas', async () => { await waitFor(hasCharts, 'six charts'); });
    await check('tier note starts with Showing', () => evaluate(`document.getElementById('tierNote').textContent.startsWith('Showing')`));
    await check('every service and group rendered', async () => {
        const groups = new Set(snapshot.services.map((s) => s.group));
        const text = await evaluate(`document.getElementById('services').textContent`);
        const shown = await evaluate(`document.querySelectorAll('#services .group').length`);
        const missing = snapshot.services.filter((s) => !text.includes(s.name)).map((s) => `${s.group}/${s.name}`);
        if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
        return shown === groups.size;
    });
    await check('recent status changes listed', () => evaluate(`document.querySelectorAll('#events li:not(.empty)').length > 0`));
    await check('storage tiers shown', () => evaluate(`document.querySelectorAll('#storage .tier').length >= 3`));
    await shoot('desktop-light');

    for (const [range, tier] of RANGES) {
        const before = await evaluate(`document.getElementById('tierNote').textContent`);
        await check(`range ${range} re-renders charts`, async () => {
            await click(`#ranges [data-range="${range}"]`);
            await waitFor(`document.getElementById('tierNote').textContent.includes(${JSON.stringify(tier)})`, `tier note for ${range}`);
            await waitFor(hasCharts, 'six charts');
            return (await evaluate(`document.getElementById('tierNote').textContent`)) !== before;
        });
    }

    await check('pm2 logs open and go live', async () => {
        await evaluate(`[...document.querySelectorAll('#services .group')].find((g) => g.querySelector('h3').textContent.startsWith('pm2')).querySelector('button.linkish').click()`);
        await waitFor(`document.getElementById('logs').open`, 'the logs dialog');
        await waitFor(`document.querySelectorAll('#logsPane-out .line').length > 0`, 'output lines');
        await waitFor(`document.getElementById('logsConnText').textContent === 'Live'`, 'Live');
        return !(await evaluate(`document.getElementById('logsPane-out').textContent`)).includes('\x1b');
    });
    await shoot('logs-dialog');
    await click('#logsClose');

    if (realApi) {
        report('skip', 'gone container (mock-only fixture)');
    } else {
        await check('gone container shows the end message', async () => {
            await open(`&logs=${GONE}`);
            await waitFor(`document.getElementById('logsConnText').textContent === "Container's logs ended"`, 'the gone message');
        });
        await open();
    }

    await check('theme toggle flips to dark', async () => {
        await click('#theme');
        await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');
    });
    await shoot('desktop-dark');
    await check('theme toggle flips back to light', async () => {
        await click('#theme');
        await waitFor(`document.documentElement.dataset.theme === 'light'`, 'light theme');
    });

    await viewport(390, 844);
    await open();
    await waitFor(hasCharts, 'six charts');
    await check('no horizontal scroll at 390px', () => evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
    await shoot('mobile');

    await check('no page errors', () => errors.length === 0);
    console.log(`Screenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
    cdp.close();
} catch (err) {
    report('FAIL', err.stack);
} finally {
    clearTimeout(watchdog);
    cleanup();
    await mock.close();
}
process.exit(failed ? 1 : 0);
