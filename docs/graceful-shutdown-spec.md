# 优雅停机机制规范文档

## 1. 概述

本文档描述了一个基于 Node.js 的 API 服务的优雅停机（Graceful Shutdown）机制。该机制采用主从进程架构，确保在收到终止信号时能够安全地关闭服务，保存数据，清理资源。

### 1.1 目标

- 停止接受新的连接请求
- 等待现有请求完成处理
- 持久化内存中的数据
- 清理系统资源（数据库连接、定时任务等）
- 防止进程无限期挂起（超时保护）

### 1.2 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        主进程 (Master)                        │
│  - 监控子进程健康状态                                          │
│  - 处理 SIGTERM/SIGINT 信号                                   │
│  - 协调优雅关闭流程                                            │
│  - 超时后强制杀死子进程                                        │
└────────────────────┬────────────────────────────────────────┘
                     │ IPC 通信 + 信号
                     │
┌────────────────────▼────────────────────────────────────────┐
│                      工作进程 (Worker)                        │
│  - 运行 HTTP 服务器                                           │
│  - 处理 API 请求                                              │
│  - 管理内存数据（API Keys、统计数据等）                        │
│  - 执行资源清理                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 信号处理

### 2.1 主进程信号处理

主进程需要捕获以下信号：

| 信号 | 来源 | 处理方式 |
|------|------|---------|
| `SIGTERM` | 系统或进程管理器 | 触发优雅关闭 |
| `SIGINT` | 用户按 Ctrl+C | 触发优雅关闭 |

**处理逻辑**：
```javascript
process.on('SIGTERM', async () => {
    console.log('[Master] Received SIGTERM, shutting down...');
    await stopWorker(true);  // 优雅关闭子进程
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Master] Received SIGINT, shutting down...');
    await stopWorker(true);  // 优雅关闭子进程
    process.exit(0);
});
```

### 2.2 工作进程信号处理

工作进程需要捕获以下信号和事件：

| 信号/事件 | 来源 | 处理方式 |
|----------|------|---------|
| `SIGTERM` | 主进程或系统 | 触发优雅关闭 |
| `SIGINT` | 直接运行时用户按 Ctrl+C | 触发优雅关闭 |
| `uncaughtException` | 未捕获的异常 | 触发优雅关闭 |
| `unhandledRejection` | 未处理的 Promise 拒绝 | 仅记录日志，不退出 |
| IPC 消息 `{type: 'shutdown'}` | 主进程 | 触发优雅关闭 |

---

## 3. 优雅关闭流程

### 3.1 完整流程图

```
用户按 Ctrl+C
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. 主进程收到 SIGINT 信号                │
│    - 打印日志                            │
│    - 调用 stopWorker(true)              │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 2. 主进程向子进程发送关闭指令            │
│    - 发送 IPC 消息: {type: 'shutdown'}  │
│    - 发送 SIGTERM 信号                  │
│    - 启动 5 秒超时计时器                │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 3. 子进程收到关闭指令                    │
│    - 打印日志                            │
│    - 调用 gracefulShutdown()            │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 4. 子进程执行优雅关闭                    │
│    a. 停止接受新连接                     │
│       server.close()                    │
│                                         │
│    b. 启动 10 秒超时计时器               │
│                                         │
│    c. 并行执行资源清理：                 │
│       - 保存 API Key 数据               │
│       - 刷新统计数据队列                │
│       - 关闭数据库连接                  │
│       - 停止定时任务                    │
│       - 关闭临时服务器                  │
│                                         │
│    d. 等待所有 HTTP 连接关闭             │
│       或超时（10 秒）                    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 5. 子进程退出                            │
│    - 成功: exit(0)                      │
│    - 超时: exit(1)                      │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 6. 主进程检测到子进程退出                │
│    - 清理子进程引用                      │
│    - 打印日志                            │
│    - 主进程退出: exit(0)                │
└─────────────────────────────────────────┘
```

### 3.2 超时保护机制

系统采用**两层超时保护**，防止进程无限期挂起：

#### 第一层：工作进程超时（10 秒）

```javascript
async function gracefulShutdown() {
    console.log('[Server] Initiating graceful shutdown...');

    if (serverInstance) {
        serverInstance.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });

        // 10 秒超时保护
        setTimeout(() => {
            console.log('[Server] Shutdown timeout, forcing exit...');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}
```

#### 第二层：主进程超时（5 秒）

