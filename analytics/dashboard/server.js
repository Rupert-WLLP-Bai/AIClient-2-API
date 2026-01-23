/**
 * 使用统计看板服务器
 * 提供 RESTful API 和 WebSocket 实时推送
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 数据库路径
const DB_PATH = path.join(__dirname, '../../data/stats.db');
const PROVIDER_POOLS_PATH = path.join(__dirname, '../../configs/provider_pools.json');

// 获取数据库连接
function getDb() {
    return new Database(DB_PATH, { readonly: true });
}

// Cache for provider pools to avoid repeated file reads
let providerPoolsCache = null;
let providerPoolsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute cache

function getProviderSequenceNumber(providerType, providerUuid) {
    try {
        // Refresh cache if expired
        const now = Date.now();
        if (!providerPoolsCache || (now - providerPoolsCacheTime) > CACHE_TTL) {
            providerPoolsCache = JSON.parse(fs.readFileSync(PROVIDER_POOLS_PATH, 'utf8'));
            providerPoolsCacheTime = now;
        }

        const pool = providerPoolsCache[providerType];
        if (!pool) return null;

        const index = pool.findIndex(p => p.uuid === providerUuid);
        return index >= 0 ? index + 1 : null; // 1-based index for display
    } catch (error) {
        console.error('Error reading provider pools:', error);
        return null;
    }
}

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// CORS 支持
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// API 路由

/**
 * 获取总体统计摘要
 */
