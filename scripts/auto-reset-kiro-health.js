#!/usr/bin/env node

/**
 * 自动监控并重置 claude-kiro-oauth 提供商健康状态
 *
 * 功能：
 * - 定期检查 claude-kiro-oauth 节点的健康状态
 * - 当所有节点都不健康时，自动触发重置
 * - 持续运行，无需 crontab
 *
 * 使用方法：
 *   node scripts/auto-reset-kiro-health.js
 *   或
 *   npm run kiro:auto-reset
 *
 * 后台运行：
 *   nohup npm run kiro:auto-reset > logs/auto-reset.log 2>&1 &
 *
 * 环境变量：
 *   SERVER_PORT - 服务器端口（默认: 3000）
 *   ADMIN_PASSWORD - 管理员密码（默认: admin123）
 *   CHECK_INTERVAL - 检查间隔（秒，默认: 20）
 *   UNHEALTHY_THRESHOLD - 不健康节点比例阈值（0-1，默认: 1.0 表示全部不健康才重置）
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PROVIDER_TYPE = 'claude-kiro-oauth';
const CONFIG_FILE = 'configs/provider_pools.json';
const SERVER_PORT = process.env.SERVER_PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '10') * 1000; // 默认10秒
const UNHEALTHY_THRESHOLD = parseFloat(process.env.UNHEALTHY_THRESHOLD || '1.0'); // 默认100%不健康才重置

let isResetting = false; // 防止重复重置

/**
 * 检查配置文件中的健康状态
 */
function checkHealthStatus() {
    const configPath = join(process.cwd(), CONFIG_FILE);

    if (!existsSync(configPath)) {
        console.error(`[${new Date().toLocaleString()}] ❌ 配置文件不存在: ${configPath}`);
        return null;
    }

    try {
        const fileContent = readFileSync(configPath, 'utf-8');
        const providerPools = JSON.parse(fileContent);
        const providers = providerPools[PROVIDER_TYPE] || [];

        if (providers.length === 0) {
            console.log(`[${new Date().toLocaleString()}] ⚠️  未找到任何 ${PROVIDER_TYPE} 节点`);
            return null;
        }

        // 统计健康状态（排除已禁用的节点）
        const activeProviders = providers.filter(p => !p.isDisabled);
        const unhealthyProviders = activeProviders.filter(p => !p.isHealthy);
        const unhealthyRatio = activeProviders.length > 0 ? unhealthyProviders.length / activeProviders.length : 0;

        return {
            total: providers.length,
            active: activeProviders.length,
            healthy: activeProviders.length - unhealthyProviders.length,
            unhealthy: unhealthyProviders.length,
            unhealthyRatio: unhealthyRatio,
            disabled: providers.length - activeProviders.length
        };
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ 读取配置文件失败:`, error.message);
        return null;
    }
}

/**
 * 执行重置脚本
 */
async function executeReset() {
    if (isResetting) {
        console.log(`[${new Date().toLocaleString()}] ⏳ 重置正在进行中，跳过...`);
        return false;
    }

    isResetting = true;
    console.log('');
    console.log('='.repeat(60));
    console.log(`[${new Date().toLocaleString()}] 🚨 触发自动重置！`);
    console.log('='.repeat(60));

    try {
        // 设置环境变量并执行重置脚本
        const env = {
            ...process.env,
            SERVER_PORT: SERVER_PORT.toString(),
            ADMIN_PASSWORD: ADMIN_PASSWORD
        };

        const { stdout, stderr } = await execAsync('node scripts/reset-kiro-health.js', {
            env: env,
            cwd: process.cwd()
        });

        console.log(stdout);
        if (stderr) {
            console.error('stderr:', stderr);
        }

        console.log('='.repeat(60));
        console.log(`[${new Date().toLocaleString()}] ✅ 自动重置完成`);
        console.log('='.repeat(60));
        console.log('');
        return true;
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ 重置失败:`, error.message);
        return false;
    } finally {
        isResetting = false;
    }
}

/**
 * 主监控循环
 */
async function monitorLoop() {
    console.log('='.repeat(60));
    console.log('🤖 Claude Kiro OAuth 自动健康监控已启动');
    console.log('='.repeat(60));
    console.log('');
    console.log('配置信息:');
    console.log(`  服务器端口: ${SERVER_PORT}`);
    console.log(`  检查间隔: ${CHECK_INTERVAL / 1000} 秒`);
    console.log(`  不健康阈值: ${(UNHEALTHY_THRESHOLD * 100).toFixed(0)}%`);
    console.log('');
    console.log('按 Ctrl+C 停止监控');
    console.log('='.repeat(60));
    console.log('');

    // 定期检查
    setInterval(async () => {
        const status = checkHealthStatus();

        if (!status) {
            return;
        }

        const timestamp = new Date().toLocaleString();

        // 显示当前状态
        console.log(`[${timestamp}] 📊 状态: 总计 ${status.total} | 活跃 ${status.active} | 健康 ${status.healthy} | 不健康 ${status.unhealthy} | 已禁用 ${status.disabled}`);

        // 判断是否需要重置
        if (status.active > 0 && status.unhealthyRatio >= UNHEALTHY_THRESHOLD) {
            console.log(`[${timestamp}] ⚠️  不健康比例: ${(status.unhealthyRatio * 100).toFixed(1)}% (阈值: ${(UNHEALTHY_THRESHOLD * 100).toFixed(0)}%)`);

            if (status.unhealthyRatio === 1.0) {
                console.log(`[${timestamp}] 🚨 所有活跃节点都不健康！准备执行重置...`);
            } else {
                console.log(`[${timestamp}] 🚨 不健康节点超过阈值！准备执行重置...`);
            }

            await executeReset();
        } else if (status.unhealthy > 0) {
            console.log(`[${timestamp}] ⚠️  有 ${status.unhealthy} 个不健康节点 (${(status.unhealthyRatio * 100).toFixed(1)}%)，未达到重置阈值`);
        } else {
            console.log(`[${timestamp}] ✅ 所有节点健康`);
        }
    }, CHECK_INTERVAL);
}

// 优雅退出处理
process.on('SIGINT', () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('👋 收到退出信号，正在停止监控...');
    console.log('='.repeat(60));
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('👋 收到终止信号，正在停止监控...');
    console.log('='.repeat(60));
    process.exit(0);
});

// 启动监控
monitorLoop();
