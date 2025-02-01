const monitorCanvas = document.getElementById("monitor");
const ctx = monitorCanvas.getContext("2d");

let data = [];
(async () => {

    width = 1000
    height = 600
    monitorCanvas.width = width;
    monitorCanvas.height = height;

    const maxCPU = 100;
    const barCount = 20;
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

            // Draw CPU usage bar (Red)
            ctx.fillStyle = "red";
            ctx.fillRect(x, 350 - cpuHeight, barWidth, cpuHeight);

            // Draw Temperature bar (Blue)
            ctx.fillStyle = "blue";
            ctx.fillRect(x, 550, barWidth, -tempHeight);

            // Draw CPU usage percentage text
            ctx.fillStyle = "white";
            ctx.font = "12px Arial";
            ctx.fillText(item.cpu_usage, x + barWidth / 4, 370);

            // Draw Temperature text
            ctx.fillStyle = "white";
            ctx.fillText(`${temperatureValue}°C`, x + barWidth / 10, 540);
        });

        requestAnimationFrame(drawGraph);
    }

    function fetchData() {
        const eventSource = new EventSource('http://raspberrypi.local:7000/system-info/sse');

        eventSource.onmessage = (event) => {
            console.log('Received SSE update:', event.data);
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