```javascript
function stopWorker(graceful = true) {
    return new Promise((resolve) => {
        if (!workerProcess) {
            resolve();
            return;
        }

        // 5 秒超时后强制杀死
        const timeout = setTimeout(() => {
            if (workerProcess) {
                console.log('[Master] Force killing worker process...');
                workerProcess.kill('SIGKILL');
            }
            resolve();
        }, 5000);

        workerProcess.once('exit', () => {
            clearTimeout(timeout);
            workerProcess = null;
            resolve();
        });

        if (graceful) {
            // 发送优雅关闭信号
            workerProcess.send({ type: 'shutdown' });
            workerProcess.kill('SIGTERM');
        } else {
            workerProcess.kill('SIGKILL');
        }
    });
}
```

**超时策略**：
- 工作进程有 10 秒时间完成清理
- 如果工作进程 10 秒内未退出，主进程会在 5 秒后强制杀死
- 实际最长等待时间：10 秒（工作进程超时）

---

## 4. 资源清理详解

### 4.1 HTTP 服务器关闭

**目标**：停止接受新连接，等待现有连接完成

```javascript
serverInstance.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
});
```

**行为**：
- 立即停止监听新连接
- 保持现有连接活跃
- 等待所有连接自然关闭
- 回调触发时表示所有连接已关闭

### 4.2 API Key 数据持久化

**目标**：将内存中的 API Key 数据安全写入文件

**数据结构**：
```javascript
{
    "keys": [
        {
            "key": "sk-xxx",
            "provider": "openai",
            "model": "gpt-4",
            "lastUsed": 1234567890,
            "errorCount": 0
        }
    ]
}
```

**原子写入流程**：
```javascript
async function persistIfDirty() {
    if (!isDirty || isWriting) return;

    isWriting = true;
    try {
        // 1. 写入临时文件
        const tempFile = KEYS_STORE_FILE + '.tmp';
        await fs.writeFile(tempFile, JSON.stringify(keyStore, null, 2), 'utf8');

        // 2. 原子重命名（覆盖旧文件）
        await fs.rename(tempFile, KEYS_STORE_FILE);

        isDirty = false;
        console.log('[API Key Manager] Data persisted');
    } catch (error) {
        console.error('[API Key Manager] Persist failed:', error.message);
    } finally {
        isWriting = false;
    }
}
```

**关键特性**：
- 使用临时文件 + 重命名，防止写入中断导致数据损坏
- 标记 `isDirty` 避免重复写入
- 标记 `isWriting` 防止并发写入

**触发时机**：
- 定期自动保存（每 N 秒）
- 收到 `SIGINT`/`SIGTERM` 信号时
- 进程 `beforeExit` 事件时

### 4.3 统计数据刷新

**目标**：将内存中的统计数据批量写入数据库

**数据结构**（内存队列）：
```javascript
[
    {
        timestamp: 1234567890,
        provider: "openai",
        model: "gpt-4",
        tokens: 1000,
        cost: 0.02
    },
    // ... 更多记录
]
```

**刷新逻辑**：
```javascript
function flushQueue() {
    if (writeQueue.length === 0) return;

    const batch = writeQueue.splice(0, writeQueue.length);

    try {
        // 批量插入数据库
        const stmt = db.prepare('INSERT INTO stats VALUES (?, ?, ?, ?, ?)');
        const transaction = db.transaction((records) => {
            for (const record of records) {
                stmt.run(record.timestamp, record.provider, record.model,
                        record.tokens, record.cost);
            }
        });
        transaction(batch);

        console.log(`[Stats Collector] Flushed ${batch.length} records`);
    } catch (error) {
        console.error('[Stats Collector] Flush failed:', error.message);
        // 失败时重新加入队列
        writeQueue.unshift(...batch);
    }
}
```

**关键特性**：
- 使用事务批量写入，提升性能
- 失败时重新加入队列，避免数据丢失

### 4.4 数据库连接关闭

**目标**：安全关闭 SQLite 数据库连接

```javascript
function closeDatabase() {
    if (db) {
        db.close();
        console.log('[Stats Database] Connection closed');
    }
}
```

**数据库特性**：
- 使用 **WAL 模式**（Write-Ahead Logging）
- 关闭时自动刷新 WAL 日志到主数据库文件
- 确保数据持久化

### 4.5 定时任务清理

**目标**：停止所有定时任务

```javascript
function stopCleanupTask() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log('[Stats Collector] Cleanup task stopped');
    }
}
```

### 4.6 临时 OAuth 服务器关闭

**目标**：关闭用于 OAuth 回调的临时 HTTP 服务器

```javascript
if (oauthServer) {
    oauthServer.close(() => {
        console.log('[OAuth] Temporary server closed');
    });
}
```

---

## 5. 进程间通信（IPC）

### 5.1 主进程 → 工作进程

**消息格式**：
```javascript
{
    type: 'shutdown'  // 关闭指令
}
```

