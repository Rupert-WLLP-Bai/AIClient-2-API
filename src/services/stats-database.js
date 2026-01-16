/**
 * 统计数据库操作模块
 * 使用 better-sqlite3 实现同步操作，提供高性能的数据库访问
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance = null;

/**
 * 获取数据库单例实例
 */
export function getStatsDatabase() {
    if (!dbInstance) {
        dbInstance = new StatsDatabase();
    }
    return dbInstance;
}

/**
 * 关闭数据库连接
 */
export function closeStatsDatabase() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
    }
}

class StatsDatabase {
    constructor() {
        const dbDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = path.join(dbDir, 'stats.db');
        this.db = new Database(dbPath);

        // 启用 WAL 模式提升并发性能
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this.initTables();
        this.prepareStatements();

        console.log('[Stats Database] Initialized at:', dbPath);
    }

    initTables() {
        this.db.exec(`
            -- 请求记录表（核心表）
            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT UNIQUE NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                endpoint_type TEXT,
                provider_type TEXT NOT NULL,
                provider_uuid TEXT,
                provider_custom_name TEXT,
                model TEXT,
                is_stream INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                response_time_ms INTEGER,
                first_token_time_ms INTEGER,
                status TEXT DEFAULT 'pending',
                status_code INTEGER,
                error_message TEXT,
                estimated_cost REAL DEFAULT 0
            );

            -- 索引
            CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider_type, provider_uuid);
            CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);
            CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);

            -- Provider 使用排行表
            CREATE TABLE IF NOT EXISTS provider_usage_ranking (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_type TEXT NOT NULL,
                provider_uuid TEXT NOT NULL,
                provider_custom_name TEXT,
                total_requests INTEGER DEFAULT 0,
                total_success INTEGER DEFAULT 0,
                total_errors INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0,
                is_healthy INTEGER DEFAULT 1,
                last_error_time DATETIME,
                last_success_time DATETIME,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(provider_type, provider_uuid)
            );

            CREATE INDEX IF NOT EXISTS idx_provider_ranking_type ON provider_usage_ranking(provider_type);

            -- 模型定价配置表
            CREATE TABLE IF NOT EXISTS model_pricing (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_pattern TEXT NOT NULL,
                provider_type TEXT,
                input_price_per_1m REAL NOT NULL,
                output_price_per_1m REAL NOT NULL,
                effective_date DATE DEFAULT CURRENT_DATE,
                notes TEXT,
                UNIQUE(model_pattern, provider_type)
            );
        `);

        // 插入默认定价数据
        const insertPricing = this.db.prepare(`
            INSERT OR IGNORE INTO model_pricing (model_pattern, input_price_per_1m, output_price_per_1m, notes)
            VALUES (?, ?, ?, ?)
        `);

        // Claude 4.5 系列定价 ($/MTok)
        const defaultPricing = [
            ['claude-opus-4-5%', 5.00, 25.00, 'Claude Opus 4.5'],
            ['claude-sonnet-4-5%', 3.00, 15.00, 'Claude Sonnet 4.5'],
            ['claude-haiku-4-5%', 1.00, 5.00, 'Claude Haiku 4.5'],
        ];

        for (const [pattern, inputPrice, outputPrice, notes] of defaultPricing) {
            insertPricing.run(pattern, inputPrice, outputPrice, notes);
        }
    }

    prepareStatements() {
        this.stmts = {
            insertRequest: this.db.prepare(`
                INSERT INTO request_logs (
                    request_id, timestamp, method, path, endpoint_type,
                    provider_type, provider_uuid, provider_custom_name,
                    model, is_stream, input_tokens, output_tokens,
                    response_time_ms, first_token_time_ms, status,
                    status_code, error_message, estimated_cost
                ) VALUES (
                    @request_id, @timestamp, @method, @path, @endpoint_type,
                    @provider_type, @provider_uuid, @provider_custom_name,
                    @model, @is_stream, @input_tokens, @output_tokens,
                    @response_time_ms, @first_token_time_ms, @status,
                    @status_code, @error_message, @estimated_cost
                )
            `),

            updateRequest: this.db.prepare(`
                UPDATE request_logs SET
                    provider_type = COALESCE(@provider_type, provider_type),
                    provider_uuid = COALESCE(@provider_uuid, provider_uuid),
                    provider_custom_name = COALESCE(@provider_custom_name, provider_custom_name),
                    model = COALESCE(@model, model),
                    is_stream = COALESCE(@is_stream, is_stream),
                    input_tokens = COALESCE(@input_tokens, input_tokens),
                    output_tokens = COALESCE(@output_tokens, output_tokens),
                    response_time_ms = COALESCE(@response_time_ms, response_time_ms),
                    first_token_time_ms = COALESCE(@first_token_time_ms, first_token_time_ms),
                    status = COALESCE(@status, status),
                    status_code = COALESCE(@status_code, status_code),
                    error_message = COALESCE(@error_message, error_message),
                    estimated_cost = COALESCE(@estimated_cost, estimated_cost)
                WHERE request_id = @request_id
            `),

            getRequestById: this.db.prepare(`
                SELECT * FROM request_logs WHERE request_id = ?
            `),
        };

        // 批量插入事务
        this.batchInsertTransaction = this.db.transaction((records) => {
            for (const record of records) {
                this.stmts.insertRequest.run(record);
            }
        });
    }

    /**
     * 插入单条请求记录
     */
    insertRequest(record) {
        try {
            return this.stmts.insertRequest.run(record);
        } catch (error) {
            console.error('[Stats Database] Insert request error:', error.message);
            return null;
        }
    }

