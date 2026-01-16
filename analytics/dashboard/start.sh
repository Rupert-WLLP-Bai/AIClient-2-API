#!/bin/bash

# 使用统计看板启动脚本

cd "$(dirname "$0")"

echo "=========================================="
echo "  使用统计看板 - AIClient-2-API"
echo "=========================================="
echo

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未找到 Node.js，请先安装"
    exit 1
fi

# 检查数据库文件
DB_PATH="../../data/stats.db"
if [ ! -f "$DB_PATH" ]; then
    echo "[警告] 数据库文件不存在: $DB_PATH"
    echo "[提示] 请先运行主服务以生成统计数据"
    echo
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "[安装] 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[错误] 依赖安装失败"
        exit 1
    fi
    echo "[成功] 依赖安装完成"
    echo
fi

# 启动服务器
echo "[启动] 正在启动看板服务器（开发模式 - 热重载）..."
echo "[提示] 修改 server.js 或 public/ 下的文件后会自动重启"
echo
npm run dev