**发送方式**：
```javascript
workerProcess.send({ type: 'shutdown' });
```

### 5.2 工作进程接收

```javascript
process.on('message', (msg) => {
    if (msg.type === 'shutdown') {
        console.log('[Worker] Shutdown requested by master');
        gracefulShutdown();
    }
});
```

---

## 6. 错误处理

### 6.1 未捕获异常

```javascript
process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error);
    gracefulShutdown();  // 触发优雅关闭
});
```

### 6.2 未处理的 Promise 拒绝

```javascript
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
    // 仅记录日志，不触发关闭
});
```

---

## 7. 实现要点总结

### 7.1 必须实现的功能

1. **信号处理**
   - [ ] 主进程捕获 SIGTERM/SIGINT
   - [ ] 工作进程捕获 SIGTERM/SIGINT
   - [ ] 工作进程捕获 uncaughtException

2. **进程管理**
   - [ ] 主进程启动工作进程
   - [ ] 主进程通过 IPC 发送关闭指令
   - [ ] 主进程监听工作进程退出事件

3. **HTTP 服务器**
   - [ ] 模拟 HTTP 服务器（接受连接）
   - [ ] 实现 `server.close()` 逻辑（停止接受新连接，等待现有连接）
   - [ ] 模拟长连接（至少 2-3 秒的请求处理时间）

4. **数据持久化**
   - [ ] 模拟内存数据（如 HashMap）
   - [ ] 实现原子写入（临时文件 + 重命名）
   - [ ] 在关闭时触发持久化

5. **超时保护**
   - [ ] 工作进程 10 秒超时
   - [ ] 主进程 5 秒超时
   - [ ] 超时后强制退出

6. **日志输出**
   - [ ] 每个关键步骤打印日志
   - [ ] 日志格式：`[进程类型] 消息内容`

### 7.2 可选的高级功能

- [ ] 统计数据批量写入（模拟数据库）
- [ ] 定时任务清理
- [ ] 多个工作进程管理
- [ ] 健康检查机制

---

## 8. 测试场景

### 8.1 正常关闭场景

**步骤**：
1. 启动程序
2. 模拟 2-3 个正在处理的请求（每个耗时 2 秒）
3. 按 Ctrl+C
4. 观察日志输出

**预期结果**：
```
[Master] Starting worker process...
[Worker] HTTP server started on port 8080
[Worker] Handling request 1...
[Worker] Handling request 2...
[Master] Received SIGINT, shutting down...
[Master] Stopping worker process, PID: 12345
[Worker] Shutdown requested by master
[Server] Received SIGTERM
[Server] Initiating graceful shutdown...
[API Key Manager] Persisting data...
[API Key Manager] Data persisted
[Worker] Request 1 completed
[Worker] Request 2 completed
[Server] HTTP server closed
[Master] Worker process stopped
[Master] Exiting...
```

### 8.2 超时强制关闭场景

**步骤**：
1. 启动程序
2. 模拟 1 个长时间请求（耗时 15 秒）
3. 按 Ctrl+C
4. 观察是否在 10 秒后强制退出

**预期结果**：
```
[Master] Starting worker process...
[Worker] HTTP server started on port 8080
[Worker] Handling long request (15s)...
[Master] Received SIGINT, shutting down...
[Master] Stopping worker process, PID: 12345
[Worker] Shutdown requested by master
[Server] Received SIGTERM
[Server] Initiating graceful shutdown...
[API Key Manager] Persisting data...
[API Key Manager] Data persisted
... 等待 10 秒 ...
[Server] Shutdown timeout, forcing exit...
[Master] Worker process stopped
[Master] Exiting...
```

### 8.3 数据持久化验证

**步骤**：
1. 启动程序
2. 模拟添加一些数据到内存（如 API Keys）
3. 按 Ctrl+C
4. 检查数据文件是否正确保存
5. 重新启动程序
6. 验证数据是否正确加载

**预期结果**：
- 数据文件存在且格式正确
- 重启后数据完整恢复

### 8.4 崩溃场景

**步骤**：
1. 启动程序
2. 模拟一个未捕获的异常
3. 观察是否触发优雅关闭

**预期结果**：
```
[Worker] Simulating uncaught exception...
[Server] Uncaught exception: Error: Simulated error
[Server] Initiating graceful shutdown...
[API Key Manager] Persisting data...
[API Key Manager] Data persisted
[Server] HTTP server closed
[Master] Worker process stopped
[Master] Exiting...
```

---

## 9. Rust 实现建议

### 9.1 推荐的 Crate

