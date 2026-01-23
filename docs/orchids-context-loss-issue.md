# Orchids Provider 上下文丢失问题

## 问题描述

使用 `claude-orchids-oauth` provider 时，Claude 会反复查看文档和目录结构，无法继续执行任务，表现为：
- 反复调用 Read、Ls、Bash 等工具查看相同的文件
- 每次工具调用后似乎丢失了之前的上下文
- 无法推进任务，一直停留在探索阶段

而使用 `claude-kiro-oauth` provider 时没有这个问题。

## 问题分析

### 根本原因

从日志可以看到，使用 orchids 时，**每次请求都会切换到不同的账号 UUID**：

```
[API Service] Using pooled configuration for claude-orchids-oauth: 76f83958-a52f-4067-a90f-856ce05420bd
[API Service] Using pooled configuration for claude-orchids-oauth: 34075996-f277-4548-9fe3-12e046486237
[API Service] Using pooled configuration for claude-orchids-oauth: 9c37c167-2350-4489-bdf9-586deb98104c
[API Service] Using pooled configuration for claude-orchids-oauth: fcd1aa24-d15e-4e5e-8abd-5b70f29cad42
```

每次工具调用后的新请求，都会从 provider 池中重新选择账号，导致频繁切换。

### 代码位置

**问题代码**：`src/utils/common.js:686-708`

```javascript
// 2.5. 如果使用了提供商池，根据模型重新选择提供商（支持 Fallback）
if (providerPoolManager && CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]) {
    const { getApiServiceWithFallback } = await import('../services/service-manager.js');
    const result = await getApiServiceWithFallback(CONFIG, model);

    service = result.service;
    toProvider = result.actualProviderType;
    actualUuid = result.uuid || pooluuid;
    // ...
    console.log(`[Content Generation] Re-selected service adapter based on model: ${model}`);
}
```

每次请求都会调用 `getApiServiceWithFallback` 重新选择 provider。

### 为什么 Kiro 没问题？

从配置文件 `configs/config.json` 可以看到：

```json
{
  "MODEL_PROVIDER": "claude-kiro-oauth,claude-orchids-oauth",
  "providerFallbackChain": {
    "claude-kiro-oauth": ["claude-orchids-oauth"]
  }
}
```

**Kiro 的行为**：
- 有 fallback 链配置：kiro -> orchids
- 通常会保持使用同一个健康的 kiro 账号
- 只有在账号不健康时才会切换

**Orchids 的行为**：
- 没有 fallback 链配置
- 每次请求都会在 orchids 池内轮询选择
- 导致频繁切换不同的账号

### 轮询逻辑

Provider 池的选择逻辑在 `src/providers/provider-pool-manager.js:520-607`：

```javascript
selectProvider(providerType, requestedModel = null, options = {}) {
    // 使用轮询策略选择 provider
    // 每次调用都会选择下一个健康的 provider
}
```

## 为什么会导致上下文丢失？

1. **Claude 的对话机制**：每次 API 请求都是独立的，需要通过 conversation history 来维持上下文
2. **账号切换**：虽然 conversation history 相同，但切换到不同的 orchids 账号可能导致：
   - 不同账号的 session 状态不同
   - 可能触发不同的限流或缓存策略
   - Claude 可能认为这是不同的会话

3. **表现症状**：
   - Claude 认为上下文丢失
   - 重新开始探索和理解任务
   - 反复查看相同的文件和目录

## 尝试的解决方案（失败）

### 方案 1：Provider 复用逻辑

在 `src/utils/common.js` 中添加逻辑，复用同一个 provider UUID：

```javascript
// 如果已经有 pooluuid，尝试复用同一个 provider
if (pooluuid && CONFIG.uuid === pooluuid) {
    // 复用当前的 service，不重新选择
    console.log(`[Content Generation] Reusing existing provider: ${pooluuid} (model: ${model})`);
    toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    actualUuid = pooluuid;
    actualCustomName = CONFIG.customName;
} else {
    // 第一次请求或需要重新选择
    const result = await getApiServiceWithFallback(CONFIG, model);
    // ...
}
```

**结果**：仍然有问题（用户反馈）

**可能原因**：
- `pooluuid` 和 `CONFIG.uuid` 的传递机制可能有问题
- 需要在更上层维护会话状态
- 可能需要在 session 级别而不是 request 级别维护 provider 选择

## 待解决的问题

1. **如何在同一个对话会话中保持使用同一个 provider？**
   - 需要识别同一个对话会话（可能需要 session ID）
   - 在会话级别缓存 provider 选择
   - 只有在 provider 不健康时才切换

2. **为什么 Kiro 没有这个问题？**
   - 是否因为 fallback 链的存在？
   - 还是因为 kiro 池的选择策略不同？
   - 需要进一步调查

3. **是否需要修改 ProviderPoolManager 的选择策略？**
   - 当前是轮询策略
   - 是否应该改为粘性会话（sticky session）策略？
   - 如何识别同一个会话？

## 相关代码文件

- `src/utils/common.js:654-750` - 请求处理和 provider 选择
- `src/services/service-manager.js:291-339` - getApiServiceWithFallback
- `src/providers/provider-pool-manager.js:520-607` - selectProvider
- `src/providers/provider-pool-manager.js:621-760` - selectProviderWithFallback
- `configs/config.json` - Provider 配置和 fallback 链

## 日志示例

### Orchids 频繁切换（有问题）

```
1/23/2026, 12:22:53 PM
[API Service] Using pooled configuration for claude-orchids-oauth: 76f83958-a52f-4067-a90f-856ce05420bd
[Orchids] Tool call started: Read (tooluse_lXARCHi3TI2fFCdcomMZLA)

1/23/2026, 12:23:09 PM
[API Service] Using pooled configuration for claude-orchids-oauth: 9c37c167-2350-4489-bdf9-586deb98104c
[Orchids] Tool call started: Read (tooluse_V72w_F4kSNWmCUgJFohCkA)

1/23/2026, 12:23:26 PM
[API Service] Using pooled configuration for claude-orchids-oauth: 9b711bfe-aeb8-4bdb-9d2e-d48793fd6c6a
[Orchids] Tool call started: Read (tooluse_coBiDOzsTKWHn9Bz8EDRQw)
```

### Kiro 保持同一个账号（正常）

```
[API Service] Using pooled configuration for claude-kiro-oauth: <same-uuid>
[Kiro] Tool call started: ...
[API Service] Using pooled configuration for claude-kiro-oauth: <same-uuid>
[Kiro] Tool call started: ...
```

## 临时解决方案

在配置中为 orchids 添加 fallback 链：

```json
{
  "providerFallbackChain": {
    "claude-kiro-oauth": ["claude-orchids-oauth"],
    "claude-orchids-oauth": []
  }
}
```

但这只是避免问题，并没有真正解决根本原因。

## 下一步

1. 调查 `pooluuid` 的传递机制
2. 考虑在更上层（如 API server 层）维护会话状态
3. 研究是否需要修改 ProviderPoolManager 的选择策略
4. 考虑添加 session ID 机制来识别同一个对话会话
