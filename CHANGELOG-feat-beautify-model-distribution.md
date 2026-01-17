# CHANGELOG - feat/beautify-model-distribution

## Branch Purpose
美化 Analytics Dashboard 中的模型分布图表展示

## Key Features

### 1. 模型分布图表优化
- 改为水平柱状图显示
- 添加百分比显示
- 添加数据表格展示

### 2. Dashboard 整体美化
- 现代化图表设计
- 玻璃态 UI 效果
- 改进图表布局和样式

### 3. 其他图表改进
- Token Usage Trend 图表优化
- 修复图表布局问题
- 调整默认时间范围为 24h

### 4. 健康监控功能
- Kiro 健康重置脚本
- 增加错误阈值

## Commits (16 total)
- `9e55f34` feat(provider): add kiro health reset script and increase error threshold
- `f7e2bfd` feat(analytics): beautify dashboard with modern charts and glassmorphism ui
- `becfc4e` feat: 改进 Model Distribution 图表 - 改为水平柱状图并添加百分比和数据表格
- `ccd00b7` feat: 改进 Token Usage Trend 图表和启动脚本
- `7ec8722` feat: 修改默认时间范围为 24h
- `3a357bf` fix: 修复图表布局问题 - 设置固定高度防止拉伸
- `1074ac9` style(dashboard): fix token usage chart layout and hide data labels
- `ba29fb2` adjust layout of token chart
- ... (8 more commits)

## Modified Files
- `analytics/dashboard/public/app.js` - Dashboard 前端逻辑
- `analytics/dashboard/public/index.html` - Dashboard HTML
- `analytics/dashboard/server.js` - Dashboard 服务器
- `scripts/reset-kiro-health.js` - 健康重置脚本 (新增)

## Status
- 领先 main 分支 16 个提交
- 未推送到 myfork
- 包含了 dashboard 美化和健康监控功能
