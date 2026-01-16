/**
 * 使用统计看板前端逻辑
 */

// API 基础路径
const API_BASE = '';

// 当前时间范围
let currentTimeRange = '1h';

// 图表实例
let modelChart = null;
let tokenChart = null;

// WebSocket 连接
let ws = null;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initTimeFilter();
    initWebSocket();
    loadAllData();
});

// 初始化时间筛选器
function initTimeFilter() {
    const buttons = document.querySelectorAll('.time-filter button');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTimeRange = btn.dataset.range;
            loadAllData();
        });
    });
}

// 获取时间范围参数
function getTimeParams() {
    const now = new Date();
    let startTime = null;

    switch (currentTimeRange) {
        case '1h':
            startTime = new Date(now - 60 * 60 * 1000);
            break;
        case '24h':
            startTime = new Date(now - 24 * 60 * 60 * 1000);
            break;
        case '7d':
            startTime = new Date(now - 7 * 24 * 60 * 60 * 1000);
            break;
        case '30d':
            startTime = new Date(now - 30 * 24 * 60 * 60 * 1000);
            break;
        case 'all':
            return {};
    }

    return startTime ? { startTime: startTime.toISOString() } : {};
}

// 初始化 WebSocket
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        document.getElementById('connection-status').textContent = '已连接';
        document.querySelector('.status-dot').style.background = '#22c55e';
    };

    ws.onclose = () => {
        document.getElementById('connection-status').textContent = '已断开';
        document.querySelector('.status-dot').style.background = '#ef4444';
        // 尝试重连
        setTimeout(initWebSocket, 5000);
    };

    ws.onerror = () => {
        document.getElementById('connection-status').textContent = '连接错误';
        document.querySelector('.status-dot').style.background = '#f59e0b';
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (e) {
            console.error('WebSocket message parse error:', e);
        }
    };
}

// 处理 WebSocket 消息
function handleWebSocketMessage(message) {
    if (message.event === 'realtime_stats') {
        updateRealtimeStats(message.data);
    }
    // 收到新请求事件时刷新数据
    if (message.event === 'request_complete' || message.event === 'request_error' || message.event === 'request_start') {
        loadAllData();
    }
}

// 更新实时统计
function updateRealtimeStats(data) {
    document.getElementById('pending-requests').textContent = data.pending_requests || 0;
    document.getElementById('requests-last-minute').textContent = data.requests_last_minute || 0;
    document.getElementById('errors-last-minute').textContent = data.errors_last_minute || 0;
    document.getElementById('avg-response-time').textContent =
        data.avg_response_time ? `${Math.round(data.avg_response_time)}ms` : '0ms';
    document.getElementById('connected-clients').textContent = data.connected_clients || 0;
}

// 加载所有数据
async function loadAllData() {
    try {
        await Promise.all([
            loadSummary(),
            loadModelStats(),
            loadTokenTrend(),
            loadProviderRanking(),
            loadRecentRequests()
        ]);
    } catch (error) {
        showError('加载数据失败: ' + error.message);
    }
}

// 显示错误
function showError(message) {
    const container = document.getElementById('error-container');
    container.innerHTML = `<div class="error-message">${message}</div>`;
    setTimeout(() => {
        container.innerHTML = '';
    }, 5000);
}

// 格式化数字
function formatNumber(num) {
    if (num === null || num === undefined) return '-';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

// 格式化成本
function formatCost(cost) {
    if (cost === null || cost === undefined) return '-';
    return '$' + cost.toFixed(4);
}

// 格式化时间 (UTC+8)
function formatTime(timestamp) {
    const date = new Date(timestamp);
    // 转换为 UTC+8
    const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8Date.toISOString().slice(11, 19);
}

// 截断 UUID
function shortUuid(uuid) {
    if (!uuid) return '-';
    return uuid.substring(0, 8) + '...';
}

// 加载总体统计
async function loadSummary() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/summary?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;

    document.getElementById('total-requests').textContent = formatNumber(data.total_requests);

    const successRate = data.total_requests > 0
        ? ((data.success_count / data.total_requests) * 100).toFixed(1)
        : 0;
    document.getElementById('success-rate').textContent = `成功率: ${successRate}%`;

    const totalTokens = (data.total_input_tokens || 0) + (data.total_output_tokens || 0);
    document.getElementById('total-tokens').textContent = formatNumber(totalTokens);
    document.getElementById('tokens-breakdown').textContent =
        `输入: ${formatNumber(data.total_input_tokens)} / 输出: ${formatNumber(data.total_output_tokens)}`;

    document.getElementById('total-cost').textContent = formatCost(data.total_cost);
    document.getElementById('avg-response').textContent =
        data.avg_response_time ? Math.round(data.avg_response_time) : '-';

    document.getElementById('unique-models').textContent = data.unique_models || 0;
    document.getElementById('unique-providers').textContent =
        `${data.unique_providers || 0} 个活跃账号`;
}

