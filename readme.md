# monitor-canvas
monitor-canvas is a system monitoring dashboard that displays real-time data from a Raspberry Pi, visualizing metrics such as CPU usage, temperature, and memory usage using a dynamic HTML canvas. The data is sent to the client via Server-Sent Events (SSE) and is stored in an SQLite3 database for persistence.

## Features
Real-time system monitoring using SSE (Server-Sent Events).
CPU usage, temperature, and memory usage displayed as bar charts.
Cron job running on Raspberry Pi to collect system information periodically.
Data is stored in SQLite3 for easy retrieval and historical data analysis.
Client-side visualization built using HTML canvas.

### Project Components
1. Raspberry Pi Cron Job
A cron job is configured to collect system information at regular intervals (every minute) and send it to an API. The data collected includes:

CPU usage
Temperature
Memory usage (used/total)
This data is then stored in an SQLite3 database for persistence.

2. API Server (Node.js + Express)
An Express-based server provides an endpoint to serve system information. The endpoint listens for incoming GET requests and serves the latest system data as JSON. The data is fetched from the SQLite3 database and sent to the client via Server-Sent Events (SSE).

3. SQLite3 Database
The SQLite3 database stores the system data, allowing the API to retrieve the latest system stats.

The database schema includes a table called system_data with the following columns:
timestamp (Date)
cpu_usage (Integer)
temperature (Float)
memory_used (Integer)
memory_total (Integer)

4. Client-side Visualization (HTML Canvas)
The client-side application uses an HTML canvas to visualize the data in real-time. The canvas renders dynamic bar charts that represent the following:

CPU Usage: A red bar indicating CPU usage as a percentage.
Temperature: A blue bar indicating the current system temperature.
Memory Usage: A green bar indicating the percentage of memory used.
Data is fetched from the API using SSE, which ensures that the client receives live updates without having to poll the server repeatedly.