- **tokio**: 异步运行时
- **tokio::signal**: 信号处理
- **tokio::sync::mpsc**: 进程间通信（模拟 IPC）
- **tokio::time**: 超时控制
- **hyper** 或 **axum**: HTTP 服务器
- **serde_json**: JSON 序列化
- **tracing**: 日志输出

### 9.2 架构建议

```rust
// 主进程
async fn main() {
    let (tx, rx) = mpsc::channel(32);

    // 启动工作进程（实际是一个 tokio task）
    let worker_handle = tokio::spawn(worker_process(rx));

    // 监听信号
    tokio::select! {
        _ = signal::ctrl_c() => {
            println!("[Master] Received SIGINT, shutting down...");
            tx.send(ShutdownMessage).await.unwrap();
        }
    }

    // 等待工作进程退出（带超时）
    tokio::select! {
        _ = worker_handle => {
            println!("[Master] Worker process stopped");
        }
        _ = tokio::time::sleep(Duration::from_secs(5)) => {
            println!("[Master] Force killing worker process...");
            worker_handle.abort();
        }
    }
}

// 工作进程
async fn worker_process(mut rx: mpsc::Receiver<ShutdownMessage>) {
    let server = start_http_server();

    tokio::select! {
        _ = rx.recv() => {
            println!("[Worker] Shutdown requested by master");
            graceful_shutdown(server).await;
        }
        _ = signal::ctrl_c() => {
            println!("[Worker] Received SIGINT");
            graceful_shutdown(server).await;
        }
    }
}

// 优雅关闭
async fn graceful_shutdown(server: Server) {
    println!("[Server] Initiating graceful shutdown...");

    // 停止接受新连接
    server.close();

    // 并行执行清理任务
    let persist_task = tokio::spawn(persist_data());
    let flush_task = tokio::spawn(flush_stats());

    // 等待所有任务完成或超时
    tokio::select! {
        _ = tokio::join!(persist_task, flush_task, server.wait_for_connections()) => {
            println!("[Server] HTTP server closed");
        }
        _ = tokio::time::sleep(Duration::from_secs(10)) => {
            println!("[Server] Shutdown timeout, forcing exit...");
        }
    }
}
```

### 9.3 关键实现点

1. **使用 `tokio::select!` 实现超时控制**
2. **使用 `mpsc::channel` 模拟 IPC 通信**
3. **使用 `tokio::spawn` 模拟子进程**
4. **使用 `Arc<AtomicBool>` 实现优雅关闭标志**
5. **使用 `tokio::fs` 实现异步文件操作**

---

## 10. 参考资料

- Node.js 信号处理：https://nodejs.org/api/process.html#signal-events
- HTTP Server 优雅关闭：https://nodejs.org/api/http.html#serverclosecallback
- Tokio 信号处理：https://docs.rs/tokio/latest/tokio/signal/
- Rust 优雅关闭模式：https://tokio.rs/tokio/topics/shutdown

---

## 附录：完整日志示例

### 正常关闭流程日志

```
[Master] Starting worker process...
[Master] Worker process started, PID: 12345
[Worker] Initializing HTTP server...
[Worker] HTTP server started on port 8080
[Worker] API Key Manager initialized
[Worker] Stats Collector initialized
[Worker] Ready to accept connections

[Worker] Received request: GET /api/chat
[Worker] Handling request 1 (estimated 2s)...
[Worker] Received request: POST /api/completion
[Worker] Handling request 2 (estimated 3s)...

[Master] Received SIGINT, shutting down...
[Master] Stopping worker process, PID: 12345
[Master] Sending shutdown message to worker...
[Master] Sending SIGTERM to worker...
[Master] Waiting for worker to exit (timeout: 5s)...

[Worker] Received IPC message: {type: 'shutdown'}
[Worker] Shutdown requested by master
[Server] Received SIGTERM
[Server] Initiating graceful shutdown...
[Server] Stopped accepting new connections
[Server] Waiting for 2 active connections to close...
[Server] Starting cleanup tasks...

[API Key Manager] Persisting data...
[API Key Manager] Writing to temporary file: keys.json.tmp
[API Key Manager] Renaming to: keys.json
[API Key Manager] Data persisted successfully (5 keys)

[Stats Collector] Flushing queue...
[Stats Collector] Flushed 127 records to database

[Stats Database] Closing connection...
[Stats Database] WAL checkpoint completed
[Stats Database] Connection closed

[Worker] Request 1 completed (200 OK)
[Worker] Request 2 completed (200 OK)
[Server] All connections closed
[Server] HTTP server closed
[Worker] Exiting with code 0

[Master] Worker process exited with code 0
[Master] Cleanup completed
[Master] Exiting with code 0
```

---

**文档版本**: 1.0
**创建日期**: 2026-01-20
**适用于**: Rust 实现模拟版本
