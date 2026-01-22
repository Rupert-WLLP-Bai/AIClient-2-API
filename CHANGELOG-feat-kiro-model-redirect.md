# CHANGELOG - feat/kiro-model-redirect

## Branch Purpose
Kiro 模型重定向功能 - 将 Opus 和 Haiku 模型重定向到 Sonnet-4-5，并添加健康监控和统计分析系统

## Key Features

### 1. 模型重定向
- 将 claude-opus-4-5 重定向到 claude-sonnet-4-5（Haiku 重定向已移除，见下文）
- 在统计数据库中记录重定向后的模型名称

### 2. 健康监控系统
- 自动重置 Kiro 健康状态的监控脚本
- 手动重置 Kiro 健康状态的脚本
- 增加错误阈值配置

### 3. 统计分析系统
- 完整的统计数据收集服务 (stats-collector.js, stats-database.js)
- 错误分析脚本 (analyze-stats-errors.js)
- 数据库检查工具 (inspect_db.js)

### 4. Analytics Dashboard
- 现代化的可视化看板系统
- 玻璃态 UI 设计
- 支持使用统计、模型分布、Token 使用趋势等可视化
- 暗色主题、日期选择器、详细日志模态框

## Problems & Solutions

### 1. 模型重定向逻辑调整
- **Haiku 调整**: 移除了 `claude-haiku-4-5` 的本地重定向逻辑。
  - **原因**: 本地环境需要配置：
    ```json
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5"
    ```
    如果强制将 `haiku` 重定向到 `sonnet`，会导致某些依赖特定模型配置的本地逻辑报错。
- **Opus 保留**: 维持 `opus` 重定向到 `claude-sonnet-4-5` 的逻辑。
  - **原因**: 主要是因为 Kiro 的 Free Plan 取消了对 Opus 的支持，本地暂时无法直接调用，需重定向到 Sonnet 4.5 以确保请求可用性。

## Modified Files
- `src/providers/claude/claude-kiro.js` - Kiro 提供商逻辑（调整重定向过滤规则）
- `src/handlers/request-handler.js` - 请求处理器
- `src/services/stats-collector.js` - 统计收集服务 (新增)
- `src/services/stats-database.js` - 统计数据库服务 (新增)
- `scripts/auto-reset-kiro-health.js` - 自动重置脚本 (新增)
- `scripts/reset-kiro-health.js` - 手动重置脚本 (新增)
- `scripts/analyze-stats-errors.js` - 错误分析脚本 (新增)
- `analytics/dashboard/*` - 完整的 Dashboard 系统 (新增)

## Status
- 领先 main 分支 21 个提交
- 未推送到 myfork
