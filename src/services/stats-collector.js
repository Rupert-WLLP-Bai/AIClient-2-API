/**
 * 统计数据收集器
 * 提供统一的接口收集请求统计数据，异步写入数据库
 */

import { v4 as uuidv4 } from 'uuid';
import { getStatsDatabase } from './stats-database.js';

// 内存中的活跃请求状态（用于实时监控）
const activeRequests = new Map();

// 写入队列（批量写入优化）
const writeQueue = [];
let writeTimer = null;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL = 1000; // 1秒

// 统计收集器是否已启用
let isEnabled = true;

/**
 * 启用/禁用统计收集
 */
export function setStatsEnabled(enabled) {
    isEnabled = enabled;
    console.log(`[Stats Collector] ${enabled ? 'Enabled' : 'Disabled'}`);
}

/**
 * 检查统计收集是否启用
 */
export function isStatsEnabled() {
    return isEnabled;
}

/**
 * 请求开始时调用
 * @param {Object} options - 请求选项
 * @returns {string} 请求ID
 */
export function startRequest(options) {
    if (!isEnabled) return null;

    const requestId = uuidv4();
    const startTime = Date.now();

    const requestData = {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        method: options.method || 'POST',
        path: options.path || '/',
        endpoint_type: options.endpointType || null,
        provider_type: options.providerType || 'unknown',
        provider_uuid: options.providerUuid || null,
        provider_custom_name: options.customName || null,
        model: options.model || null,
        is_stream: options.isStream ? 1 : 0,
        input_tokens: 0,
        output_tokens: 0,
        response_time_ms: null,
        first_token_time_ms: null,
        status: 'pending',
        status_code: null,
        error_message: null,
        estimated_cost: 0,
        _startTime: startTime
    };

    activeRequests.set(requestId, requestData);

    return requestId;
}

/**
 * 更新请求的模型和提供商信息
 * @param {string} requestId - 请求ID
 * @param {Object} options - 更新选项
 */
export function updateRequestInfo(requestId, options) {
    if (!isEnabled || !requestId) return;

    const requestData = activeRequests.get(requestId);
    if (!requestData) return;

    if (options.model !== undefined) requestData.model = options.model;
    if (options.isStream !== undefined) requestData.is_stream = options.isStream ? 1 : 0;
    if (options.providerType !== undefined) requestData.provider_type = options.providerType;
    if (options.providerUuid !== undefined) requestData.provider_uuid = options.providerUuid;
    if (options.customName !== undefined) requestData.provider_custom_name = options.customName;
    if (options.endpointType !== undefined) requestData.endpoint_type = options.endpointType;
}

/**
 * 请求成功完成时调用
 * @param {string} requestId - 请求ID
 * @param {Object} options - 完成选项
 */
export function completeRequest(requestId, options = {}) {
    if (!isEnabled || !requestId) return;

    const requestData = activeRequests.get(requestId);
    if (!requestData) return;

    const endTime = Date.now();
    const responseTime = endTime - requestData._startTime;

    // 计算成本
    const estimatedCost = calculateCost(
        requestData.model,
        options.inputTokens || 0,
        options.outputTokens || 0
    );

    Object.assign(requestData, {
        status: 'success',
        status_code: options.statusCode || 200,
        input_tokens: options.inputTokens || 0,
        output_tokens: options.outputTokens || 0,
        response_time_ms: responseTime,
        first_token_time_ms: options.firstTokenTime || null,
        estimated_cost: estimatedCost
    });

    // 从活跃请求中移除
    activeRequests.delete(requestId);

    // 加入写入队列
    queueWrite(requestData);

    // 更新 Provider 排行
    updateProviderRanking(requestData);
}

/**
 * 请求失败时调用
 * @param {string} requestId - 请求ID
 * @param {Object} options - 失败选项
 */
export function failRequest(requestId, options = {}) {
    if (!isEnabled || !requestId) return;

    const requestData = activeRequests.get(requestId);
    if (!requestData) return;

    const endTime = Date.now();
    const responseTime = endTime - requestData._startTime;

    Object.assign(requestData, {
        status: 'error',
        status_code: options.statusCode || 500,
        error_message: options.errorMessage || 'Unknown error',
        response_time_ms: responseTime
    });

    activeRequests.delete(requestId);
    queueWrite(requestData);
    updateProviderRanking(requestData);
}

/**
 * 获取当前活跃请求列表
 * @returns {Array} 活跃请求列表
 */
export function getActiveRequests() {
    return Array.from(activeRequests.values()).map(req => ({
        requestId: req.request_id,
        method: req.method,
        path: req.path,
        model: req.model,
        providerType: req.provider_type,
        providerUuid: req.provider_uuid,
        startTime: req.timestamp,
        elapsedMs: Date.now() - req._startTime
    }));
}

/**
 * 获取实时统计摘要
 * @returns {Object} 实时统计
 */
export function getRealtimeStats() {
    return {
        activeRequests: activeRequests.size,
        queuedWrites: writeQueue.length
    };
}

