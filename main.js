const monitorCanvas = document.getElementById("monitor");
const ctx = monitorCanvas.getContext("2d");

let data = [];
(async () => {

    width = 1000
    height = 900
    monitorCanvas.width = width;
    monitorCanvas.height = height;

    const maxCPU = 100;
    const barCount = 60;
    const maxMemory = 4045;
    const maxDiskWrite = 8000;
    const barWidth = width / barCount - 2;
    const spacing = 1;

    function drawGraph() {
        ctx.clearRect(0, 0, monitorCanvas.width, monitorCanvas.height);

        data.forEach((item, index) => {
            const x = index * (barWidth + spacing);
            const cpuHeight = (parseInt(item.cpu_usage) / maxCPU) * 300;
            const temperatureValue = parseFloat(item.temperature);
            const tempHeight = (temperatureValue / 100) * 300

            const memoryPercentage = (item.memory_used / item.memory_total) * 100;
            const memoryHeight = (memoryPercentage / 100) * 300;

            // Draw CPU usage bar (Red)
            ctx.fillStyle = "red";
            ctx.fillRect(x, 200 - cpuHeight, barWidth, cpuHeight);

            // Draw Temperature bar (Blue)
            ctx.fillStyle = "blue";
            ctx.fillRect(x, 400, barWidth, -tempHeight);

            // Draw Memory usage bar (Green)
            ctx.fillStyle = "green";
            ctx.fillRect(x, 610, barWidth, -memoryHeight);

            // Draw CPU usage percentage text
            ctx.fillStyle = "white";
            ctx.font = "12px Arial";
            ctx.fillText(item.cpu_usage, x + barWidth / 4, 220);

            // Draw Temperature text
            ctx.fillStyle = "white";
            ctx.fillText(`${temperatureValue}°C`, x + barWidth / 10, 390);

            // Draw Memory usage percentage text
            ctx.fillStyle = "white";
            ctx.fillText(`${memoryPercentage.toFixed(1)}%`, x + barWidth / 10, 600); // Text just below the memory bar
        });

        requestAnimationFrame(drawGraph);
    }

    function fetchData() {
        const eventSource = new EventSource('http://raspberrypi.local:7000/system-info/sse');

        eventSource.onmessage = (event) => {
            console.log(`${new Date(Date.now()).toLocaleString()}_Received SSE update.`);
            data = JSON.parse(event.data);
        };

        eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            eventSource.close();
        };
    }

    fetchData();
    drawGraph();

})()


