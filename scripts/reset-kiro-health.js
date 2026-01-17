#!/usr/bin/env node

/**
 * 重置 claude-kiro-oauth 提供商的健康状态
 *
 * 功能：
 * - 将所有不健康的 claude-kiro-oauth 节点重置为健康状态
 * - 清零错误计数
 * - 清除错误时间和错误消息
 * - 清除定时恢复时间
 * - 自动调用系统 reload 接口更新内存状态
 *
 * 使用方法：
 *   node scripts/reset-kiro-health.js
 *   或
 *   npm run kiro:reset-health
 *
 * 环境变量：
 *   SERVER_PORT - 服务器端口（默认: 3000）
 *   ADMIN_PASSWORD - 管理员密码（如果设置了认证）
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import http from 'http';

const PROVIDER_TYPE = 'claude-kiro-oauth';
const CONFIG_FILE = 'configs/provider_pools.json';

/**
 * 调用系统 API 重新加载配置
 */
async function reloadSystemConfig() {
    const port = process.env.SERVER_PORT || 3000;
    const password = process.env.ADMIN_PASSWORD || '';

    console.log('🔄 正在调用系统 reload 接口...');

    // 先尝试登录获取 token（如果需要认证）
    let token = null;
    if (password) {
        try {
            token = await login(port, password);
            console.log('   ✅ 登录成功');
        } catch (error) {
            console.log('   ⚠️  登录失败，尝试不使用认证:', error.message);
        }
    }

    // 调用 reload-config 接口
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: port,
            path: '/api/reload-config',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log('   ✅ 系统配置已重新加载');
                    resolve(true);
                } else if (res.statusCode === 401) {
                    console.log('   ⚠️  需要认证，请设置 ADMIN_PASSWORD 环境变量');
                    console.log('   💡 使用方法: ADMIN_PASSWORD=your_password npm run kiro:reset-health');
                    resolve(false);
                } else {
                    console.log(`   ⚠️  重新加载失败 (HTTP ${res.statusCode})`);
                    resolve(false);
                }
            });
        });

        req.on('error', (error) => {
            if (error.code === 'ECONNREFUSED') {
                console.log('   ⚠️  无法连接到服务器（服务可能未运行）');
                console.log('   💡 请手动重启服务或在管理界面点击"重新加载配置"');
            } else {
                console.log('   ⚠️  调用失败:', error.message);
            }
            resolve(false);
        });

        req.end();
    });
}

/**
 * 登录获取 token
 */
