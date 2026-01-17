const API_BASE = '';
let currentTimeRange = '24h';
let customDateRange = null;
let modelChart = null;
let tokenInputChart = null;
let tokenOutputChart = null;
let tokenDistributionChart = null;
let ws = null;
let flatpickrInstance = null;
let recentData = [];

// 不要全局注册 datalabels 插件，而是在需要的图表中单独启用

document.addEventListener('DOMContentLoaded', () => {
    initTimeFilter();
    initWebSocket();
    initDatePicker();
    initModal();
    loadAllData();


    window.addEventListener('theme-changed', () => {
        if (modelChart) loadModelStats();
        if (tokenInputChart || tokenOutputChart) loadTokenTrend();
        if (tokenDistributionChart) loadTokenDistribution();
    });
});

function initDatePicker() {
    flatpickrInstance = flatpickr("#date-picker", {
        mode: "range",
        dateFormat: "Y-m-d",
        onClose: (selectedDates) => {
            if (selectedDates.length === 2) {
                customDateRange = {
                    start: selectedDates[0],
                    end: selectedDates[1]
                };
                currentTimeRange = 'custom';
                
                const buttons = document.querySelectorAll('.time-filter button');
                buttons.forEach(b => {
                    b.classList.remove('active', 'bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-primary-600', 'dark:text-primary-400');
                    b.classList.add('text-slate-500');
                });
                const customBtn = document.getElementById('custom-range-btn');
                customBtn.classList.add('active', 'bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-primary-600', 'dark:text-primary-400');
                customBtn.classList.remove('text-slate-500');
                
                loadAllData();
            }
        }
    });
}

function initModal() {
    const modal = document.getElementById('log-detail-modal');
    const closeBtns = [
        document.getElementById('close-modal'),
        document.getElementById('modal-close-btn')
    ];
    
    closeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        });
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    });
}

function initTimeFilter() {
    const buttons = document.querySelectorAll('.time-filter button');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.range === 'custom') {
                flatpickrInstance.open();
                return;
            }
            
            buttons.forEach(b => {
                b.classList.remove('active', 'bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-primary-600', 'dark:text-primary-400');
                b.classList.add('text-slate-500');
            });
            
            btn.classList.add('active', 'bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-primary-600', 'dark:text-primary-400');
            btn.classList.remove('text-slate-500');
            
            currentTimeRange = btn.dataset.range;
            loadAllData();
        });
    });
    
    const activeBtn = document.querySelector('.time-filter button.active');
    if (activeBtn) {
        activeBtn.classList.add('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-primary-600', 'dark:text-primary-400');
        activeBtn.classList.remove('text-slate-500');
    }
}

function getTimeParams() {
    const now = new Date();
    let startTime = null;
    let endTime = null;

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
        case 'custom':
            if (customDateRange) {
                startTime = new Date(customDateRange.start);
                startTime.setHours(0, 0, 0, 0);
                endTime = new Date(customDateRange.end);
                endTime.setHours(23, 59, 59, 999);
            }
            break;
        case 'all':
            return {};
    }

    const params = {};
    if (startTime) params.startTime = startTime.toISOString();
    if (endTime) params.endTime = endTime.toISOString();
    return params;
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = 'Connected';
        const dots = document.querySelectorAll('.status-dot-pulse, .relative.inline-flex.rounded-full.h-3.w-3');
        dots.forEach(dot => {
            dot.classList.remove('bg-red-500', 'bg-amber-500');
            dot.classList.add('bg-green-500');
        });
    };

    ws.onclose = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = 'Disconnected';
        const dots = document.querySelectorAll('.status-dot-pulse, .relative.inline-flex.rounded-full.h-3.w-3');
        dots.forEach(dot => {
            dot.classList.remove('bg-green-500', 'bg-amber-500');
            dot.classList.add('bg-red-500');
        });
        setTimeout(initWebSocket, 5000);
    };

    ws.onerror = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = 'Error';
        const dots = document.querySelectorAll('.status-dot-pulse, .relative.inline-flex.rounded-full.h-3.w-3');
        dots.forEach(dot => {
            dot.classList.remove('bg-green-500', 'bg-red-500');
            dot.classList.add('bg-amber-500');
        });
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

