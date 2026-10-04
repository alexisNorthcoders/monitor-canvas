# monitor-canvas

A dashboard for the Raspberry Pi: live readings, history, and the state of every service it runs. Served by nginx on the LAN at `http://raspberrypi.local/monitor-canvas/`.

It is two files, `index.html` and `main.js`, with [uPlot](https://github.com/leeoniya/uPlot) for the charts (loaded from jsDelivr). No build step.

## What it shows

- **Stat tiles**: CPU, temperature (against the 85 °C throttle point), memory and swap, disk space, load per core, network traffic and uptime, updated every 5 seconds.
- **Charts**: CPU, temperature, memory, load, disk I/O and network, over 15 minutes to 2 years. Hovering one shows the values at that moment on every chart. Longer ranges show the average with the peak as a shaded band.
- **Services**: systemd units, pm2 processes (CPU, memory, uptime, restarts), Docker containers, Redis (memory, keys, clients, hit rate) and SQLite database sizes. Problems are listed first.
- **Recent status changes**: when a service went up, down or stopped.
- **Metrics storage**: how big the history is, and how full each retention tier is.
- **Listening ports** reachable from the LAN.

## Where the data comes from

Everything is read from [go-server](https://github.com/alexisNorthcoders/go-server)'s `monitor` package on port 8080 of the same machine:

| Endpoint | Used for |
|---|---|
| `GET /monitor/stream` | Server-sent events: the tiles, the services and the 15-minute live chart |
| `GET /monitor/history?range=` | The charts, refetched every minute (every 5 minutes past 48 hours) |
| `GET /monitor/events` | Recent status changes |
| `GET /monitor/storage` | Metrics storage |

go-server samples the Pi itself and keeps the history in its own `metrics.db`, pruned to fixed tiers (per minute for 48 hours, 5-minute for 30 days, hourly for 2 years). That keeps the file at a few megabytes for good. See go-server's README for the details. This replaces the old pi_health collector, which posted a reading every minute and kept every one of them.

## Options

Query parameters, mainly for development:

- `?api=http://host:port` reads a different go-server.
- `?range=7d` opens on a range. The last range picked is remembered in the browser.
