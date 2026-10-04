// Pi Monitor: reads go-server's /monitor endpoints and draws the machine's
// readings, its services and how much history is kept.

const params = new URLSearchParams(location.search);
// go-server listens on 8080 of the machine nginx served this page from.
const API = params.get('api') || `http://${location.hostname || 'raspberrypi.local'}:8080`;

const RANGES = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000, '1y': 31536000, '2y': 63072000 };
const TIER_NAMES = {
    live: 'every 5 seconds, kept in memory for 15 minutes',
    samples: 'one reading a minute, kept for 48 hours',
    rollup_5m: 'five-minute averages and peaks, kept for 30 days',
    rollup_1h: 'hourly averages and peaks, kept for 2 years',
};

const CHARTS = [
    { id: 'cpu', title: 'CPU', unit: '%', fixedMax: 100, series: [{ key: 'cpu', label: 'CPU' }] },
    { id: 'temp', title: 'Temperature', unit: '°C', series: [{ key: 'temp', label: 'Temperature' }] },
    { id: 'mem', title: 'Memory', unit: 'MiB', series: [{ key: 'mem_used', label: 'Used' }, { key: 'swap_used', label: 'Swap' }] },
    { id: 'load', title: 'Load average', unit: '', series: [{ key: 'load1', label: '1 minute' }] },
    { id: 'disk', title: 'Disk I/O', unit: 'kB/s', series: [{ key: 'disk_read', label: 'Read' }, { key: 'disk_write', label: 'Write' }] },
    { id: 'net', title: 'Network', unit: 'kB/s', series: [{ key: 'net_rx', label: 'Received' }, { key: 'net_tx', label: 'Sent' }] },
];

const GROUPS = [
    ['system', 'System services'],
    ['pm2', 'pm2 processes'],
    ['docker', 'Docker containers'],
    ['redis', 'Redis'],
    ['database', 'SQLite databases'],
];

const STATUS_ORDER = { down: 0, warn: 1, up: 2, stopped: 3 };
const STATUS_LABEL = { up: 'Up', warn: 'Degraded', down: 'Down', stopped: 'Stopped' };

