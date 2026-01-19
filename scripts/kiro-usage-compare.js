#!/usr/bin/env node

/**
 * Kiro 用量对比工具
 * 查询所有 Kiro 账号的用量信息，并与上次查询结果对比
 */

import { promises as pfs } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { KiroUsageDatabase } from './lib/kiro-usage-db.js';
import { formatKiroUsage } from '../src/services/usage-service.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import { MODEL_PROVIDER } from '../src/utils/common.js';

// 命令行参数解析
const args = process.argv.slice(2);
const options = {
    verbose: args.includes('--verbose') || args.includes('-v'),
    json: args.includes('--json'),
    history: args.find(arg => arg.startsWith('--history')),
    reset: args.includes('--reset')
};

/**
 * 加载提供商池配置
 */
async function loadProviderPools() {
    try {
        const poolsPath = 'configs/provider_pools.json';
        const poolsData = await pfs.readFile(poolsPath, 'utf8');
        const pools = JSON.parse(poolsData);
        return pools['claude-kiro-oauth'] || [];
    } catch (error) {
        console.error(chalk.red('❌ 加载提供商配置失败:'), error.message);
        return [];
    }
}

/**
 * 查询单个账号的用量
 */
async function queryAccountUsage(pool) {
    // 临时禁用所有日志输出以减少噪音（必须在创建 config 之前）
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    try {
        const config = {
            MODEL_PROVIDER: MODEL_PROVIDER.KIRO_API,
            KIRO_OAUTH_CREDS_FILE_PATH: pool.KIRO_OAUTH_CREDS_FILE_PATH,
            uuid: pool.uuid,
            customName: pool.customName
        };

        const adapter = getServiceAdapter(config);
        const rawUsage = await adapter.getUsageLimits();
        const formattedUsage = formatKiroUsage(rawUsage);

        return {
            success: true,
            uuid: pool.uuid,
            customName: pool.customName,
            usage: formattedUsage
        };
    } catch (error) {
        return {
            success: false,
            uuid: pool.uuid,
            customName: pool.customName,
            error: error.message
        };
    } finally {
        // 恢复所有日志输出
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
}

/**
 * 计算用量变化
 */
function calculateUsageChange(current, last) {
    if (!last) {
        return { isNew: true, changes: null };
    }

    const timeDiff = Date.now() - new Date(last.query_time).getTime();
    const usageChange = current.current_usage - last.current_usage;
    const usageChangePercent = last.current_usage > 0
        ? (usageChange / last.current_usage * 100)
        : 0;

    const changes = {
        usageChange,
        usageChangePercent,
        limitChange: current.usage_limit - last.usage_limit,
        timeSinceLastQuery: timeDiff,

        // 免费试用变化
        freeTrialChange: (current.free_trial_usage || 0) - (last.free_trial_usage || 0),

        // 奖励变化
        bonusChange: (current.bonus_total_usage || 0) - (last.bonus_total_usage || 0)
    };

    return { isNew: false, changes };
}

/**
 * 格式化时间差
 */
function formatTimeDiff(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    if (minutes > 0) return `${minutes}分钟前`;
    return `${seconds}秒前`;
}

/**
 * 创建进度条
 */
function createProgressBar(current, limit, width = 40) {
    const percentage = limit > 0 ? (current / limit) : 0;
    const filled = Math.round(percentage * width);
    const empty = width - filled;

    let color = chalk.green;
    if (percentage >= 0.9) color = chalk.red;
    else if (percentage >= 0.7) color = chalk.yellow;

    const bar = color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    return `${bar} ${(percentage * 100).toFixed(1)}%`;
}

/**
 * 显示账号用量信息（简洁版）
 */
function displayAccountUsage(result, lastRecord, index) {
    const { uuid, customName, usage } = result;

    // 主要用量（Agentic Requests）
    const mainUsage = usage.usageBreakdown?.find(
        item => item.resourceType === 'AGENTIC_REQUESTS'
    ) || usage.usageBreakdown?.[0];

    if (!mainUsage) return;

    const email = usage.user?.email || 'Unknown';
    const displayName = customName || email;

    // 计算总额度（主额度 + 免费试用 + 奖励）
    const mainLimit = mainUsage.usageLimit || 0;
    const mainUsed = mainUsage.currentUsage || 0;

    const freeTrialLimit = mainUsage.freeTrial?.usageLimit || 0;
    const freeTrialUsed = mainUsage.freeTrial?.currentUsage || 0;

    const bonusTotalLimit = mainUsage.bonuses?.reduce((sum, b) => sum + (b.usageLimit || 0), 0) || 0;
    const bonusTotalUsed = mainUsage.bonuses?.reduce((sum, b) => sum + (b.currentUsage || 0), 0) || 0;

    const totalLimit = mainLimit + freeTrialLimit + bonusTotalLimit;
    const totalUsed = mainUsed + freeTrialUsed + bonusTotalUsed;
    const totalRemaining = totalLimit - totalUsed;
    const usagePercent = totalLimit > 0 ? (totalUsed / totalLimit * 100) : 0;

    // 计算变化
    let changeText = '';
    if (lastRecord) {
        const lastTotalUsed = (lastRecord.current_usage || 0) +
                             (lastRecord.free_trial_usage || 0) +
                             (lastRecord.bonus_total_usage || 0);
        const usageChange = totalUsed - lastTotalUsed;

        if (usageChange > 0) {
            changeText = chalk.yellow(`+${usageChange.toFixed(1)}`);
        } else if (usageChange < 0) {
            changeText = chalk.green(`${usageChange.toFixed(1)}`);
        } else {
            changeText = chalk.gray('无变化');
        }
    } else {
        changeText = chalk.magenta('首次查询');
    }

    // 颜色标记
    let statusColor = chalk.green;
    if (usagePercent >= 90) statusColor = chalk.red;
    else if (usagePercent >= 70) statusColor = chalk.yellow;

    // 输出格式：#ID | 名称 | 已用/总额 (百分比) | 剩余 | 变化
    console.log(
        chalk.white(`#${index.toString().padStart(2, '0')}`) + ' | ' +
        chalk.cyan(displayName.substring(0, 35).padEnd(35)) + ' | ' +
        statusColor(`${totalUsed.toFixed(1)}`.padStart(6) + '/' + `${totalLimit}`.padEnd(6)) +
        statusColor(` (${usagePercent.toFixed(1)}%)`.padStart(8)) + ' | ' +
        chalk.white(`剩余 ${totalRemaining.toFixed(1)}`.padEnd(12)) + ' | ' +
        changeText
    );
}

/**
 * 显示账号变化
 */
function displayAccountChanges(currentUUIDs, historicalUUIDs, results) {
    const added = currentUUIDs.filter(uuid => !historicalUUIDs.includes(uuid));
    const removed = historicalUUIDs.filter(uuid => !currentUUIDs.includes(uuid));

    if (added.length > 0 || removed.length > 0) {
        console.log('');
        console.log(chalk.yellow('账号变化:'));

        if (removed.length > 0) {
            removed.forEach(uuid => {
                console.log(chalk.red(`  - 移除: ${uuid.substring(0, 8)}...`));
            });
        }

        if (added.length > 0) {
            added.forEach(uuid => {
                const result = results.find(r => r.uuid === uuid);
                const email = result?.usage?.user?.email || 'Unknown';
                console.log(chalk.green(`  + 新增: ${email}`));
            });
        }
    }

    return { added, removed };
}

/**
 * 显示摘要
 */
function displaySummary(results, accountChanges) {
    console.log('');
    console.log(chalk.cyan('━'.repeat(100)));

    // 计算总计
    let totalUsed = 0;
    let totalLimit = 0;
    let totalRemaining = 0;

    results.filter(r => r.success).forEach(result => {
        const mainUsage = result.usage.usageBreakdown?.find(
            item => item.resourceType === 'AGENTIC_REQUESTS'
        ) || result.usage.usageBreakdown?.[0];

        if (mainUsage) {
            const mainLimit = mainUsage.usageLimit || 0;
            const mainUsed = mainUsage.currentUsage || 0;
            const freeTrialLimit = mainUsage.freeTrial?.usageLimit || 0;
            const freeTrialUsed = mainUsage.freeTrial?.currentUsage || 0;
            const bonusTotalLimit = mainUsage.bonuses?.reduce((sum, b) => sum + (b.usageLimit || 0), 0) || 0;
            const bonusTotalUsed = mainUsage.bonuses?.reduce((sum, b) => sum + (b.currentUsage || 0), 0) || 0;

            totalLimit += mainLimit + freeTrialLimit + bonusTotalLimit;
            totalUsed += mainUsed + freeTrialUsed + bonusTotalUsed;
        }
    });

    totalRemaining = totalLimit - totalUsed;
    const totalPercent = totalLimit > 0 ? (totalUsed / totalLimit * 100) : 0;

    console.log(chalk.bold.green('汇总统计:'));
    console.log(chalk.white(`  总账号数: ${results.length} | 成功: ${results.filter(r => r.success).length} | 失败: ${results.filter(r => !r.success).length}`));
    console.log(chalk.white(`  总额度: ${totalLimit.toFixed(1)} | 已用: ${totalUsed.toFixed(1)} (${totalPercent.toFixed(1)}%) | 剩余: ${totalRemaining.toFixed(1)}`));

    if (accountChanges) {
        console.log(chalk.white(`  账号变化: +${accountChanges.added.length} / -${accountChanges.removed.length}`));
    }

    console.log(chalk.cyan('━'.repeat(100)));
}

/**
 * 主函数
 */
async function main() {
    console.log(chalk.bold.cyan('━'.repeat(100)));
    console.log(chalk.bold.cyan('Claude Kiro 用量对比报告') + chalk.gray(` - ${new Date().toLocaleString('zh-CN')}`));
    console.log(chalk.cyan('━'.repeat(100)));
    console.log('');

    // 初始化数据库（禁用日志）
    const originalLog = console.log;
    console.log = () => {};
    const db = new KiroUsageDatabase();
    console.log = originalLog;

    try {
        // 处理 --reset 选项
        if (options.reset) {
            console.log(chalk.yellow('⚠️  警告: 即将清空所有历史数据！'));
            console.log(chalk.yellow('按 Ctrl+C 取消，或等待 5 秒后继续...'));
            await new Promise(resolve => setTimeout(resolve, 5000));

            db.db.exec('DELETE FROM usage_history');
            db.db.exec('DELETE FROM account_changes');
            console.log(chalk.green('✅ 历史数据已清空'));
            return;
        }

        // 处理 --history 选项
        if (options.history) {
            const uuid = options.history.split('=')[1];
            if (!uuid) {
                console.error(chalk.red('❌ 请指定 UUID: --history=<uuid>'));
                return;
            }

            const history = db.getUsageHistory(uuid, 10);
            if (history.length === 0) {
                console.log(chalk.yellow(`⚠️  未找到 UUID ${uuid} 的历史记录`));
                return;
            }

            console.log(chalk.bold.cyan(`📜 UUID ${uuid} 的历史记录:`));
            console.log('');

            history.forEach((record, index) => {
                console.log(chalk.gray(`${index + 1}. ${record.query_time}`));
                console.log(chalk.gray(`   用量: ${record.current_usage}/${record.usage_limit}`));
                console.log('');
            });

            return;
        }

        // 加载提供商配置
        const spinner = ora('加载配置...').start();
        const pools = await loadProviderPools();

        if (pools.length === 0) {
            spinner.fail('未找到 Kiro 提供商配置');
            return;
        }

        spinner.succeed(`找到 ${pools.length} 个账号`);

        // 查询所有账号用量
        const querySpinner = ora('查询用量中...').start();
        const results = [];
        for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            querySpinner.text = `查询中... (${i + 1}/${pools.length})`;

            const result = await queryAccountUsage(pool);
            results.push(result);
        }

        querySpinner.succeed('查询完成');

        // 清屏，移除所有之前的日志
        console.clear();

        // JSON 输出模式
        if (options.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
        }

        // 重新显示标题
        console.log(chalk.bold.cyan('━'.repeat(100)));
        console.log(chalk.bold.cyan('Claude Kiro 用量对比报告') + chalk.gray(` - ${new Date().toLocaleString('zh-CN')}`));
        console.log(chalk.cyan('━'.repeat(100)));
        console.log('');

        // 获取历史 UUID
        const historicalUUIDs = db.getAllHistoricalUUIDs();
        const currentUUIDs = results.map(r => r.uuid);

        // 显示表头
        console.log(
            chalk.white('ID'.padEnd(5)) + ' | ' +
            chalk.cyan('账号名称'.padEnd(35)) + ' | ' +
            chalk.white('已用/总额'.padEnd(20)) + ' | ' +
            chalk.white('剩余'.padEnd(12)) + ' | ' +
            chalk.white('变化')
        );
        console.log(chalk.gray('─'.repeat(100)));

        // 显示每个账号的用量信息
        let successIndex = 1;
        for (const result of results) {
            if (!result.success) {
                console.log(
                    chalk.gray(`#${successIndex.toString().padStart(2, '0')}`) + ' | ' +
                    chalk.red('查询失败: ' + result.error)
                );
                successIndex++;
                continue;
            }

            const lastRecord = db.getLastUsageRecord(result.uuid);
            displayAccountUsage(result, lastRecord, successIndex++);

            // 保存当前查询结果
            db.saveUsageRecord(result.uuid, result.usage);
        }

        // 显示账号变化
        const accountChanges = displayAccountChanges(currentUUIDs, historicalUUIDs, results);

        // 记录账号变化
        for (const uuid of accountChanges.added) {
            const result = results.find(r => r.uuid === uuid);
            db.recordAccountChange('added', uuid, {
                email: result?.usage?.user?.email,
                customName: result?.customName
            });
        }

        for (const uuid of accountChanges.removed) {
            db.recordAccountChange('removed', uuid, {});
        }

        // 显示摘要
        displaySummary(results, accountChanges);

    } catch (error) {
        console.error(chalk.red('❌ 发生错误:'), error.message);
        if (options.verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        db.close();
        // 强制退出进程，避免资源未释放导致进程挂起
        process.exit(0);
    }
}

// 运行主函数
main().catch(error => {
    console.error(chalk.red('❌ 未捕获的错误:'), error.message);
    process.exit(1);
});