function handleWebSocketMessage(message) {
    if (message.event === 'realtime_stats') {
        updateRealtimeStats(message.data);
    }
    if (['request_complete', 'request_error', 'request_start'].includes(message.event)) {
        loadAllData();
    }
}

function updateRealtimeStats(data) {
    document.getElementById('pending-requests').textContent = data.pending_requests || 0;
    document.getElementById('requests-last-minute').textContent = data.requests_last_minute || 0;
    document.getElementById('errors-last-minute').textContent = data.errors_last_minute || 0;
    document.getElementById('avg-response-time').textContent =
        data.avg_response_time ? `${Math.round(data.avg_response_time)}ms` : '0ms';
    document.getElementById('connected-clients').textContent = data.connected_clients || 0;
}

async function loadAllData() {
    try {
        await Promise.all([
            loadSummary(),
            loadTokenAnalytics(),
            loadModelStats(),
            loadTokenTrend(),
            loadTokenDistribution(),
            loadTokenEfficiency(),
            loadProviderRanking(),
            loadRecentRequests()
        ]);
    } catch (error) {
        showError('Failed to load data: ' + error.message);
    }
}

function showError(message) {
    const container = document.getElementById('error-container');
    container.innerHTML = `
        <div class="bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl flex items-center gap-3 animate-bounce">
            <i data-lucide="alert-circle" class="w-5 h-5"></i>
            <span class="text-sm font-medium">${message}</span>
        </div>
    `;
    lucide.createIcons();
    setTimeout(() => {
        container.innerHTML = '';
    }, 5000);
}

function formatNumber(num) {
    if (num === null || num === undefined) return '-';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

function formatCost(cost) {
    if (cost === null || cost === undefined) return '-';
    return '$' + cost.toFixed(4);
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8Date.toISOString().slice(11, 19);
}

function shortUuid(uuid) {
    if (!uuid) return '-';
    return uuid.substring(0, 8) + '...';
}

async function loadSummary() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/summary?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    const totalRequestsEl = document.getElementById('total-requests');
    totalRequestsEl.textContent = formatNumber(data.total_requests);
    totalRequestsEl.classList.remove('skeleton', 'w-20', 'h-8');

    const successRate = data.total_requests > 0
        ? ((data.success_count / data.total_requests) * 100).toFixed(1)
        : 0;
    
    const rateEl = document.getElementById('success-rate');
    rateEl.textContent = `Success Rate: ${successRate}%`;
    rateEl.className = `text-xs font-medium ${successRate >= 95 ? 'text-green-500' : successRate >= 80 ? 'text-amber-500' : 'text-red-500'}`;

    const totalTokens = (data.total_input_tokens || 0) + (data.total_output_tokens || 0);
    const totalTokensEl = document.getElementById('total-tokens');
    totalTokensEl.textContent = formatNumber(totalTokens);
    totalTokensEl.classList.remove('skeleton', 'w-24', 'h-8');
    
    document.getElementById('tokens-breakdown').textContent =
        `In: ${formatNumber(data.total_input_tokens)} / Out: ${formatNumber(data.total_output_tokens)}`;

    const totalCostEl = document.getElementById('total-cost');
    totalCostEl.textContent = formatCost(data.total_cost);
    totalCostEl.classList.remove('skeleton', 'w-20', 'h-8');

    const avgResponseEl = document.getElementById('avg-response');
    avgResponseEl.textContent = data.avg_response_time ? Math.round(data.avg_response_time) + 'ms' : '-';
    avgResponseEl.classList.remove('skeleton', 'w-16', 'h-8');

    const uniqueModelsEl = document.getElementById('unique-models');
    uniqueModelsEl.textContent = data.unique_models || 0;
    uniqueModelsEl.classList.remove('skeleton', 'w-12', 'h-8');

    document.getElementById('unique-providers').textContent =
        `${data.unique_providers || 0} Active Accounts`;
}