async function login(port, password) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ password });

        const options = {
            hostname: 'localhost',
            port: port,
            path: '/api/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data);
                        resolve(response.token);
                    } catch (error) {
                        reject(new Error('解析响应失败'));
                    }
                } else {
                    reject(new Error(`登录失败 (HTTP ${res.statusCode})`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

async function resetKiroHealth() {
    console.log('='.repeat(60));
    console.log('🔧 重置 Claude Kiro OAuth 提供商健康状态');
    console.log('='.repeat(60));
    console.log('');

    // 1. 检查配置文件是否存在
    const configPath = join(process.cwd(), CONFIG_FILE);
    if (!existsSync(configPath)) {
        console.error('❌ 错误: 配置文件不存在:', configPath);
        console.error('   请确保在项目根目录运行此脚本');
        process.exit(1);
    }

    // 2. 读取配置文件
    console.log('📖 读取配置文件:', CONFIG_FILE);
    let providerPools;
    try {
        const fileContent = readFileSync(configPath, 'utf-8');
        providerPools = JSON.parse(fileContent);
    } catch (error) {
        console.error('❌ 错误: 无法读取或解析配置文件:', error.message);
        process.exit(1);
    }

    // 3. 获取 claude-kiro-oauth 提供商列表
    const providers = providerPools[PROVIDER_TYPE] || [];

    if (providers.length === 0) {
        console.log('⚠️  警告: 未找到任何 claude-kiro-oauth 提供商配置');
        process.exit(0);
    }

    console.log(`📊 找到 ${providers.length} 个 claude-kiro-oauth 节点`);
    console.log('');

    // 4. 统计当前状态
    const unhealthyProviders = providers.filter(p => !p.isHealthy);
    const disabledProviders = providers.filter(p => p.isDisabled);

    console.log('📈 当前状态统计:');
    console.log(`   总节点数: ${providers.length}`);
    console.log(`   健康节点: ${providers.length - unhealthyProviders.length}`);
    console.log(`   不健康节点: ${unhealthyProviders.length}`);
    console.log(`   已禁用节点: ${disabledProviders.length}`);
    console.log('');

    if (unhealthyProviders.length === 0) {
        console.log('✅ 所有节点都是健康状态，无需重置');
        process.exit(0);
    }

    // 5. 显示将要重置的节点详情
    console.log('🔍 将要重置的不健康节点:');
    unhealthyProviders.forEach((provider, index) => {
        const name = provider.customName || provider.uuid || `节点${index + 1}`;
        const errorCount = provider.errorCount || 0;
        const lastError = provider.lastErrorMessage || '无';
        const lastErrorTime = provider.lastErrorTime
            ? new Date(provider.lastErrorTime).toLocaleString('zh-CN')
            : '无';

        console.log(`   ${index + 1}. ${name}`);
        console.log(`      UUID: ${provider.uuid}`);
        console.log(`      错误次数: ${errorCount}`);
        console.log(`      最后错误: ${lastError}`);
        console.log(`      错误时间: ${lastErrorTime}`);
        console.log('');
    });

    // 6. 执行重置操作
    console.log('🔄 开始重置健康状态...');
    console.log('');

    let resetCount = 0;
    providers.forEach(provider => {
        if (!provider.isHealthy) {
            const name = provider.customName || provider.uuid || '未命名节点';

            // 重置健康状态
            provider.isHealthy = true;
            provider.errorCount = 0;
            provider.lastErrorTime = null;
            provider.lastErrorMessage = null;

            // 清除定时恢复时间（如果有）
            if (provider.scheduledRecoveryTime) {
                provider.scheduledRecoveryTime = null;
            }

            resetCount++;
            console.log(`   ✅ 已重置: ${name}`);
        }
    });

    console.log('');
    console.log(`✨ 成功重置 ${resetCount} 个节点`);
    console.log('');

    // 7. 保存到文件
    console.log('💾 保存配置文件...');
    try {
        // 创建备份
        const backupPath = configPath + '.backup.' + Date.now();
        writeFileSync(backupPath, JSON.stringify(providerPools, null, 2), 'utf-8');
        console.log(`   📦 已创建备份: ${backupPath}`);

        // 保存更新后的配置
        writeFileSync(configPath, JSON.stringify(providerPools, null, 2), 'utf-8');
        console.log(`   ✅ 配置已保存: ${CONFIG_FILE}`);
    } catch (error) {
        console.error('❌ 错误: 无法保存配置文件:', error.message);
        process.exit(1);
    }

    console.log('');

    // 8. 调用系统 reload 接口
    const reloadSuccess = await reloadSystemConfig();

    console.log('');
    console.log('='.repeat(60));
    console.log('🎉 重置完成！');
    console.log('='.repeat(60));
    console.log('');

    if (!reloadSuccess) {
        console.log('⚠️  注意事项:');
        console.log('   1. 配置文件已更新，但系统未自动重新加载');
        console.log('   2. 请手动重启服务或在管理界面点击"重新加载配置"');
        console.log('   3. 备份文件已保存，如需恢复可手动替换');
        console.log('');
    } else {
        console.log('✅ 系统已自动重新加载配置，更改已生效！');
        console.log('');
    }
}

// 执行脚本
(async () => {
    try {
        await resetKiroHealth();
    } catch (error) {
        console.error('');
        console.error('❌ 脚本执行失败:', error.message);
        console.error('');
        console.error('堆栈信息:');
        console.error(error.stack);
        process.exit(1);
    }
})();
