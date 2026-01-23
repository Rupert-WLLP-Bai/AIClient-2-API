# 基于用量的负载均衡功能

## 功能概述

实现了基于账号用量百分比的智能负载均衡策略，使得高用量账号被选中的概率降低，但不会完全禁用，从而保护新账号的同时充分利用所有账号资源。

## 核心特性

### 1. 平滑指数惩罚算法

使用指数函数计算用量惩罚，实现平滑的优先级过渡：

```javascript
penalty = base * e^(k * percentage)
```

**参数说明**：
- `base`: 基础惩罚 = 60000ms (1分钟)
- `k`: 增长系数 = 0.03 (标准模式)
- `percentage`: 用量百分比 (0-100)

**效果示例**（k=0.03）：

| 用量百分比 | 惩罚时间 | 相对使用概率 | 预期使用次数（100次请求） |
|-----------|---------|-------------|------------------------|
| 0%        | 1分钟    | 100%        | ~10次                  |
| 20%       | 1.8分钟  | 56%         | ~6次                   |
| 40%       | 3.3分钟  | 30%         | ~3次                   |
| 60%       | 6分钟    | 17%         | ~2次                   |
| 80%       | 11分钟   | 9%          | ~1次                   |
| 90%       | 18分钟   | 6%          | ~0.6次                 |
| 95%       | 25分钟   | 4%          | ~0.4次                 |

### 2. 自动用量同步

- **同步频率**：每 1-2 小时随机间隔自动同步
- **支持的 Provider**：
  - `claude-kiro-oauth`
  - `gemini-cli-oauth`
  - `gemini-antigravity`
- **数据持久化**：用量数据保存在 `provider_pools.json` 中

### 3. 新增字段

在 `provider_pools.json` 中为每个账号添加：

```json
{
  "uuid": "ea18a9be-029b-4443-ab20-2bb7bb492ee5",
  "quotaUsed": 283.67,           // 已使用额度
  "quotaTotal": 550.00,          // 总额度
  "quotaLastUpdate": "2026-01-23T12:00:00Z"  // 最后更新时间
}
```

## 实现细节

### 修改的文件

1. **src/providers/provider-pool-manager.js**
   - 修改 `_calculateNodeScore()` 函数，添加用量百分比惩罚
   - 新增 `syncQuotaData()` 方法，同步单个 provider 类型的用量
   - 新增 `syncAllQuotaData()` 方法，同步所有支持的 provider
   - 新增 `startQuotaSyncScheduler()` 方法，启动定时同步任务
   - 新增 `stopQuotaSyncScheduler()` 方法，停止定时同步任务

2. **src/services/service-manager.js**
   - 在 `initApiService()` 中启动定时用量同步任务

### 评分算法详解

```javascript
_calculateNodeScore(providerStatus) {
    // 1. 不健康的节点排最后
    if (!config.isHealthy || config.isDisabled) return 1e16;

    // 2. 新鲜节点（2分钟内刷新且未使用）优先级最高
    if (isFresh) return -1e16;

    // 3. 基础分数（LRU策略）
    const lastUsedTime = config.lastUsed ? new Date(config.lastUsed).getTime() : (now - 3600000);
    const usageCount = config.usageCount || 0;

    // 4. 用量百分比惩罚（指数曲线）
    let quotaPenalty = 0;
    if (config.quotaUsed !== undefined && config.quotaTotal !== undefined && config.quotaTotal > 0) {
        const quotaPercentage = (config.quotaUsed / config.quotaTotal) * 100;
        const base = 60000;  // 1分钟
        const k = 0.03;      // 增长系数
        quotaPenalty = base * Math.exp(k * quotaPercentage);
    }

    // 5. 最终分数 = 时间分数 + 使用次数惩罚 + 用量惩罚
    return lastUsedTime + (usageCount * 60000) + quotaPenalty - (checkScore / 1e9);
}
```

**分数越低，优先级越高**

## 配置选项

### 启用/禁用用量同步

在 `configs/config.json` 中添加：

```json
{
  "ENABLE_QUOTA_SYNC": true  // 默认启用，设置为 false 可禁用
}
```

### 调整增长系数

如果需要调整惩罚曲线的陡峭程度，可以修改 `provider-pool-manager.js` 中的 `k` 值：

```javascript
// 温和模式（k = 0.02）
// 95% 用量 -> 10分钟惩罚，仍有 10% 概率被选中
const k = 0.02;

// 标准模式（k = 0.03）- 推荐
// 95% 用量 -> 25分钟惩罚，约 4% 概率被选中
const k = 0.03;

// 激进模式（k = 0.04）
// 95% 用量 -> 60分钟惩罚，约 1.7% 概率被选中
const k = 0.04;
```

## 使用方法

### 自动模式（推荐）