async function loadTokenAnalytics() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/tokens/analytics?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data.overall;

    // Average tokens per request
    const avgTokensEl = document.getElementById('avg-tokens-per-request');
    avgTokensEl.textContent = formatNumber(Math.round(data.avg_tokens_per_request || 0));
    avgTokensEl.classList.remove('skeleton', 'w-20', 'h-8');

    document.getElementById('avg-tokens-breakdown').textContent =
        `In: ${formatNumber(Math.round(data.avg_input_tokens || 0))} / Out: ${formatNumber(Math.round(data.avg_output_tokens || 0))}`;

    // Input/Output ratio
    const ratioEl = document.getElementById('token-ratio');
    const inputRatio = Math.round(data.input_ratio || 0);
    const outputRatio = Math.round(data.output_ratio || 0);
    ratioEl.textContent = `${inputRatio}% / ${outputRatio}%`;
    ratioEl.classList.remove('skeleton', 'w-24', 'h-8');

    document.getElementById('token-ratio-detail').textContent =
        `Input: ${inputRatio}% | Output: ${outputRatio}%`;

    // Tokens per dollar
    const tokensPerDollarEl = document.getElementById('tokens-per-dollar');
    tokensPerDollarEl.textContent = formatNumber(Math.round(data.tokens_per_dollar || 0));
    tokensPerDollarEl.classList.remove('skeleton', 'w-20', 'h-8');
}