app.get('/api/stats/summary', (req, res) => {
    try {
        const db = getDb();
        const { startTime, endTime } = req.query;

        let sql = `
            SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(estimated_cost) as total_cost,
                AVG(response_time_ms) as avg_response_time,
                COUNT(DISTINCT model) as unique_models,
                COUNT(DISTINCT provider_uuid) as unique_providers
            FROM request_logs
            WHERE 1=1
        `;

        const params = {};
        if (startTime) {
            sql += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            sql += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }

        const result = db.prepare(sql).get(params);
        db.close();

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error getting summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取模型调用统计
 */
app.get('/api/stats/models', (req, res) => {
    try {
        const db = getDb();
        const { startTime, endTime, limit = 20 } = req.query;

        let sql = `
            SELECT
                model,
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(estimated_cost) as total_cost,
                AVG(response_time_ms) as avg_response_time
            FROM request_logs
            WHERE model IS NOT NULL
        `;

        const params = {};
        if (startTime) {
            sql += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            sql += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }

        sql += ` GROUP BY model ORDER BY total_requests DESC LIMIT @limit`;
        params.limit = parseInt(limit);

        const result = db.prepare(sql).all(params);
        db.close();

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error getting model stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取 Token 使用趋势
 */
app.get('/api/stats/tokens/trend', (req, res) => {
    try {
        const db = getDb();
        const { startTime, endTime, granularity = 'hour' } = req.query;

        let timeFormat;
        let bucketExpression;

        if (granularity === 'day') {
            timeFormat = '%Y-%m-%d';
            bucketExpression = `strftime('${timeFormat}', timestamp)`;
        } else if (granularity === 'hour') {
            timeFormat = '%Y-%m-%d %H:00';
            bucketExpression = `strftime('${timeFormat}', timestamp)`;
        } else if (granularity === 'minute') {
            timeFormat = '%Y-%m-%d %H:%M';
            bucketExpression = `strftime('${timeFormat}', timestamp)`;
        } else if (!isNaN(parseInt(granularity))) {
            const minutes = parseInt(granularity);
            bucketExpression = `strftime('%Y-%m-%d %H:', timestamp) || printf('%02d', (CAST(strftime('%M', timestamp) AS INTEGER) / ${minutes}) * ${minutes})`;
        } else {
            timeFormat = '%Y-%m-%d %H:00';
            bucketExpression = `strftime('${timeFormat}', timestamp)`;
        }

        let sql = `
            SELECT
                ${bucketExpression} as time_bucket,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(estimated_cost) as cost,
                COUNT(*) as request_count
            FROM request_logs
            WHERE status = 'success'
        `;

        const params = {};
        if (startTime) {
            sql += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            sql += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }

        sql += ` GROUP BY time_bucket ORDER BY time_bucket`;

        const result = db.prepare(sql).all(params);
        db.close();

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error getting token trend:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取 Provider 使用排行
 */
app.get('/api/stats/providers', (req, res) => {
    try {
        const db = getDb();
        const { providerType, limit = 50, startTime, endTime } = req.query;

        // Build WHERE clause for time filtering
        let whereClause = 'WHERE 1=1';
        const params = {};

        if (startTime) {
            whereClause += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            whereClause += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }
        if (providerType) {
            whereClause += ` AND provider_type = @providerType`;
            params.providerType = providerType;
        }

        // Query from request_logs and aggregate by provider
        let sql = `
            SELECT
                provider_type,
                provider_uuid,
                provider_custom_name,
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as total_success,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as total_errors,
                SUM(input_tokens + output_tokens) as total_tokens,
                SUM(estimated_cost) as total_cost,
                MAX(CASE WHEN status = 'error' THEN timestamp END) as last_error_time,
                MAX(CASE WHEN status = 'success' THEN timestamp END) as last_success_time,
                ROUND(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) as success_rate,
                CASE
                    WHEN ROUND(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) >= 95 THEN 1
                    ELSE 0
                END as is_healthy
            FROM request_logs
            ${whereClause}
            GROUP BY provider_type, provider_uuid, provider_custom_name
            ORDER BY total_requests DESC
            LIMIT @limit
        `;

        params.limit = parseInt(limit);

        const result = db.prepare(sql).all(params);
        db.close();

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error getting provider ranking:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取错误率统计
 */
app.get('/api/stats/errors', (req, res) => {
    try {
        const db = getDb();
        const { startTime, endTime } = req.query;

        let sql = `
            SELECT
                provider_type,
                model,
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                ROUND(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as error_rate
            FROM request_logs
            WHERE 1=1
        `;

        const params = {};
        if (startTime) {
            sql += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            sql += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }

        sql += ` GROUP BY provider_type, model HAVING total_requests > 0 ORDER BY error_rate DESC`;

        const result = db.prepare(sql).all(params);
        db.close();

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error getting error stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取最近请求记录
 */
app.get('/api/stats/recent', (req, res) => {
    try {
        const db = getDb();
        const { limit = 100, status } = req.query;

        let sql = `
            SELECT
                request_id,
                timestamp,
                method,
                path,
                provider_type,
                provider_uuid,
                provider_custom_name,
                model,
                is_stream,
                input_tokens,
                output_tokens,
                response_time_ms,
                status,
                status_code,
                error_message,
                estimated_cost
            FROM request_logs
            WHERE 1=1
        `;

        const params = {};
        if (status) {
            sql += ` AND status = @status`;
            params.status = status;
        }

        sql += ` ORDER BY timestamp DESC LIMIT @limit`;
        params.limit = parseInt(limit);

        const result = db.prepare(sql).all(params);
        db.close();

        // Add provider sequence numbers
        const enrichedResult = result.map(record => ({
            ...record,
            provider_sequence: getProviderSequenceNumber(record.provider_type, record.provider_uuid)
        }));

        res.json({
            success: true,
            data: enrichedResult
        });
    } catch (error) {
        console.error('Error getting recent requests:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取 Token 使用分析
 */
app.get('/api/stats/tokens/analytics', (req, res) => {
    try {
        const db = getDb();
        const { startTime, endTime } = req.query;

        let whereClause = 'WHERE status = \'success\' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL';
        const params = {};

        if (startTime) {
            whereClause += ` AND timestamp >= @startTime`;
            params.startTime = startTime;
        }
        if (endTime) {
            whereClause += ` AND timestamp <= @endTime`;
            params.endTime = endTime;
        }

        // Overall token statistics
        const overallStats = db.prepare(`
            SELECT
                COUNT(*) as total_requests,
                AVG(input_tokens + output_tokens) as avg_tokens_per_request,
                AVG(input_tokens) as avg_input_tokens,
                AVG(output_tokens) as avg_output_tokens,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(estimated_cost) as total_cost,
                CASE
                    WHEN SUM(input_tokens + output_tokens) > 0
                    THEN CAST(SUM(input_tokens) AS FLOAT) / (SUM(input_tokens) + SUM(output_tokens)) * 100
                    ELSE 0
                END as input_ratio,
                CASE
                    WHEN SUM(input_tokens + output_tokens) > 0
                    THEN CAST(SUM(output_tokens) AS FLOAT) / (SUM(input_tokens) + SUM(output_tokens)) * 100
                    ELSE 0
                END as output_ratio,
                CASE
                    WHEN SUM(estimated_cost) > 0
                    THEN (SUM(input_tokens) + SUM(output_tokens)) / SUM(estimated_cost)
                    ELSE 0
                END as tokens_per_dollar
            FROM request_logs
            ${whereClause}
        `).get(params);

        // Token statistics by model
        const modelStats = db.prepare(`
            SELECT
                model,
                COUNT(*) as request_count,
                AVG(input_tokens + output_tokens) as avg_tokens_per_request,
                AVG(input_tokens) as avg_input_tokens,
                AVG(output_tokens) as avg_output_tokens,
                SUM(input_tokens + output_tokens) as total_tokens,
                SUM(estimated_cost) as total_cost,
                CASE
                    WHEN SUM(input_tokens + output_tokens) > 0
                    THEN CAST(SUM(input_tokens) AS FLOAT) / (SUM(input_tokens) + SUM(output_tokens)) * 100
                    ELSE 0
                END as input_ratio,
                CASE
                    WHEN SUM(estimated_cost) > 0
                    THEN (SUM(input_tokens) + SUM(output_tokens)) / SUM(estimated_cost)
                    ELSE 0
                END as tokens_per_dollar,
                CASE
                    WHEN SUM(input_tokens + output_tokens) > 0
                    THEN (SUM(estimated_cost) / (SUM(input_tokens) + SUM(output_tokens))) * 1000
                    ELSE 0
                END as cost_per_1k_tokens
            FROM request_logs
            ${whereClause}
            GROUP BY model
            ORDER BY total_tokens DESC
        `).all(params);

        // Token distribution (histogram data)
        const distribution = db.prepare(`
            SELECT
                CASE
                    WHEN (input_tokens + output_tokens) < 1000 THEN '0-1K'
                    WHEN (input_tokens + output_tokens) < 5000 THEN '1K-5K'
                    WHEN (input_tokens + output_tokens) < 10000 THEN '5K-10K'
                    WHEN (input_tokens + output_tokens) < 20000 THEN '10K-20K'
                    WHEN (input_tokens + output_tokens) < 50000 THEN '20K-50K'
                    WHEN (input_tokens + output_tokens) < 100000 THEN '50K-100K'
                    ELSE '100K+'
                END as token_range,
                COUNT(*) as request_count
            FROM request_logs
            ${whereClause}
            GROUP BY token_range
            ORDER BY
                CASE token_range
                    WHEN '0-1K' THEN 1
                    WHEN '1K-5K' THEN 2
                    WHEN '5K-10K' THEN 3
                    WHEN '10K-20K' THEN 4
                    WHEN '20K-50K' THEN 5
                    WHEN '50K-100K' THEN 6
                    WHEN '100K+' THEN 7
                END
        `).all(params);

        // Token percentiles
        const percentiles = db.prepare(`
            WITH token_totals AS (
                SELECT (input_tokens + output_tokens) as total_tokens
                FROM request_logs
                ${whereClause}
                ORDER BY total_tokens
            ),
            counts AS (
                SELECT COUNT(*) as cnt FROM token_totals
            )
            SELECT
                (SELECT total_tokens FROM token_totals LIMIT 1 OFFSET (SELECT CAST(cnt * 0.50 AS INTEGER) FROM counts)) as p50,
                (SELECT total_tokens FROM token_totals LIMIT 1 OFFSET (SELECT CAST(cnt * 0.75 AS INTEGER) FROM counts)) as p75,
                (SELECT total_tokens FROM token_totals LIMIT 1 OFFSET (SELECT CAST(cnt * 0.90 AS INTEGER) FROM counts)) as p90,
                (SELECT total_tokens FROM token_totals LIMIT 1 OFFSET (SELECT CAST(cnt * 0.95 AS INTEGER) FROM counts)) as p95,
                (SELECT total_tokens FROM token_totals LIMIT 1 OFFSET (SELECT CAST(cnt * 0.99 AS INTEGER) FROM counts)) as p99
        `).get(params);

        db.close();

        res.json({
            success: true,
            data: {
                overall: overallStats,
                by_model: modelStats,
                distribution: distribution,
                percentiles: percentiles
            }
        });
    } catch (error) {
        console.error('Error getting token analytics:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebSocket 连接处理
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('[Dashboard] WebSocket client connected');

    ws.on('close', () => {
        clients.delete(ws);
        console.log('[Dashboard] WebSocket client disconnected');
    });

    ws.on('error', (error) => {
        console.error('[Dashboard] WebSocket error:', error);
        clients.delete(ws);
    });
});

// 广播消息到所有客户端
function broadcast(event, data) {
    const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
        }
    });
}

// 跟踪最新请求ID，用于检测新请求
let lastRequestId = null;

// 检测新请求并广播
function checkForNewRequests() {
    if (clients.size === 0) return;

    try {
        const db = getDb();

        // 获取最新的请求
        const latestRequest = db.prepare(`
            SELECT request_id, status FROM request_logs
            ORDER BY id DESC LIMIT 1
        `).get();

        db.close();

        if (latestRequest && latestRequest.request_id !== lastRequestId) {
            lastRequestId = latestRequest.request_id;
            // 广播新请求事件
            broadcast('request_complete', { request_id: latestRequest.request_id });
        }
    } catch (error) {
        // 静默处理错误
    }
}

// 每 2 秒检测一次新请求
setInterval(checkForNewRequests, 2000);

// 定期推送实时统计
setInterval(() => {
    if (clients.size === 0) return;

    try {
        const db = getDb();

        // 获取最近 1 分钟的统计
        // 使用 datetime() 函数进行时间比较，自动处理 ISO8601 格式
        const recentStats = db.prepare(`
            SELECT
                COUNT(*) as requests_last_minute,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors_last_minute,
                AVG(response_time_ms) as avg_response_time
            FROM request_logs
            WHERE datetime(timestamp) >= datetime('now', '-1 minute')
        `).get();

        // 获取活跃请求数（pending 状态）
        const pendingCount = db.prepare(`
            SELECT COUNT(*) as count FROM request_logs WHERE status = 'pending'
        `).get();

        db.close();

        broadcast('realtime_stats', {
            ...recentStats,
            pending_requests: pendingCount.count,
            connected_clients: clients.size
        });
    } catch (error) {
        console.error('[Dashboard] Error broadcasting stats:', error);
    }
}, 5000); // 每 5 秒推送一次

// 启动服务器
const PORT = process.env.DASHBOARD_PORT || 3001;

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   📊 使用统计看板已启动                                    ║
║                                                            ║
║   访问地址: http://localhost:${PORT}                          ║  
║   API 文档: http://localhost:${PORT}/api                      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});

export { broadcast };
