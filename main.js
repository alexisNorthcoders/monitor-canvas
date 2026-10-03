class PiHealthMonitor {
    constructor() {
        this.canvas = document.getElementById("monitor");
        this.ctx = this.canvas.getContext("2d");
        this.data = [];
        this.zoomLevel = 1;
        this.isPaused = false;
        this.eventSource = null;
        this.animationId = null;
        
        // Canvas dimensions
        this.baseWidth = 1200;
        this.baseHeight = 800;
        this.width = this.baseWidth;
        this.height = this.baseHeight;
        
        // Chart configuration
        this.maxCPU = 100;
        this.maxMemory = 100;
        this.maxTemperature = 80;
        this.maxDisk = 100;
        
        // Chart areas
        this.margin = { top: 60, right: 80, bottom: 60, left: 80 };
        this.chartWidth = this.width - this.margin.left - this.margin.right;
        this.chartHeight = this.height - this.margin.top - this.margin.bottom;
        
        // Line graph configuration
        this.dataPoints = 60; // Default to 1 hour of minute data (60 points)
        this.pointSpacing = this.chartWidth / this.dataPoints;
        
        // Colors
        this.colors = {
            cpu: '#ff4757',
            temperature: '#3742fa',
            memory: '#2ed573',
            disk: '#ffa502',
            background: '#1a1a2e',
            grid: 'rgba(255, 255, 255, 0.1)',
            text: '#ffffff',
            axis: 'rgba(255, 255, 255, 0.6)'
        };
        
        this.init();
    }
    
    init() {
        this.setupCanvas();
        this.setupEventListeners();
        this.startDataFetch();
        this.startAnimation();
        this.updateStatusBar();
    }
    
    setupCanvas() {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
    }
    
    setupEventListeners() {
        // Zoom controls
        document.getElementById('zoomIn').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOut').addEventListener('click', () => this.zoomOut());
        
        // Time range selector
        document.getElementById('timeRange').addEventListener('change', (e) => {
            this.changeTimeRange(parseInt(e.target.value));
        });
        
        // Pause/Resume
        document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
        
        // Reset view
        document.getElementById('resetBtn').addEventListener('click', () => this.resetView());
        
        // Mouse wheel zoom
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.deltaY < 0) {
                this.zoomIn();
            } else {
                this.zoomOut();
            }
        });
    }
    
    zoomIn() {
        this.zoomLevel = Math.min(this.zoomLevel * 1.2, 5);
        this.updateCanvasSize();
        this.updateZoomDisplay();
    }
    
    zoomOut() {
        this.zoomLevel = Math.max(this.zoomLevel / 1.2, 0.5);
        this.updateCanvasSize();
        this.updateZoomDisplay();
    }
    
    updateCanvasSize() {
        this.width = Math.round(this.baseWidth * this.zoomLevel);
        this.height = Math.round(this.baseHeight * this.zoomLevel);
        
        this.chartWidth = this.width - this.margin.left - this.margin.right;
        this.chartHeight = this.height - this.margin.top - this.margin.bottom;
        this.pointSpacing = this.chartWidth / this.dataPoints;
        
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
    }
    
    updateZoomDisplay() {
        document.getElementById('zoomLevel').textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
    
    resetView() {
        this.zoomLevel = 1;
        this.updateCanvasSize();
        this.updateZoomDisplay();
    }
    
    togglePause() {
        this.isPaused = !this.isPaused;
        const btn = document.getElementById('pauseBtn');
        btn.textContent = this.isPaused ? 'Resume' : 'Pause';
        btn.style.background = this.isPaused ? 'rgba(255, 107, 107, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    }
    
    changeTimeRange(minutes) {
        // Update data points based on time range
        // Since we collect data every minute, we get 1 point per minute
        this.dataPoints = Math.min(minutes, 10080); // Max 10080 data points (1 week)
        this.pointSpacing = this.chartWidth / this.dataPoints;
        
        console.log(`Changing time range to ${minutes} minutes (${this.dataPoints} data points)`);
        
        // Restart data fetch with new limit
        if (this.eventSource) {
            this.eventSource.close();
        }
        this.startDataFetch();
    }
    
    startDataFetch() {
        // Request data points from the backend based on selected time range
        const dataPoints = this.dataPoints;
        this.eventSource = new EventSource(`http://raspberrypi.local:8080/system-info/sse?limit=${dataPoints}`);
        
        this.eventSource.onmessage = (event) => {
            if (!this.isPaused) {
                const newData = JSON.parse(event.data);
                console.log(`${new Date().toLocaleString()}: Received SSE update with ${newData.length} data points for ${this.dataPoints} minute time range.`);
                this.data = newData;
                this.updateStatusBar();
            }
        };
        
        this.eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            this.updateConnectionStatus(false);
            this.eventSource.close();
            // Attempt to reconnect after 5 seconds
            setTimeout(() => this.startDataFetch(), 5000);
        };
    }
    
    startAnimation() {
        const animate = () => {
            if (!this.isPaused) {
                this.draw();
            }
            this.animationId = requestAnimationFrame(animate);
        };
        animate();
    }
    
    draw() {
        // Clear canvas with gradient background
        this.drawBackground();
        
        if (this.data.length === 0) {
            this.drawNoDataMessage();
            return;
        }
        
        // Draw grid
        this.drawGrid();
        
        // Draw axes
        this.drawAxes();
        
        // Draw data
        this.drawData();
        
        // Draw labels
        this.drawLabels();
    }
    
    drawBackground() {
        const gradient = this.ctx.createLinearGradient(0, 0, 0, this.height);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(1, '#16213e');
        
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, this.width, this.height);
    }
    
    drawGrid() {
        this.ctx.strokeStyle = this.colors.grid;
        this.ctx.lineWidth = 1;
        
        // Horizontal grid lines
        for (let i = 0; i <= 4; i++) {
            const y = this.margin.top + (this.chartHeight / 4) * i;
            this.ctx.beginPath();
            this.ctx.moveTo(this.margin.left, y);
            this.ctx.lineTo(this.margin.left + this.chartWidth, y);
            this.ctx.stroke();
        }
        
        // Vertical grid lines
        for (let i = 0; i <= 10; i++) {
            const x = this.margin.left + (this.chartWidth / 10) * i;
            this.ctx.beginPath();
            this.ctx.moveTo(x, this.margin.top);
            this.ctx.lineTo(x, this.margin.top + this.chartHeight);
            this.ctx.stroke();
        }
    }
    
    drawAxes() {
        this.ctx.strokeStyle = this.colors.axis;
        this.ctx.lineWidth = 2;
        
        // Y-axis
        this.ctx.beginPath();
        this.ctx.moveTo(this.margin.left, this.margin.top);
        this.ctx.lineTo(this.margin.left, this.margin.top + this.chartHeight);
        this.ctx.stroke();
        
        // X-axis
        this.ctx.beginPath();
        this.ctx.moveTo(this.margin.left, this.margin.top + this.chartHeight);
        this.ctx.lineTo(this.margin.left + this.chartWidth, this.margin.top + this.chartHeight);
        this.ctx.stroke();
    }
    
    drawData() {
        const visibleData = this.data.slice(-this.dataPoints);
        
        if (visibleData.length < 2) return; // Need at least 2 points to draw lines
        
        // Draw each metric as a line graph
        this.drawLineGraph(visibleData, 'cpu_usage', this.colors.cpu, this.maxCPU, 0);
        this.drawLineGraph(visibleData, 'temperature', this.colors.temperature, this.maxTemperature, 1);
        this.drawLineGraph(visibleData, 'memory', this.colors.memory, this.maxMemory, 2);
        this.drawLineGraph(visibleData, 'disk', this.colors.disk, this.maxDisk, 3);
    }
    
    drawLineGraph(data, metric, color, maxValue, section) {
        const points = [];
        const sectionHeight = this.chartHeight / 4;
        const sectionTop = this.margin.top + (section * sectionHeight);
        
        // Calculate points for the line
        data.forEach((item, index) => {
            let value = 0;
            
            switch (metric) {
                case 'cpu_usage':
                    value = parseInt(item.cpu_usage) || 0;
                    break;
                case 'temperature':
                    value = parseFloat(item.temperature) || 0;
                    break;
                case 'memory':
                    value = item.memory_total ? (item.memory_used / item.memory_total) * 100 : 0;
                    break;
                case 'disk':
                    const totalDisk = parseFloat(item.disk_used) + parseFloat(item.disk_available);
                    value = totalDisk > 0 ? (parseFloat(item.disk_used) / totalDisk) * 100 : 0;
                    break;
            }
            
            const x = this.margin.left + index * this.pointSpacing;
            const y = sectionTop + sectionHeight - (value / maxValue) * sectionHeight;
            points.push({ x, y, value, index });
        });
        
        if (points.length < 2) return;
        
        // Draw the line with gradient
        this.drawGradientLine(points, color, sectionTop, sectionTop + sectionHeight);
        
        // Draw data points
        this.drawDataPoints(points, color);
        
        // Draw current value label
        if (points.length > 0) {
            const lastPoint = points[points.length - 1];
            this.drawValueLabel(lastPoint, color, metric);
        }
    }
    
    drawGradientLine(points, color, top, bottom) {
        // Create gradient for the line
        const gradient = this.ctx.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, this.darkenColor(color, 0.3));
        
        this.ctx.strokeStyle = gradient;
        this.ctx.lineWidth = 3;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Draw the main line
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        
        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }
        this.ctx.stroke();
        
        // Draw area under the line
        this.ctx.fillStyle = color + '20'; // Add transparency
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, bottom);
        this.ctx.lineTo(points[0].x, points[0].y);
        
        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }
        this.ctx.lineTo(points[points.length - 1].x, bottom);
        this.ctx.closePath();
        this.ctx.fill();
    }
    
    drawDataPoints(points, color) {
        this.ctx.fillStyle = color;
        this.ctx.strokeStyle = this.lightenColor(color, 0.3);
        this.ctx.lineWidth = 2;
        
        // Calculate step based on total points to avoid clutter
        // For large datasets, show fewer points
        const maxVisiblePoints = points.length > 1000 ? 100 : 50;
        const step = Math.max(1, Math.floor(points.length / maxVisiblePoints));
        
        points.forEach((point, index) => {
            // Only draw every nth point to avoid clutter
            if (index % step === 0 || index === points.length - 1) {
                this.ctx.beginPath();
                this.ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI);
                this.ctx.fill();
                this.ctx.stroke();
            }
        });
    }
    
    drawValueLabel(point, color, metric) {
        const labelY = point.y - 10;
        const labelX = point.x + 10;
        
        // Format the value based on metric
        let label = '';
        switch (metric) {
            case 'cpu_usage':
                label = `${point.value}%`;
                break;
            case 'temperature':
                label = `${point.value}°C`;
                break;
            case 'memory':
            case 'disk':
                label = `${point.value.toFixed(1)}%`;
                break;
        }
        
        // Draw background for label
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(labelX - 5, labelY - 15, label.length * 8 + 10, 20);
        
        // Draw label text
        this.ctx.fillStyle = color;
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(label, labelX, labelY);
    }
    
    
    drawLabels() {
        this.ctx.fillStyle = this.colors.text;
        this.ctx.font = '14px Arial';
        this.ctx.textAlign = 'center';
        
        // Y-axis labels
        const labels = ['CPU Usage', 'Temperature', 'Memory Usage', 'Disk Usage'];
        const labelY = this.margin.top + (this.chartHeight / 8);
        
        labels.forEach((label, index) => {
            this.ctx.fillText(label, this.margin.left - 40, labelY + (this.chartHeight / 4) * index);
        });
        
        // X-axis label
        this.ctx.fillText('Time', this.margin.left + this.chartWidth / 2, this.height - 20);
    }
    
    drawNoDataMessage() {
        this.ctx.fillStyle = this.colors.text;
        this.ctx.font = '24px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('No data available', this.width / 2, this.height / 2);
        this.ctx.font = '16px Arial';
        this.ctx.fillText('Waiting for system data...', this.width / 2, this.height / 2 + 30);
    }
    
    updateStatusBar() {
        const now = new Date();
        document.getElementById('lastUpdate').textContent = `Last update: ${now.toLocaleTimeString()}`;
        document.getElementById('dataCount').textContent = `Data points: ${this.data.length}`;
        this.updateConnectionStatus(true);
    }
    
    updateConnectionStatus(connected) {
        const status = document.getElementById('connectionStatus');
        if (connected) {
            status.textContent = 'Connected';
            status.className = 'success';
        } else {
            status.textContent = 'Disconnected';
            status.className = 'error';
        }
    }
    
    // Utility functions
    darkenColor(color, amount) {
        const num = parseInt(color.replace("#", ""), 16);
        const amt = Math.round(2.55 * amount * 100);
        const R = (num >> 16) - amt;
        const G = (num >> 8 & 0x00FF) - amt;
        const B = (num & 0x0000FF) - amt;
        return "#" + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
            (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
            (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }
    
    lightenColor(color, amount) {
        const num = parseInt(color.replace("#", ""), 16);
        const amt = Math.round(2.55 * amount * 100);
        const R = (num >> 16) + amt;
        const G = (num >> 8 & 0x00FF) + amt;
        const B = (num & 0x0000FF) + amt;
        return "#" + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
            (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
            (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }
}

// Initialize the monitor when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new PiHealthMonitor();
});