async function loadModelStats() {
    const params = new URLSearchParams({ ...getTimeParams(), limit: 10 });
    const response = await fetch(`${API_BASE}/api/stats/models?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    cachedModelData = data;

    const totalRequests = data.reduce((sum, d) => sum + d.total_requests, 0);
    const totalTokens = data.reduce((sum, d) => sum + (d.total_input_tokens || 0) + (d.total_output_tokens || 0), 0);
    const totalCost = data.reduce((sum, d) => sum + (d.total_cost || 0), 0);

    const ctx = document.getElementById('model-chart').getContext('2d');
    const isDark = document.documentElement.classList.contains('dark');

    if (modelChart) modelChart.destroy();

    const colors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
        '#0ea5e9', '#f43f5e', '#06b6d4', '#84cc16', '#f97316'
    ];

    const centerTextPlugin = {
        id: 'centerText',
        afterDraw: (chart) => {
            if (chart.config.type !== 'doughnut') return;
            const { ctx, chartArea: { top, bottom, left, right, width, height } } = chart;
            ctx.save();
            
            const total = chart.config.data.datasets[0].data.reduce((a, b) => a + b, 0);
            const centerX = left + width / 2;
            const centerY = top + height / 2;
            
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            const isDark = document.documentElement.classList.contains('dark');
            
            ctx.font = 'bold 24px Inter';
            ctx.fillStyle = isDark ? '#f1f5f9' : '#1e293b';
            ctx.fillText(formatNumber(total), centerX, centerY - 8);
            
            ctx.font = '500 11px Inter';
            ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
            ctx.fillText('TOTAL REQUESTS', centerX, centerY + 16);
            
            ctx.restore();
        }
    };


    modelChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.map(d => d.model || 'Unknown'),
            datasets: [{
                data: data.map(d => d.total_requests),
                backgroundColor: colors.slice(0, data.length),
                borderWidth: 2,
                borderColor: isDark ? '#1e293b' : '#ffffff',
                hoverOffset: 12,
                cutout: '75%',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    titleColor: isDark ? '#f1f5f9' : '#1e293b',
                    bodyColor: isDark ? '#9ca3af' : '#4b5563',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    boxPadding: 6,
                    callbacks: {
                        label: (context) => {
                            const item = data[context.dataIndex];
                            const reqPercent = ((item.total_requests / totalRequests) * 100).toFixed(1);
                            const tokens = (item.total_input_tokens || 0) + (item.total_output_tokens || 0);
                            const tokenPercent = ((tokens / totalTokens) * 100).toFixed(1);
                            const costPercent = ((item.total_cost / totalCost) * 100).toFixed(1);

                            return [
                                ` Requests: ${formatNumber(item.total_requests)} (${reqPercent}%)`,
                                ` Tokens: ${formatNumber(tokens)} (${tokenPercent}%)`,
                                ` Cost: ${formatCost(item.total_cost)} (${costPercent}%)`
                            ];
                        }
                    }
                },
                datalabels: { display: false }
            }
        },
        plugins: [centerTextPlugin]
    });

    const legendContainer = document.getElementById('model-legend');
    if (legendContainer) {
        legendContainer.innerHTML = data.map((d, i) => {
            const percent = ((d.total_requests / totalRequests) * 100).toFixed(1);
            return `
                <div class="flex items-center justify-between group cursor-default">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm" style="background-color: ${colors[i % colors.length]}"></div>
                        <span class="text-xs text-slate-600 dark:text-slate-400 truncate group-hover:text-slate-900 dark:group-hover:text-slate-200 transition-colors" title="${d.model}">${d.model || 'Unknown'}</span>
                    </div>
                    <span class="text-xs font-bold text-slate-700 dark:text-slate-300 ml-2">${percent}%</span>
                </div>
            `;
        }).join('');
    }

    updateModelTable(data, totalRequests, totalTokens, totalCost, colors);
}

function updateModelTable(data, totalRequests, totalTokens, totalCost, colors) {
    const tbody = document.getElementById('model-table');

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-slate-500">No data available</td></tr>';
        return;
    }

    tbody.innerHTML = data.map((item, i) => {
        const reqPercent = ((item.total_requests / totalRequests) * 100).toFixed(1);
        const tokens = (item.total_input_tokens || 0) + (item.total_output_tokens || 0);
        const tokenPercent = ((tokens / totalTokens) * 100).toFixed(1);
        const costPercent = ((item.total_cost / totalCost) * 100).toFixed(1);

        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                <td class="py-2.5 font-medium text-xs">
                    <div class="flex items-center gap-2">
                        <div class="w-2 h-2 rounded-full flex-shrink-0" style="background-color: ${colors[i % colors.length]}"></div>
                        <span class="truncate max-w-[150px] group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors" title="${item.model}">${item.model || 'Unknown'}</span>
                    </div>
                </td>
                <td class="py-2.5 text-right">
                    <div class="flex flex-col items-end">
                        <span class="font-semibold text-xs">${formatNumber(item.total_requests)}</span>
                        <span class="text-[10px] text-slate-500">${reqPercent}%</span>
                    </div>
                </td>
                <td class="py-2.5 text-right">
                    <div class="flex flex-col items-end">
                        <span class="font-semibold text-xs">${formatNumber(tokens)}</span>
                        <span class="text-[10px] text-slate-500">${tokenPercent}%</span>
                    </div>
                </td>
                <td class="py-2.5 text-right">
                    <div class="flex flex-col items-end">
                        <span class="font-semibold text-xs text-green-600 dark:text-green-400">${formatCost(item.total_cost)}</span>
                        <span class="text-[10px] text-slate-500">${costPercent}%</span>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function loadTokenTrend() {
    const timeParams = getTimeParams();
    let startTime = timeParams.startTime;
    let endTime = timeParams.endTime;
    let granularity = 'minute';

    if (!startTime) {
        startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    } else {
        const start = new Date(startTime);
        const end = endTime ? new Date(endTime) : new Date();
        const diffHours = (end - start) / (1000 * 60 * 60);

        if (diffHours > 48) granularity = 'hour';
        if (diffHours > 24 * 7) granularity = 'day';
    }

    const params = new URLSearchParams({ startTime, granularity });
    if (endTime) params.append('endTime', endTime);

    const response = await fetch(`${API_BASE}/api/stats/tokens/trend?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    const isDark = document.documentElement.classList.contains('dark');

    const labels = data.map(d => {
        const date = new Date(d.time_bucket.replace(' ', 'T') + 'Z');
        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);

        if (granularity === 'day') return utc8Date.toISOString().slice(5, 10);
        if (granularity === 'hour') return utc8Date.toISOString().slice(5, 13).replace('T', ' ');
        return utc8Date.toISOString().slice(11, 16);
    });

    const ctxInput = document.getElementById('token-input-chart').getContext('2d');
    if (tokenInputChart) tokenInputChart.destroy();

    const gradientIn = ctxInput.createLinearGradient(0, 0, 0, 300);
    gradientIn.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
    gradientIn.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

    tokenInputChart = new Chart(ctxInput, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Input Tokens',
                data: data.map(d => d.input_tokens || 0),
                borderColor: '#6366f1',
                backgroundColor: gradientIn,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#6366f1',
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? 'rgba(30, 41, 59, 0.9)' : 'rgba(255, 255, 255, 0.9)',
                    titleColor: isDark ? '#f1f5f9' : '#1e293b',
                    bodyColor: isDark ? '#cbd5e1' : '#475569',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    callbacks: {
                        label: (context) => `Input: ${formatNumber(context.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    display: false,
                    min: 0
                }
            }
        }
    });

    const ctxOutput = document.getElementById('token-output-chart').getContext('2d');
    if (tokenOutputChart) tokenOutputChart.destroy();

    const gradientOut = ctxOutput.createLinearGradient(0, 0, 0, 300);
    gradientOut.addColorStop(0, 'rgba(16, 185, 129, 0.4)');
    gradientOut.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    tokenOutputChart = new Chart(ctxOutput, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Output Tokens',
                data: data.map(d => d.output_tokens || 0),
                borderColor: '#10b981',
                backgroundColor: gradientOut,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#10b981',
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? 'rgba(30, 41, 59, 0.9)' : 'rgba(255, 255, 255, 0.9)',
                    titleColor: isDark ? '#f1f5f9' : '#1e293b',
                    bodyColor: isDark ? '#cbd5e1' : '#475569',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    callbacks: {
                        label: (context) => `Output: ${formatNumber(context.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    display: false,
                    min: 0
                }
            }
        }
    });
}