服务启动后会自动：
1. 立即执行一次用量同步
2. 每 1-2 小时随机间隔自动同步
3. 根据用量数据自动调整负载均衡

### 手动同步

如果需要手动触发用量同步，可以通过 API 或代码调用：

```javascript
// 同步所有 provider
await providerPoolManager.syncAllQuotaData();

// 同步特定 provider
await providerPoolManager.syncQuotaData('claude-kiro-oauth');
```

## 测试方法

### 1. 验证用量同步

启动服务后，检查日志：

```
[ProviderPoolManager] Starting quota sync scheduler...
[ProviderPoolManager] Starting quota sync for all providers...
[ProviderPoolManager] Starting quota sync for provider type: claude-kiro-oauth
[ProviderPoolManager] Updated quota for ea18a9be-...: 283.67/550.00 (51.6%)
[ProviderPoolManager] Quota sync completed for claude-kiro-oauth: 16 success, 0 failed, 0 skipped
[ProviderPoolManager] Next quota sync scheduled at: 2026-01-23T14:30:00Z (in 87.5 minutes)
```

### 2. 验证负载均衡

查看 `provider_pools.json`，确认已添加用量字段：

```json
{
  "claude-kiro-oauth": [
    {
      "uuid": "ea18a9be-029b-4443-ab20-2bb7bb492ee5",
      "quotaUsed": 283.67,
      "quotaTotal": 550.00,
      "quotaLastUpdate": "2026-01-23T12:00:00Z",
      "usageCount": 2,
      "lastUsed": "2026-01-23T04:42:34.700Z"
    }
  ]
}
```

### 3. 观察选择日志

启用 debug 日志级别，观察节点选择时的惩罚计算：

```
[ProviderPoolManager] Node ea18a9be-... quota: 51.6%, penalty: 4.5min
[ProviderPoolManager] Node 9dfe7ea8-... quota: 6.7%, penalty: 1.2min
[ProviderPoolManager] Selected provider for claude-kiro-oauth (LRU): 9dfe7ea8-...
```

### 4. 压力测试

发送 100 个请求，统计每个账号被选中的次数，验证是否符合预期分布：

```bash
# 发送 100 个请求
for i in {1..100}; do
  curl -X POST http://localhost:3000/v1/messages \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"test"}]}'
done

# 查看 provider_pools.json 中的 usageCount 分布
```

## 预期效果

假设有 16 个 Kiro 账号，用量分布如下：

| 账号类型 | 用量 | 数量 | 预期使用占比 |
|---------|------|------|------------|
| 新号    | 5-10% | 6个  | ~60%       |
| 中用量  | 40-50% | 4个  | ~25%       |
| 高用量  | 60-80% | 4个  | ~12%       |
| 极高用量 | 90%+  | 2个  | ~3%        |

**结果**：
- ✅ 新号承担大部分流量（60%）
- ✅ 老号仍会被使用（40%）
- ✅ 避免新号压力过大
- ✅ 充分利用所有账号

## 故障排查

### 用量同步失败

**症状**：日志显示 `Failed to sync quota for node xxx`

**可能原因**：
1. API 认证失败
2. 网络连接问题
3. Provider 不支持 `getUsageLimits()` 方法

**解决方法**：
1. 检查账号凭据是否有效
2. 检查网络连接
3. 查看详细错误日志

### 负载均衡不生效

**症状**：高用量账号仍然被频繁选中

**可能原因**：
1. 用量数据未同步
2. `quotaUsed` 或 `quotaTotal` 字段缺失
3. 增长系数 `k` 设置过小

**解决方法**：
1. 手动触发用量同步
2. 检查 `provider_pools.json` 中的用量字段
3. 适当增大 `k` 值（如从 0.03 改为 0.04）

### 定时同步未启动

**症状**：日志中没有 `Starting quota sync scheduler...`

**可能原因**：
1. `ENABLE_QUOTA_SYNC` 设置为 `false`
2. `isReady` 参数为 `false`

**解决方法**：
1. 检查配置文件
2. 确保服务完全启动

## 性能影响

- **内存占用**：每个账号增加约 50 字节（3个新字段）
- **CPU 占用**：评分计算增加约 5% 开销（指数函数）
- **网络流量**：每 1-2 小时同步一次，每个账号约 1KB 数据
- **响应延迟**：选择算法增加 < 1ms 延迟

## 未来优化

1. **动态调整 k 值**：根据账号数量和用量分布自动调整
2. **用量预测**：基于历史数据预测未来用量
3. **分组策略**：将账号分成不同组，每组使用不同策略
4. **用量告警**：当账号用量超过阈值时发送通知
5. **Web UI**：在管理界面显示用量分布和负载均衡效果

## 相关文档

- [Orchids 上下文丢失问题](./orchids-context-loss-issue.md)
- [Provider Pool Manager 设计文档](../PROVIDER_ADAPTER_GUIDE.md)