/**
 * 立即刷新写入队列
 */
export function flushNow() {
    flushQueue();
}

// ========== 内部函数 ==========

function queueWrite(data) {
    // 移除内部字段
    const { _startTime, ...cleanData } = data;
    writeQueue.push(cleanData);

    if (writeQueue.length >= BATCH_SIZE) {
        flushQueue();
    } else if (!writeTimer) {
        writeTimer = setTimeout(flushQueue, FLUSH_INTERVAL);
    }
}

function flushQueue() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }

    if (writeQueue.length === 0) return;

    const batch = writeQueue.splice(0, BATCH_SIZE);

    try {
        const db = getStatsDatabase();
        db.batchInsertRequests(batch);
    } catch (error) {
        console.error('[Stats Collector] Failed to write batch:', error.message);
        // 失败的记录不放回队列，避免无限重试
    }
}

function calculateCost(model, inputTokens, outputTokens) {
    if (!model || (inputTokens === 0 && outputTokens === 0)) return 0;

    try {
        const db = getStatsDatabase();
        const pricing = db.getPricing(model);

        if (!pricing) return 0;

        const inputCost = (inputTokens / 1000000) * pricing.input_price_per_1m;
        const outputCost = (outputTokens / 1000000) * pricing.output_price_per_1m;

        return Math.round((inputCost + outputCost) * 1000000) / 1000000; // 保留6位小数
    } catch (error) {
        return 0;
    }
}

function updateProviderRanking(requestData) {
    try {
        const db = getStatsDatabase();
        db.updateProviderRanking({
            provider_type: requestData.provider_type,
            provider_uuid: requestData.provider_uuid,
            provider_custom_name: requestData.provider_custom_name,
            is_success: requestData.status === 'success',
            tokens: (requestData.input_tokens || 0) + (requestData.output_tokens || 0),
            cost: requestData.estimated_cost || 0
        });
    } catch (error) {
        console.error('[Stats Collector] Failed to update ranking:', error.message);
    }
}

// ========== 定时任务 ==========

let cleanupInterval = null;

/**
 * 启动定时清理任务
 * @param {number} retentionDays - 数据保留天数
 */
export function startCleanupTask(retentionDays = 30) {
    if (cleanupInterval) return;

    // 每天执行一次数据清理
    cleanupInterval = setInterval(() => {
        try {
            const db = getStatsDatabase();
            db.cleanupOldData(retentionDays);
            console.log('[Stats Collector] Daily cleanup completed');
        } catch (error) {
            console.error('[Stats Collector] Cleanup failed:', error.message);
        }
    }, 24 * 60 * 60 * 1000);

    console.log(`[Stats Collector] Cleanup task started (retention: ${retentionDays} days)`);
}

/**
 * 停止定时清理任务
 */
export function stopCleanupTask() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log('[Stats Collector] Cleanup task stopped');
    }
}

// ========== 查询接口（代理到数据库模块）==========

/**
 * 获取模型统计
 */
export function getModelStats(options) {
    try {
        const db = getStatsDatabase();
        return db.getModelStats(options);
    } catch (error) {
        console.error('[Stats Collector] getModelStats error:', error.message);
        return [];
    }
}

/**
 * 获取 Token 趋势
 */
export function getTokenTrend(options) {
    try {
        const db = getStatsDatabase();
        return db.getTokenTrend(options);
    } catch (error) {
        console.error('[Stats Collector] getTokenTrend error:', error.message);
        return [];
    }
}

/**
 * 获取 Provider 排行
 */
export function getProviderRanking(options) {
    try {
        const db = getStatsDatabase();
        return db.getProviderRanking(options);
    } catch (error) {
        console.error('[Stats Collector] getProviderRanking error:', error.message);
        return [];
    }
}

/**
 * 获取错误统计
 */
export function getErrorStats(options) {
    try {
        const db = getStatsDatabase();
        return db.getErrorStats(options);
    } catch (error) {
        console.error('[Stats Collector] getErrorStats error:', error.message);
        return [];
    }
}

/**
 * 获取总体摘要
 */
export function getSummary(options) {
    try {
        const db = getStatsDatabase();
        return db.getSummary(options);
    } catch (error) {
        console.error('[Stats Collector] getSummary error:', error.message);
        return null;
    }
}

/**
 * 获取最近请求
 */
export function getRecentRequests(options) {
    try {
        const db = getStatsDatabase();
        return db.getRecentRequests(options);
    } catch (error) {
        console.error('[Stats Collector] getRecentRequests error:', error.message);
        return [];
    }
}

export default {
    startRequest,
    updateRequestInfo,
    completeRequest,
    failRequest,
    getActiveRequests,
    getRealtimeStats,
    flushNow,
    setStatsEnabled,
    isStatsEnabled,
    startCleanupTask,
    stopCleanupTask,
    getModelStats,
    getTokenTrend,
    getProviderRanking,
    getErrorStats,
    getSummary,
    getRecentRequests
};