async function loadTokenDistribution() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/tokens/analytics?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data.distribution;
    cachedDistributionData = data; // Cache for export
    const isDark = document.documentElement.classList.contains('dark');

    const ctx = document.getElementById('token-distribution-chart').getContext('2d');
    if (tokenDistributionChart) tokenDistributionChart.destroy();

    const colors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
        '#06b6d4', '#3b82f6'
    ];

    tokenDistributionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => d.token_range),
            datasets: [{
                label: 'Requests',
                data: data.map(d => d.request_count),
                backgroundColor: colors,
                borderRadius: 8,
                barThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    titleColor: isDark ? '#f1f5f9' : '#1e293b',
                    bodyColor: isDark ? '#9ca3af' : '#4b5563',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: (context) => {
                            const total = data.reduce((sum, d) => sum + d.request_count, 0);
                            const percent = ((context.parsed.y / total) * 100).toFixed(1);
                            return ` Requests: ${formatNumber(context.parsed.y)} (${percent}%)`;
                        }
                    }
                },
                datalabels: {
                    display: false
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: isDark ? '#64748b' : '#94a3b8',
                        font: { size: 11 }
                    }
                },
                y: {
                    grid: {
                        color: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'
                    },
                    ticks: {
                        color: isDark ? '#64748b' : '#94a3b8',
                        callback: (value) => formatNumber(value)
                    }
                }
            }
        }
    });
}

