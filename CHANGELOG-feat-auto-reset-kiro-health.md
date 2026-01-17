# CHANGELOG - feat/auto-reset-kiro-health

## Branch Purpose
为 Kiro 提供商添加自动健康状态重置监控功能

## Key Features

### 1. 自动重置监控
- 监控 Kiro 健康状态
- 自动触发重置机制
- 防止长时间服务不可用

### 2. 健康重置脚本
- 手动重置 Kiro 健康状态的工具
- 增加错误阈值配置
- 提高系统容错能力

### 3. Dashboard 改进
- 包含了 dashboard 美化相关的提交
- 图表布局优化
- 统计功能增强

## Commits (16 total)
- `0658a4a` feat(provider): add auto-reset monitoring for kiro health status
- `9e55f34` feat(provider): add kiro health reset script and increase error threshold
- `f7e2bfd` feat(analytics): beautify dashboard with modern charts and glassmorphism ui
- ... (13 more commits related to dashboard and log tracking)

## Modified Files
- `scripts/auto-reset-kiro-health.js` - 自动重置监控脚本 (新增)
- `scripts/reset-kiro-health.js` - 手动重置脚本 (新增)
- `src/providers/provider-pool-manager.js` - 提供商池管理器
- `analytics/dashboard/*` - Dashboard 相关文件

## Status
- 领先 main 分支 16 个提交
- 未推送到 myfork
- 包含了多个功能的合并