    /**
     * 更新请求记录
     */
    updateRequest(record) {
        try {
            return this.stmts.updateRequest.run(record);
        } catch (error) {
            console.error('[Stats Database] Update request error:', error.message);
            return null;
        }
    }

    /**
     * 批量插入请求记录
     */
    batchInsertRequests(records) {
        try {
            return this.batchInsertTransaction(records);
        } catch (error) {
            console.error('[Stats Database] Batch insert error:', error.message);
            return null;
        }
    }

    /**
     * 获取模型调用统计
     */
    getModelStats(options = {}) {
        const { startTime, endTime, limit = 20 } = options;

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
        params.limit = limit;

        return this.db.prepare(sql).all(params);
    }

    /**
     * 获取 Token 使用趋势
     */
    getTokenTrend(options = {}) {
        const { startTime, endTime, granularity = 'hour' } = options;

        const timeFormat = granularity === 'day'
            ? '%Y-%m-%d'
            : '%Y-%m-%d %H:00';

        let sql = `
            SELECT
                strftime('${timeFormat}', timestamp) as time_bucket,
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

        return this.db.prepare(sql).all(params);
    }

    /**
     * 获取 Provider 使用排行
     */
    getProviderRanking(options = {}) {
        const { providerType, limit = 50 } = options;

        let sql = `
            SELECT
                provider_type,
                provider_uuid,
                provider_custom_name,
                total_requests,
                total_success,
                total_errors,
                total_tokens,
                total_cost,
                is_healthy,
                last_error_time,
                last_success_time,
                ROUND(total_success * 100.0 / NULLIF(total_requests, 0), 2) as success_rate
            FROM provider_usage_ranking
            WHERE 1=1
        `;

        const params = {};
        if (providerType) {
            sql += ` AND provider_type = @providerType`;
            params.providerType = providerType;
        }

        sql += ` ORDER BY total_requests DESC LIMIT @limit`;
        params.limit = limit;

        return this.db.prepare(sql).all(params);
    }

    /**
     * 获取错误率统计
     */
    getErrorStats(options = {}) {
        const { startTime, endTime } = options;

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

        return this.db.prepare(sql).all(params);
    }

    /**
     * 获取总体统计摘要
     */
    getSummary(options = {}) {
        const { startTime, endTime } = options;

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

        return this.db.prepare(sql).get(params);
    }

    /**
     * 获取最近的请求记录
     */
    getRecentRequests(options = {}) {
        const { limit = 100, status } = options;

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
        params.limit = limit;

        return this.db.prepare(sql).all(params);
    }

    /**
     * 更新 Provider 排行
     */
    updateProviderRanking(data) {
        const sql = `
            INSERT INTO provider_usage_ranking (
                provider_type, provider_uuid, provider_custom_name,
                total_requests, total_success, total_errors,
                total_tokens, total_cost, is_healthy,
                last_success_time, last_error_time, updated_at
            ) VALUES (
                @provider_type, @provider_uuid, @provider_custom_name,
                1, @is_success, @is_error,
                @tokens, @cost, 1,
                @success_time, @error_time, CURRENT_TIMESTAMP
            )
            ON CONFLICT(provider_type, provider_uuid) DO UPDATE SET
                provider_custom_name = COALESCE(@provider_custom_name, provider_custom_name),
                total_requests = total_requests + 1,
                total_success = total_success + @is_success,
                total_errors = total_errors + @is_error,
                total_tokens = total_tokens + @tokens,
                total_cost = total_cost + @cost,
                last_success_time = COALESCE(@success_time, last_success_time),
                last_error_time = COALESCE(@error_time, last_error_time),
                updated_at = CURRENT_TIMESTAMP
        `;

        try {
            this.db.prepare(sql).run({
                provider_type: data.provider_type || 'unknown',
                provider_uuid: data.provider_uuid || 'default',
                provider_custom_name: data.provider_custom_name || null,
                is_success: data.is_success ? 1 : 0,
                is_error: data.is_success ? 0 : 1,
                tokens: data.tokens || 0,
                cost: data.cost || 0,
                success_time: data.is_success ? new Date().toISOString() : null,
                error_time: data.is_success ? null : new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Stats Database] Update provider ranking error:', error.message);
        }
    }

    /**
     * 获取模型定价
     */
    getPricing(model) {
        if (!model) return null;

        // 使用 LIKE 进行模式匹配
        const sql = `
            SELECT input_price_per_1m, output_price_per_1m
            FROM model_pricing
            WHERE @model LIKE REPLACE(model_pattern, '%', '%')
            ORDER BY LENGTH(model_pattern) DESC
            LIMIT 1
        `;

        // 简化匹配：遍历所有定价规则
        const allPricing = this.db.prepare(`SELECT * FROM model_pricing`).all();
        for (const pricing of allPricing) {
            const pattern = pricing.model_pattern.replace(/%/g, '');
            if (model.toLowerCase().includes(pattern.toLowerCase())) {
                return {
                    input_price_per_1m: pricing.input_price_per_1m,
                    output_price_per_1m: pricing.output_price_per_1m
                };
            }
        }

        // 默认定价
        return { input_price_per_1m: 1.00, output_price_per_1m: 5.00 };
    }

    /**
     * 清理过期数据
     */
    cleanupOldData(retentionDays = 30) {
        const sql = `
            DELETE FROM request_logs
            WHERE timestamp < datetime('now', '-${retentionDays} days')
        `;

        try {
            const result = this.db.prepare(sql).run();
            console.log(`[Stats Database] Cleaned up ${result.changes} old records`);
            return result.changes;
        } catch (error) {
            console.error('[Stats Database] Cleanup error:', error.message);
            return 0;
        }
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log('[Stats Database] Connection closed');
        }
    }
}

export default StatsDatabase;