async function loadTokenEfficiency() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/tokens/analytics?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data.by_model;
    cachedEfficiencyData = data; // Cache for export
    const tbody = document.getElementById('efficiency-table');

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-slate-500">No data available</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => {
        const avgTokens = Math.round(item.avg_tokens_per_request || 0);
        const inputRatio = Math.round(item.input_ratio || 0);
        const outputRatio = 100 - inputRatio;
        const costPer1k = item.cost_per_1k_tokens || 0;
        const costPer1m = costPer1k * 1000; // Convert to per 1M tokens
        const tokensPerDollar = Math.round(item.tokens_per_dollar || 0);

        // Efficiency score: higher tokens per dollar is better
        const efficiencyClass = tokensPerDollar > 100000 ? 'text-green-600 dark:text-green-400'
            : tokensPerDollar > 50000 ? 'text-amber-600 dark:text-amber-400'
            : 'text-red-600 dark:text-red-400';

        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                <td class="py-3 font-medium">${item.model || 'Unknown'}</td>
                <td class="py-3 text-right font-semibold">${formatNumber(avgTokens)}</td>
                <td class="py-3 text-right text-slate-500">${inputRatio}% / ${outputRatio}%</td>
                <td class="py-3 text-right text-slate-500">$${costPer1m.toFixed(2)}</td>
                <td class="py-3 text-right font-semibold ${efficiencyClass}">${formatNumber(tokensPerDollar)}</td>
            </tr>
        `;
    }).join('');
}

async function loadProviderRanking() {
    const params = new URLSearchParams({ ...getTimeParams(), limit: 20 });
    const response = await fetch(`${API_BASE}/api/stats/providers?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    const data = result.data;
    const container = document.getElementById('provider-cards');

    if (data.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-500 py-8">No data available</div>';
        return;
    }

    container.innerHTML = data.map(item => {
        const rate = item.success_rate || 0;
        const badgeClass = rate >= 95 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : rate >= 80 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';

        const healthIcon = rate >= 95 ? 'check-circle' : rate >= 80 ? 'alert-circle' : 'x-circle';
        const healthColor = rate >= 95 ? 'text-green-500' : rate >= 80 ? 'text-amber-500' : 'text-red-500';

        return `
            <div class="bg-white dark:bg-slate-800/50 rounded-lg p-2.5 border border-slate-200 dark:border-slate-700 hover:shadow-md transition-all hover:scale-[1.01] cursor-pointer">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                        <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center flex-shrink-0">
                            <i data-lucide="shield" class="w-3.5 h-3.5 text-white"></i>
                        </div>
                        <div class="min-w-0 flex-1">
                            <h4 class="font-semibold text-[11px] truncate">${item.provider_type || 'Unknown'}</h4>
                            <p class="text-[9px] font-mono text-slate-500 truncate" title="${item.provider_uuid}">${shortUuid(item.provider_uuid)}</p>
                        </div>
                    </div>
                    <i data-lucide="${healthIcon}" class="w-3.5 h-3.5 ${healthColor} flex-shrink-0"></i>
                </div>

                <div class="grid grid-cols-3 gap-1.5 text-center">
                    <div>
                        <p class="text-[9px] text-slate-500 mb-0.5">Reqs</p>
                        <p class="text-xs font-bold">${formatNumber(item.total_requests)}</p>
                    </div>
                    <div>
                        <p class="text-[9px] text-slate-500 mb-0.5">Rate</p>
                        <span class="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-bold ${badgeClass}">
                            ${rate}%
                        </span>
                    </div>
                    <div>
                        <p class="text-[9px] text-slate-500 mb-0.5">Cost</p>
                        <p class="text-xs font-bold text-green-600 dark:text-green-400">${formatCost(item.total_cost)}</p>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    lucide.createIcons();
}

async function loadRecentRequests() {
    const params = new URLSearchParams(getTimeParams());
    const response = await fetch(`${API_BASE}/api/stats/recent?${params}`);
    const result = await response.json();

    if (!result.success) throw new Error(result.error);

    recentData = result.data;
    const tbody = document.getElementById('recent-table');

    if (recentData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500">No requests found</td></tr>';
        return;
    }

    tbody.innerHTML = recentData.map((item, index) => {
        const statusClass = item.status === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : item.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
            
        const statusText = item.status === 'success' ? 'Success'
            : item.status === 'error' ? 'Failed'
            : 'Processing';
            
        const iconName = item.status === 'success' ? 'check-circle' : item.status === 'error' ? 'x-circle' : 'loader';

        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group" onclick="showRequestDetail(${index})">
                <td class="px-6 py-4 text-slate-500 group-hover:text-primary-500 transition-colors">${formatTime(item.timestamp)}</td>
                <td class="px-6 py-4 font-medium truncate max-w-[150px]" title="${item.model || '-'}">${item.model || '-'}</td>
                <td class="px-6 py-4">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${statusClass}">
                        <i data-lucide="${iconName}" class="w-3 h-3"></i>
                        ${statusText}
                    </span>
                </td>
                <td class="px-6 py-4 text-slate-500">${formatNumber((item.input_tokens || 0) + (item.output_tokens || 0))}</td>
                <td class="px-6 py-4 font-medium">${item.response_time_ms ? item.response_time_ms + 'ms' : '-'}</td>
            </tr>
        `;
    }).join('');
    
    lucide.createIcons();
}