// 加载模型统计
async function loadModelStats() {
    const params = new URLSearchParams({ ...getTimeParams(), limit: 10 });
    const response = await fetch(`${API_BASE}/api/stats/models?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;

    // 更新图表
    const ctx = document.getElementById('model-chart').getContext('2d');

    if (modelChart) {
        modelChart.destroy();
    }

    const colors = [
        '#4f46e5', '#7c3aed', '#ec4899', '#f59e0b', '#22c55e',
        '#06b6d4', '#3b82f6', '#8b5cf6', '#f43f5e', '#84cc16'
    ];

    modelChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.map(d => d.model || 'Unknown'),
            datasets: [{
                data: data.map(d => d.total_requests),
                backgroundColor: colors.slice(0, data.length),
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#9ca3af',
                        font: { size: 11 },
                        padding: 10
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const item = data[context.dataIndex];
                            return [
                                `请求数: ${formatNumber(item.total_requests)}`,
                                `Tokens: ${formatNumber((item.total_input_tokens || 0) + (item.total_output_tokens || 0))}`,
                                `成本: ${formatCost(item.total_cost)}`
                            ];
                        }
                    }
                }
            }
        }
    });
}

// 加载 Token 趋势
async function loadTokenTrend() {
    // 固定使用分钟粒度，过去1小时
    const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ startTime, granularity: 'minute' });
    const response = await fetch(`${API_BASE}/api/stats/tokens/trend?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;

    const ctx = document.getElementById('token-chart').getContext('2d');

    if (tokenChart) {
        tokenChart.destroy();
    }

    tokenChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => {
                // 解析时间并转换为 UTC+8
                const [datePart, timePart] = d.time_bucket.split(' ');
                const date = new Date(datePart + 'T' + timePart + ':00Z');
                const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                return utc8Date.toISOString().slice(11, 16); // HH:MM
            }),
            datasets: [
                {
                    label: '输入 Tokens',
                    data: data.map(d => d.input_tokens || 0),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4
                },
                {
                    label: '输出 Tokens',
                    data: data.map(d => d.output_tokens || 0),
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    fill: true,
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#9ca3af'
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#6b7280',
                        maxTicksLimit: 12
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#6b7280',
                        callback: (value) => formatNumber(value)
                    }
                }
            }
        }
    });
}

// 加载 Provider 排行
async function loadProviderRanking() {
    const response = await fetch(`${API_BASE}/api/stats/providers?limit=20`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    const tbody = document.getElementById('provider-table');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无数据</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => `
        <tr>
            <td>${item.provider_type || '-'}</td>
            <td class="uuid-short" title="${item.provider_uuid}">${shortUuid(item.provider_uuid)}</td>
            <td>${formatNumber(item.total_requests)}</td>
            <td>
                <span class="badge ${item.success_rate >= 95 ? 'badge-success' : item.success_rate >= 80 ? 'badge-warning' : 'badge-error'}">
                    ${item.success_rate || 0}%
                </span>
            </td>
            <td>${formatNumber(item.total_tokens)}</td>
            <td class="cost-value">${formatCost(item.total_cost)}</td>
        </tr>
    `).join('');
}

// 加载最近请求
async function loadRecentRequests() {
    const response = await fetch(`${API_BASE}/api/stats/recent?limit=50`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    const tbody = document.getElementById('recent-table');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">暂无数据</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => {
        const statusClass = item.status === 'success' ? 'badge-success'
            : item.status === 'error' ? 'badge-error'
            : 'badge-warning';
        const statusText = item.status === 'success' ? '成功'
            : item.status === 'error' ? '失败'
            : '处理中';

        return `
            <tr>
                <td>${formatTime(item.timestamp)}</td>
                <td>${item.model || '-'}</td>
                <td><span class="badge ${statusClass}">${statusText}</span></td>
                <td>${formatNumber((item.input_tokens || 0) + (item.output_tokens || 0))}</td>
                <td>${item.response_time_ms ? item.response_time_ms + 'ms' : '-'}</td>
            </tr>
        `;
    }).join('');
}

// 定期刷新数据
setInterval(() => {
    loadSummary();
    loadRecentRequests();
}, 30000); // 每 30 秒刷新一次
