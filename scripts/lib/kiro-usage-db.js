/**
 * Kiro 用量历史数据库模块
 * 使用 better-sqlite3 实现同步操作，提供高性能的数据库访问
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class KiroUsageDatabase {
    constructor() {
        const dbDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = path.join(dbDir, 'kiro-usage-history.db');
        this.db = new Database(dbPath);

        // 启用 WAL 模式提升并发性能
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this.initTables();
        this.prepareStatements();

        console.log('[Kiro Usage DB] Initialized at:', dbPath);
    }

    initTables() {
        this.db.exec(`
            -- 用量历史记录表
            CREATE TABLE IF NOT EXISTS usage_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                provider_uuid TEXT NOT NULL,
                provider_name TEXT,
                user_email TEXT,
                user_id TEXT,
                subscription_type TEXT,
                subscription_title TEXT,
                days_until_reset INTEGER,
                next_date_reset TEXT,

                -- 主要用量数据（Agentic Requests）
                resource_type TEXT,
                current_usage REAL,
                usage_limit REAL,
                current_overages REAL,
                overage_cap REAL,

                -- 免费试用
                free_trial_status TEXT,
                free_trial_usage REAL,
                free_trial_limit REAL,
                free_trial_expires_at TEXT,

                -- 奖励
                bonus_count INTEGER DEFAULT 0,
                bonus_total_usage REAL DEFAULT 0,
                bonus_total_limit REAL DEFAULT 0,

                -- 原始 JSON 数据（便于后续扩展）
                raw_data TEXT
            );

            -- 索引
            CREATE INDEX IF NOT EXISTS idx_usage_history_uuid ON usage_history(provider_uuid);
            CREATE INDEX IF NOT EXISTS idx_usage_history_time ON usage_history(query_time);

            -- 账号变化记录表
            CREATE TABLE IF NOT EXISTS account_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                change_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                change_type TEXT NOT NULL,
                provider_uuid TEXT NOT NULL,
                provider_name TEXT,
                user_email TEXT,
                details TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_account_changes_time ON account_changes(change_time);
        `);
    }

    prepareStatements() {
        this.stmts = {
            insertUsage: this.db.prepare(`
                INSERT INTO usage_history (
                    query_time, provider_uuid, provider_name, user_email, user_id,
                    subscription_type, subscription_title, days_until_reset, next_date_reset,
                    resource_type, current_usage, usage_limit, current_overages, overage_cap,
                    free_trial_status, free_trial_usage, free_trial_limit, free_trial_expires_at,
                    bonus_count, bonus_total_usage, bonus_total_limit, raw_data
                ) VALUES (
                    @query_time, @provider_uuid, @provider_name, @user_email, @user_id,
                    @subscription_type, @subscription_title, @days_until_reset, @next_date_reset,
                    @resource_type, @current_usage, @usage_limit, @current_overages, @overage_cap,
                    @free_trial_status, @free_trial_usage, @free_trial_limit, @free_trial_expires_at,
                    @bonus_count, @bonus_total_usage, @bonus_total_limit, @raw_data
                )
            `),

            getLastUsage: this.db.prepare(`
                SELECT * FROM usage_history
                WHERE provider_uuid = ?
                ORDER BY query_time DESC
                LIMIT 1
            `),

            getAllHistoricalUUIDs: this.db.prepare(`
                SELECT DISTINCT provider_uuid FROM usage_history
            `),

            insertAccountChange: this.db.prepare(`
                INSERT INTO account_changes (
                    change_time, change_type, provider_uuid, provider_name, user_email, details
                ) VALUES (
                    @change_time, @change_type, @provider_uuid, @provider_name, @user_email, @details
                )
            `),

            getRecentAccountChanges: this.db.prepare(`
                SELECT * FROM account_changes
                ORDER BY change_time DESC
                LIMIT ?
            `),

            getUsageHistory: this.db.prepare(`
                SELECT * FROM usage_history
                WHERE provider_uuid = ?
                ORDER BY query_time DESC
                LIMIT ?
            `)
        };
    }

    /**
     * 保存用量记录
     * @param {string} uuid - 提供商 UUID
     * @param {Object} usageData - 格式化后的用量数据
     */
    saveUsageRecord(uuid, usageData) {
        try {
            const queryTime = new Date().toISOString();

            // 提取主要用量数据（Agentic Requests）
            const mainUsage = usageData.usageBreakdown?.find(
                item => item.resourceType === 'AGENTIC_REQUESTS'
            ) || usageData.usageBreakdown?.[0] || {};

            // 计算奖励总计
            let bonusCount = 0;
            let bonusTotalUsage = 0;
            let bonusTotalLimit = 0;
            if (mainUsage.bonuses && Array.isArray(mainUsage.bonuses)) {
                bonusCount = mainUsage.bonuses.length;
                bonusTotalUsage = mainUsage.bonuses.reduce((sum, b) => sum + (b.currentUsage || 0), 0);
                bonusTotalLimit = mainUsage.bonuses.reduce((sum, b) => sum + (b.usageLimit || 0), 0);
            }

            const record = {
                query_time: queryTime,
                provider_uuid: uuid,
                provider_name: null,
                user_email: usageData.user?.email || null,
                user_id: usageData.user?.userId || null,
                subscription_type: usageData.subscription?.type || null,
                subscription_title: usageData.subscription?.title || null,
                days_until_reset: usageData.daysUntilReset || null,
                next_date_reset: usageData.nextDateReset || null,

                resource_type: mainUsage.resourceType || null,
                current_usage: mainUsage.currentUsage || 0,
                usage_limit: mainUsage.usageLimit || 0,
                current_overages: mainUsage.currentOverages || 0,
                overage_cap: mainUsage.overageCap || 0,

                free_trial_status: mainUsage.freeTrial?.status || null,
                free_trial_usage: mainUsage.freeTrial?.currentUsage || 0,
                free_trial_limit: mainUsage.freeTrial?.usageLimit || 0,
                free_trial_expires_at: mainUsage.freeTrial?.expiresAt || null,

                bonus_count: bonusCount,
                bonus_total_usage: bonusTotalUsage,
                bonus_total_limit: bonusTotalLimit,

                raw_data: JSON.stringify(usageData)
            };

            return this.stmts.insertUsage.run(record);
        } catch (error) {
            console.error('[Kiro Usage DB] Save usage record error:', error.message);
            return null;
        }
    }

    /**
     * 获取最近一次用量记录
     * @param {string} uuid - 提供商 UUID
     * @returns {Object|null} 用量记录
     */
    getLastUsageRecord(uuid) {
        try {
            const record = this.stmts.getLastUsage.get(uuid);
            if (record && record.raw_data) {
                record.parsed_data = JSON.parse(record.raw_data);
            }
            return record;
        } catch (error) {
            console.error('[Kiro Usage DB] Get last usage record error:', error.message);
            return null;
        }
    }

    /**
     * 获取所有历史 UUID
     * @returns {Array<string>} UUID 列表
     */
    getAllHistoricalUUIDs() {
        try {
            const rows = this.stmts.getAllHistoricalUUIDs.all();
            return rows.map(row => row.provider_uuid);
        } catch (error) {
            console.error('[Kiro Usage DB] Get all historical UUIDs error:', error.message);
            return [];
        }
    }

    /**
     * 记录账号变化
     * @param {string} changeType - 变化类型：'added' 或 'removed'
     * @param {string} uuid - 提供商 UUID
     * @param {Object} details - 详细信息
     */
    recordAccountChange(changeType, uuid, details) {
        try {
            const record = {
                change_time: new Date().toISOString(),
                change_type: changeType,
                provider_uuid: uuid,
                provider_name: details.customName || null,
                user_email: details.email || null,
                details: JSON.stringify(details)
            };

            return this.stmts.insertAccountChange.run(record);
        } catch (error) {
            console.error('[Kiro Usage DB] Record account change error:', error.message);
            return null;
        }
    }

    /**
     * 获取最近的账号变化记录
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 账号变化记录列表
     */
    getRecentAccountChanges(limit = 10) {
        try {
            return this.stmts.getRecentAccountChanges.all(limit);
        } catch (error) {
            console.error('[Kiro Usage DB] Get recent account changes error:', error.message);
            return [];
        }
    }

    /**
     * 获取指定账号的用量历史
     * @param {string} uuid - 提供商 UUID
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 用量历史记录列表
     */
    getUsageHistory(uuid, limit = 10) {
        try {
            const records = this.stmts.getUsageHistory.all(uuid, limit);
            return records.map(record => {
                if (record.raw_data) {
                    record.parsed_data = JSON.parse(record.raw_data);
                }
                return record;
            });
        } catch (error) {
            console.error('[Kiro Usage DB] Get usage history error:', error.message);
            return [];
        }
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log('[Kiro Usage DB] Connection closed');
        }
    }
}

export default KiroUsageDatabase;