function showRequestDetail(index) {
    const item = recentData[index];
    if (!item) return;
    
    const modal = document.getElementById('log-detail-modal');
    const statusIcon = document.getElementById('modal-status-icon');
    const statusBadge = document.getElementById('modal-status-badge');
    const errorContainer = document.getElementById('modal-error-container');
    
    document.getElementById('modal-timestamp').textContent = new Date(item.timestamp).toLocaleString();
    document.getElementById('modal-model').textContent = item.model || '-';
    document.getElementById('modal-tokens').textContent = `${(item.input_tokens || 0) + (item.output_tokens || 0)} / ${item.input_tokens || 0} / ${item.output_tokens || 0}`;
    document.getElementById('modal-latency').textContent = item.response_time_ms ? item.response_time_ms + 'ms' : '-';
    document.getElementById('modal-provider-type').textContent = item.provider_type || '-';
    document.getElementById('modal-provider-uuid').textContent = item.provider_uuid || '-';
    
    const costContainer = document.getElementById('modal-cost-container');
    if (item.cost !== undefined && item.cost !== null) {
        document.getElementById('modal-cost').textContent = formatCost(item.cost);
        costContainer.classList.remove('hidden');
    } else {
        costContainer.classList.add('hidden');
    }
    
    if (item.status === 'success') {
        statusIcon.className = 'w-12 h-12 rounded-2xl bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center';
        statusIcon.innerHTML = '<i data-lucide="check-circle" class="w-7 h-7"></i>';
        statusBadge.innerHTML = '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Success</span>';
        errorContainer.classList.add('hidden');
    } else if (item.status === 'error') {
        statusIcon.className = 'w-12 h-12 rounded-2xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center';
        statusIcon.innerHTML = '<i data-lucide="alert-triangle" class="w-7 h-7"></i>';
        statusBadge.innerHTML = '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Failed</span>';
        errorContainer.classList.remove('hidden');
        document.getElementById('modal-error-text').textContent = item.error_message || 'Unknown error occurred';
    } else {
        statusIcon.className = 'w-12 h-12 rounded-2xl bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center';
        statusIcon.innerHTML = '<i data-lucide="loader" class="w-7 h-7 animate-spin"></i>';
        statusBadge.innerHTML = '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Processing</span>';
        errorContainer.classList.add('hidden');
    }
    
    document.getElementById('modal-json').textContent = JSON.stringify(item, null, 2);
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    lucide.createIcons();
}

setInterval(() => {
    loadSummary();
    loadRecentRequests();
}, 30000);

let cachedModelData = [];
let cachedEfficiencyData = [];
let cachedDistributionData = [];

function exportData(type, format) {
    let data = [];
    let filename = '';

    switch (type) {
        case 'models':
            data = cachedModelData;
            filename = `model-distribution-${new Date().toISOString().slice(0, 10)}`;
            break;
        case 'efficiency':
            data = cachedEfficiencyData;
            filename = `token-efficiency-${new Date().toISOString().slice(0, 10)}`;
            break;
        case 'distribution':
            data = cachedDistributionData;
            filename = `token-distribution-${new Date().toISOString().slice(0, 10)}`;
            break;
        case 'recent':
            data = recentData;
            filename = `recent-requests-${new Date().toISOString().slice(0, 10)}`;
            break;
        default:
            showError('Unknown export type');
            return;
    }

    if (!data || data.length === 0) {
        showError('No data available to export');
        return;
    }

    if (format === 'csv') {
        exportToCSV(data, filename);
    } else if (format === 'json') {
        exportToJSON(data, filename);
    }
}

function exportToCSV(data, filename) {
    if (data.length === 0) return;

    // Get headers from first object
    const headers = Object.keys(data[0]);

    // Create CSV content
    let csv = headers.join(',') + '\n';

    data.forEach(row => {
        const values = headers.map(header => {
            const value = row[header];
            // Handle values that contain commas or quotes
            if (value === null || value === undefined) return '';
            const stringValue = String(value);
            if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
                return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
        });
        csv += values.join(',') + '\n';
    });

    // Download
    downloadFile(csv, `${filename}.csv`, 'text/csv');
}

function exportToJSON(data, filename) {
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, `${filename}.json`, 'application/json');
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