// ---------- small helpers ----------

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// el builds an element. Text is always set with textContent, since names come
// from pm2, Docker and systemd.
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function fmtNum(v, digits = 1) {
    if (v == null || Number.isNaN(v)) return '–';
    return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fmtRate(kbps) {
    if (kbps == null) return '–';
    if (kbps >= 1024 * 1024) return `${fmtNum(kbps / 1024 / 1024)} GB/s`;
    if (kbps >= 1024) return `${fmtNum(kbps / 1024)} MB/s`;
    return `${fmtNum(kbps, kbps < 10 ? 1 : 0)} kB/s`;
}

function fmtMiB(mib) {
    if (mib == null) return '–';
    return mib >= 1024 ? `${fmtNum(mib / 1024, 2)} GiB` : `${fmtNum(mib, 0)} MiB`;
}

function fmtBytes(b) {
    if (b == null) return '–';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${fmtNum(b, i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtValue(v, unit) {
    if (v == null) return '–';
    if (unit === 'kB/s') return fmtRate(v);
    if (unit === 'MiB') return fmtMiB(v);
    if (unit === '%') return `${fmtNum(v)}%`;
    if (unit === '°C') return `${fmtNum(v)} °C`;
    return fmtNum(v, 2);
}

// axisLabels formats an axis's ticks in a single unit, chosen by the largest,
// so one axis never mixes MiB and GiB.
function axisLabels(vals, unit) {
    const top = Math.max(...vals.map(Math.abs));
    if (unit === 'MiB') {
        return top >= 1024 ? vals.map((v) => `${fmtNum(v / 1024, 1)} GiB`) : vals.map((v) => `${fmtNum(v, 0)} MiB`);
    }
    if (unit === 'kB/s') {
        if (top >= 1024 * 1024) return vals.map((v) => `${fmtNum(v / 1048576, 1)} GB/s`);
        if (top >= 1024) return vals.map((v) => `${fmtNum(v / 1024, 1)} MB/s`);
        return vals.map((v) => `${fmtNum(v, 0)} kB/s`);
    }
    return vals.map((v) => fmtValue(v, unit));
}

function fmtDuration(seconds) {
    if (seconds == null || seconds < 0) return '';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.floor(seconds)}s`;
}

function fmtAgo(ts) {
    const s = Date.now() / 1000 - ts;
    if (s < 60) return 'just now';
    return `${fmtDuration(s)} ago`;
}

function fmtDate(ts, withTime = true) {
    const d = new Date(ts * 1000);
    return withTime
        ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const ICONS = {
    up: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7 13H1z" fill="currentColor"/><path d="M8 6v3.6" stroke="#000" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="#000"/></svg>',
    down: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    stopped: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

// statusBadge pairs the status colour with an icon and a word, so the colour
// never carries the meaning alone.
function statusBadge(status) {
    const badge = el('span', { class: `status ${status}` });
    badge.innerHTML = ICONS[status] || ICONS.stopped; // fixed markup, no data
    badge.append(STATUS_LABEL[status] || status);
    return badge;
}

async function getJSON(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
}

// ---------- theme ----------

function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
}
applyTheme(storageGet('theme'));
document.getElementById('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    storageSet('theme', next);
    charts.rebuild();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => charts.rebuild());

// ---------- tiles ----------

const tiles = (() => {
    const root = document.getElementById('tiles');
    const defs = [
        { id: 'cpu', label: 'CPU' },
        { id: 'temp', label: 'Temperature' },
        { id: 'mem', label: 'Memory' },
        { id: 'disk', label: 'Disk /' },
        { id: 'load', label: 'Load' },
        { id: 'net', label: 'Network' },
        { id: 'uptime', label: 'Uptime' },
    ];
    const nodes = {};
    for (const d of defs) {
        const value = el('div', { class: 'value', text: '–' });
        const sub = el('div', { class: 'sub' });
        const bar = el('i');
        const meter = el('div', { class: 'meter' }, bar);
        root.append(el('div', { class: 'card tile' }, el('div', { class: 'label', text: d.label }), value, sub, meter));
        nodes[d.id] = { value, sub, bar, meter };
    }

    function set(id, value, unit, sub, fraction, level) {
        const n = nodes[id];
        n.value.textContent = value;
        if (unit) n.value.append(el('small', { text: unit }));
        n.sub.textContent = sub || '';
        if (fraction == null) {
            n.meter.style.visibility = 'hidden';
        } else {
            n.meter.style.visibility = '';
            n.bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
            n.bar.className = level || '';
        }
    }

    const level = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : '');

    return {
        update(s, host) {
            set('cpu', s.cpu == null ? '–' : fmtNum(s.cpu), '%', host.cores ? `${host.cores} cores` : '', s.cpu == null ? 0 : s.cpu / 100, level(s.cpu, 75, 90));
            // The Pi 5 starts throttling at 85 °C.
            set('temp', fmtNum(s.temp), '°C', s.temp >= 80 ? 'Near throttling (85 °C)' : 'Throttles at 85 °C', s.temp / 85, level(s.temp, 70, 80));
            const memPct = s.mem_total ? (100 * s.mem_used) / s.mem_total : null;
            set('mem', fmtNum(memPct, 0), '%', `${fmtMiB(s.mem_used)} of ${fmtMiB(s.mem_total)} · swap ${fmtMiB(s.swap_used)}`, memPct / 100, level(memPct, 80, 92));
            const diskPct = s.disk_total ? (100 * s.disk_used) / s.disk_total : null;
            set('disk', fmtNum(diskPct, 0), '%', `${fmtNum(s.disk_used, 0)} of ${fmtNum(s.disk_total, 0)} GiB · ${fmtNum(s.disk_total - s.disk_used, 0)} GiB free`, diskPct / 100, level(diskPct, 80, 92));
            set('load', fmtNum(s.load1, 2), '', host.cores ? `${fmtNum((100 * s.load1) / host.cores, 0)}% of ${host.cores} cores` : '', host.cores ? s.load1 / host.cores : null, level(s.load1 / (host.cores || 1), 0.8, 1));
            set('net', s.net_rx == null ? '–' : fmtRate(s.net_rx), '', `received · ${fmtRate(s.net_tx)} sent`, null);
            set('uptime', fmtDuration(host.uptime), '', host.uptime ? `since ${fmtDate(Date.now() / 1000 - host.uptime)}` : '', null);
        },
    };
})();

// ---------- charts ----------

// withGaps adds a null wherever readings are missing for longer than a few
// steps, so the line breaks instead of bridging the outage.
function withGaps(ts, cols, step) {
    const outTs = [];
    const outCols = cols.map(() => []);
    for (let i = 0; i < ts.length; i++) {
        if (i > 0 && ts[i] - ts[i - 1] > step * 2.5) {
            outTs.push(ts[i - 1] + step);
            outCols.forEach((c) => c.push(null));
        }
        outTs.push(ts[i]);
        cols.forEach((c, j) => outCols[j].push(c[i] ?? null));
    }
    return [outTs, ...outCols];
}

function tooltipPlugin(def, getSeriesMeta) {
    let tip;
    return {
        hooks: {
            init: (u) => {
                tip = el('div', { class: 'tip' });
                u.over.append(tip);
                u.over.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
            },
            setCursor: (u) => {
                const idx = u.cursor.idx;
                if (idx == null || u.cursor.left < 0) { tip.style.display = 'none'; return; }
                const ts = u.data[0][idx];
                tip.replaceChildren(el('div', { class: 't', text: new Date(ts * 1000).toLocaleString() }));
                for (const m of getSeriesMeta()) {
                    const v = u.data[m.index][idx];
                    const row = el('div', { class: 'row' }, el('i', { style: `background:${m.color}` }), el('b', { text: fmtValue(v, def.unit) }), el('span', { text: m.label }));
                    tip.append(row);
                }
                tip.style.display = 'block';
                const w = tip.offsetWidth;
                const left = u.cursor.left + 14 + w > u.over.clientWidth ? u.cursor.left - w - 14 : u.cursor.left + 14;
                tip.style.left = `${left}px`;
                tip.style.top = `${Math.max(0, u.cursor.top - 20)}px`;
            },
        },
    };
}

const charts = (() => {
    const root = document.getElementById('charts');
    const sync = uPlot.sync('pi');
    const instances = new Map();
    let history = null;

    const cards = new Map();
    for (const def of CHARTS) {
        const legend = el('div', { class: 'legend' });
        const plot = el('div', { class: 'plot' });
        const card = el('section', { class: 'card chart' }, el('h2', { text: def.title }), legend, plot);
        root.append(card);
        cards.set(def.id, { card, legend, plot });
    }

    function build(def, h) {
        const { legend, plot } = cards.get(def.id);
        instances.get(def.id)?.destroy();
        instances.delete(def.id);
        plot.replaceChildren();
        legend.replaceChildren();

        const colors = [css('--series-1'), css('--series-2')];
        const hasData = h.series[def.series[0].key]?.some((v) => v != null);
        if (!hasData) {
            plot.append(el('div', { class: 'empty', text: 'No readings in this range' }));
            return;
        }
        // A rollup also carries each metric's peak; a single-series chart
        // shows it as a shaded band above the average.
        const showPeak = def.series.length === 1 && h.series[`${def.series[0].key}_max`];

        const cols = def.series.map((s) => h.series[s.key]);
        const series = [{}];
        const meta = [];
        def.series.forEach((s, i) => {
            series.push({ label: s.label, stroke: colors[i], width: 2, points: { show: false }, spanGaps: false });
            meta.push({ index: series.length - 1, color: colors[i], label: showPeak ? 'Average' : s.label });
        });
        const bands = [];
        if (showPeak) {
            cols.push(h.series[`${def.series[0].key}_max`]);
            series.push({ label: 'Peak', stroke: 'transparent', width: 0, points: { show: false }, spanGaps: false });
            bands.push({ series: [2, 1], fill: withAlpha(colors[0], 0.18) });
            meta.push({ index: 2, color: withAlpha(colors[0], 0.5), label: 'Peak' });
        }
        // Legend for two series or for the peak band; a lone line is named by
        // the card title.
        if (def.series.length > 1) {
            def.series.forEach((s, i) => legend.append(el('span', {}, el('i', { style: `background:${colors[i]}` }), s.label)));
        } else if (showPeak) {
            legend.append(el('span', {}, el('i', { style: `background:${colors[0]}` }), 'Average'));
            legend.append(el('span', {}, el('i', { class: 'band', style: `background:${colors[0]}` }), 'Peak'));
        }

        const data = withGaps(h.ts, cols, h.step);
        const axis = { stroke: css('--muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--axis'), width: 1, size: 4 }, font: '11px system-ui, sans-serif' };
        const now = Date.now() / 1000;
        const span = RANGES[state.range];
        const opts = {
            width: plot.clientWidth || 400,
            height: 180,
            padding: [8, 8, 0, 0],
            cursor: { sync: { key: sync.key }, points: { size: 8 }, drag: { x: false, y: false } },
            legend: { show: false },
            series,
            bands,
            scales: {
                x: { time: true, range: () => [now - span, now] },
                y: { range: (u, min, max) => [0, def.fixedMax ?? (max > 0 ? max * 1.1 : 1)] },
            },
            axes: [
                { ...axis },
                {
                    ...axis,
                    values: (u, vals) => axisLabels(vals, def.unit),
                    // Wide enough for the longest label, so none is clipped.
                    size: (u, vals) => (vals ? Math.ceil(Math.max(...vals.map((v) => v.length)) * 6.6) + 14 : 40),
                },
            ],
            plugins: [tooltipPlugin(def, () => meta)],
        };
        const u = new uPlot(opts, data, plot);
        instances.set(def.id, u);
    }

    new ResizeObserver(() => {
        for (const [id, u] of instances) u.setSize({ width: cards.get(id).plot.clientWidth, height: 180 });
    }).observe(root);

    return {
        render(h) {
            history = h;
            for (const def of CHARTS) build(def, h);
            for (const { card } of cards.values()) card.classList.remove('loading');
        },
        rebuild() { if (history) this.render(history); },
        loading() { for (const { card } of cards.values()) card.classList.add('loading'); },
        // appendLive adds a five-second reading to the live view.
        appendLive(sample) {
            if (!history || history.tier !== 'live' || sample.ts <= history.ts.at(-1)) return;
            history.ts.push(sample.ts);
            for (const key of Object.keys(history.series)) history.series[key].push(sample[key] ?? null);
            const cutoff = sample.ts - RANGES['15m'];
            while (history.ts.length && history.ts[0] < cutoff) {
                history.ts.shift();
                for (const key of Object.keys(history.series)) history.series[key].shift();
            }
            this.render(history);
        },
    };
})();

// ---------- services ----------

function renderServices(services) {
    const root = document.getElementById('services');
    const counts = { up: 0, warn: 0, down: 0, stopped: 0 };
    services.forEach((s) => { counts[s.status] = (counts[s.status] || 0) + 1; });
    const summary = document.getElementById('svcSummary');
    summary.replaceChildren(...['down', 'warn', 'up', 'stopped'].filter((s) => counts[s]).map((s) => {
        const b = statusBadge(s);
        b.append(el('b', { text: ` ${counts[s]}` }));
        return b;
    }));

    const now = Date.now() / 1000;
    root.replaceChildren();
    for (const [group, title] of GROUPS) {
        const items = services.filter((s) => s.group === group)
            .sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.name.localeCompare(b.name));
        if (!items.length) continue;
        const section = el('div', { class: 'group' }, el('h3', { text: title }));

        if (group === 'redis' || group === 'database') {
            const table = el('table');
            for (const s of items) {
                const stats = el('div', { class: 'stats' });
                if (s.stats && group === 'redis') {
                    for (const [k, v] of Object.entries(s.stats)) stats.append(el('span', {}, `${k} `, el('b', { text: v })));
                    if (s.since) stats.append(el('span', {}, 'up ', el('b', { text: fmtDuration(now - s.since) })));
                } else {
                    stats.append(el('span', { text: s.detail || '' }));
                }
                table.append(el('tr', {}, el('td', { style: 'width:110px' }, statusBadge(s.status)), el('td', { class: 'name', text: s.name }), el('td', {}, stats)));
            }
            section.append(table);
            root.append(section);
            continue;
        }

        const withRes = group === 'pm2';
        const head = el('tr', {}, el('th', { text: 'Status', style: 'width:110px' }), el('th', { text: 'Name' }), el('th', { text: group === 'pm2' ? 'Uptime' : 'State' }));
        if (withRes) head.append(el('th', { class: 'num', text: 'CPU' }), el('th', { class: 'num', text: 'Memory' }), el('th', { class: 'num hide-sm', text: 'Restarts' }));
        const table = el('table', {}, el('thead', {}, head));
        const body = el('tbody');
        for (const s of items) {
            let detail = s.detail || '';
            if (s.status === 'up' && s.since) detail = (group === 'system' ? `${detail} · ` : '') + `up ${fmtDuration(now - s.since)}`;
            const row = el('tr', {}, el('td', {}, statusBadge(s.status)), el('td', { class: 'name', text: s.name }), el('td', { class: 'detail', text: detail }));
            if (withRes) {
                row.append(
                    el('td', { class: 'num', text: s.cpu != null ? `${fmtNum(s.cpu)}%` : '' }),
                    el('td', { class: 'num', text: s.mem_mb != null ? fmtMiB(s.mem_mb) : '' }),
                    el('td', { class: 'num hide-sm', text: s.restarts ?? '' }),
                );
            }
            body.append(row);
        }
        table.append(body);
        section.append(table);
        root.append(section);
    }
}

async function loadEvents() {
    const list = document.getElementById('events');
    try {
        const events = await getJSON('/monitor/events?limit=40');
        if (!events.length) {
            list.replaceChildren(el('li', { class: 'empty', text: 'No changes recorded yet' }));
            return;
        }
        list.replaceChildren(...events.map((e) => el('li', {},
            statusBadge(e.status),
            el('span', {}, el('b', { text: e.name }), el('span', { style: 'color:var(--muted)', text: ` · ${e.group}` })),
            el('span', { class: 'when', text: `${fmtAgo(e.ts)} · ${fmtDate(e.ts)}${e.detail ? ` · ${e.detail}` : ''}` }),
        )));
    } catch (err) {
        console.error(err);
    }
}

// ---------- storage ----------

async function loadStorage() {
    const root = document.getElementById('storage');
    let u;
    try { u = await getJSON('/monitor/storage'); } catch (err) { console.error(err); return; }

    const used = u.file_bytes + u.wal_bytes - u.free_bytes;
    // Rollup rows hold an average and a peak per metric, about twice a raw
    // row, which is what the estimate of where the file levels off rests on.
    const weight = (t) => (t.table.startsWith('rollup') ? 2 : 1);
    const tiers = u.tables.filter((t) => t.capacity);
    const units = tiers.reduce((n, t) => n + t.rows * weight(t), 0);
    const fullUnits = tiers.reduce((n, t) => n + t.capacity * weight(t), 0);
    const plateau = units > 1000 ? (used / units) * fullUnits : null;

    const children = [
        el('div', { class: 'bigsize' }, fmtBytes(u.file_bytes + u.wal_bytes), el('small', { text: ' metrics.db on disk' })),
        el('div', { class: 'sub', style: 'color:var(--muted);font-size:12px;margin-bottom:12px', text: plateau ? `Levels off at about ${fmtBytes(plateau)} once every tier is full` : 'Each tier is pruned to its retention, so the file stops growing' }),
    ];
    const labels = { samples: 'Per minute', rollup_5m: '5-minute', rollup_1h: 'Hourly', service_events: 'Status changes' };
    for (const t of u.tables) {
        const kept = fmtDuration(t.retention).replace(/ 0h$/, '');
        const meter = el('div', { class: 'meter' }, el('i', { style: `width:${t.capacity ? Math.min(100, (100 * t.rows) / t.capacity) : 0}%` }));
        if (!t.capacity) meter.style.visibility = 'hidden';
        children.push(el('div', { class: 'tier' },
            el('div', { class: 'top' }, el('span', { text: labels[t.table] || t.table }), el('span', { text: t.capacity ? `${t.rows.toLocaleString()} / ${t.capacity.toLocaleString()} rows` : `${t.rows.toLocaleString()} rows` })),
            meter,
            el('div', { class: 'sub', text: `kept ${kept}${t.oldest ? ` · oldest ${fmtDate(t.oldest, false)}` : ''}` }),
        ));
    }
    root.replaceChildren(...children);
}

// ---------- range & history ----------

const state = {
    range: RANGES[params.get('range')] ? params.get('range') : (RANGES[storageGet('range')] ? storageGet('range') : '1h'),
};
let historyTimer = null;

async function loadHistory() {
    charts.loading();
    try {
        const h = await getJSON(`/monitor/history?range=${state.range}`);
        charts.render(h);
        document.getElementById('tierNote').textContent = `Showing ${TIER_NAMES[h.tier] || h.tier}`;
    } catch (err) {
        console.error(err);
        document.getElementById('tierNote').textContent = 'Could not load history';
    }
}

function selectRange(range) {
    state.range = range;
    storageSet('range', range);
    for (const b of document.querySelectorAll('#ranges button')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    loadHistory();
    // The live view is fed by the stream; stored tiers are refetched as new
    // minutes (or rollups) land.
    clearInterval(historyTimer);
    if (range !== '15m') historyTimer = setInterval(loadHistory, RANGES[range] <= 172800 ? 60_000 : 300_000);
}

for (const b of document.querySelectorAll('#ranges button')) b.addEventListener('click', () => selectRange(b.dataset.range));

// ---------- live stream ----------

function connect() {
    const conn = document.getElementById('conn');
    const text = document.getElementById('connText');
    const source = new EventSource(`${API}/monitor/stream`);
    let lastServices = '';
    source.onopen = () => { conn.className = 'conn live'; text.textContent = 'Live'; };
    source.onerror = () => { conn.className = 'conn lost'; text.textContent = 'Reconnecting…'; };
    source.onmessage = (e) => {
        const snap = JSON.parse(e.data);
        conn.className = 'conn live';
        text.textContent = `Live · ${new Date(snap.sample.ts * 1000).toLocaleTimeString()}`;
        const h = snap.host;
        document.getElementById('host').replaceChildren(
            el('span', { text: h.hostname }), el('span', { text: `Linux ${h.kernel}` }), el('span', { text: `${h.cores} cores` }),
        );
        tiles.update(snap.sample, h);
        charts.appendLive(snap.sample);
        document.getElementById('ports').replaceChildren(...(h.ports || []).map((p) => el('span', { text: p })));

        const key = JSON.stringify(snap.services.map((s) => [s.group, s.name, s.status]));
        renderServices(snap.services);
        if (key !== lastServices) {
            if (lastServices) loadEvents();
            lastServices = key;
        }
    };
}

selectRange(state.range);
connect();
loadEvents();
loadStorage();
setInterval(loadEvents, 60_000);
setInterval(loadStorage, 300_000);
