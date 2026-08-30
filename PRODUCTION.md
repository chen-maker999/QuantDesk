# QuantDesk 生产环境部署指南

## P1: HTTPS 安全配置

### 方案1：自签证书（开发/内网环境）

**启用自签证书**：
```powershell
# Windows
$env:QUANTDESK_ENGINE_TLS="1"
python engine/main.py
```

```bash
# Linux/macOS
export QUANTDESK_ENGINE_TLS=1
python engine/main.py
```

引擎会自动在 `~/.quantdesk/` 目录生成自签证书：
- `engine_cert.pem` - 证书文件
- `engine_key.pem` - 私钥文件

**客户端配置**：
- 桌面端：需在系统信任该证书或在代码中忽略证书验证
- 移动端：浏览器会提示不安全，需手动添加例外

### 方案2：Let's Encrypt 证书（生产环境推荐）

**前置条件**：
- 公网可访问的域名（如 `quantdesk.example.com`）
- 服务器 80 端口可访问（Let's Encrypt ACME 验证）

**步骤1：安装 certbot**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install certbot

# CentOS/RHEL
sudo yum install certbot
```

**步骤2：申请证书**
```bash
sudo certbot certonly --standalone -d quantdesk.example.com
```

证书会生成在：
- 证书：`/etc/letsencrypt/live/quantdesk.example.com/fullchain.pem`
- 私钥：`/etc/letsencrypt/live/quantdesk.example.com/privkey.pem`

**步骤3：配置引擎使用证书**
```bash
export QUANTDESK_ENGINE_TLS=1
export QUANTDESK_TLS_CERT=/etc/letsencrypt/live/quantdesk.example.com/fullchain.pem
export QUANTDESK_TLS_KEY=/etc/letsencrypt/live/quantdesk.example.com/privkey.pem
export QUANTDESK_ENGINE_HOST=0.0.0.0
python engine/main.py
```

**步骤4：自动续期**
```bash
# 添加到 crontab（每月1日凌晨3点检查续期）
0 3 1 * * certbot renew --quiet && systemctl restart quantdesk
```

### 方案3：反向代理（Nginx推荐）

适合已有Nginx的生产环境，引擎保持HTTP，由Nginx处理HTTPS。

**Nginx配置**：
```nginx
upstream quantdesk_backend {
    server 127.0.0.1:8765;
}

server {
    listen 443 ssl http2;
    server_name quantdesk.example.com;

    ssl_certificate /etc/letsencrypt/live/quantdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/quantdesk.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # WebSocket 支持（Agent SSE需要）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 超时配置（Agent流式响应可能较长）
    proxy_read_timeout 300s;
    proxy_connect_timeout 75s;

    location / {
        proxy_pass http://quantdesk_backend;
    }

    # API 文档
    location /docs {
        proxy_pass http://quantdesk_backend;
    }

    location /redoc {
        proxy_pass http://quantdesk_backend;
    }
}

# HTTP 自动跳转 HTTPS
server {
    listen 80;
    server_name quantdesk.example.com;
    return 301 https://$server_name$request_uri;
}
```

**启动引擎**（HTTP模式，由Nginx处理HTTPS）：
```bash
export QUANTDESK_ENGINE_HOST=127.0.0.1
python engine/main.py
```

---

## P2: API 文档访问

### Swagger UI（交互式文档）

启动引擎后访问：
```
http://localhost:8765/docs
```

或HTTPS模式：
```
https://quantdesk.example.com/docs
```

**功能**：
- 查看所有API端点
- 在线测试API（Try it out）
- 查看请求/响应模型
- 下载OpenAPI JSON

### ReDoc（美观文档）

```
http://localhost:8765/redoc
```

**特点**：
- 三栏布局
- 更易阅读
- 适合打印/导出

### OpenAPI JSON

```
http://localhost:8765/openapi.json
```

可用于：
- 生成客户端SDK（OpenAPI Generator）
- 导入Postman
- 生成测试用例

---

## 安全加固建议

## 已实现的生产前置能力

- 券商订单台账具备状态机保护：终态不可回退，成交数量不可减少或超过委托量。
- 券商下单支持 `client_order_id` 幂等键；同一 QuantDesk 引擎内的并发重试会串行化，避免重复提交。
- 数据库备份包含 SHA-256，可通过 `GET /backups/verify?file=<name>` 校验。
- `POST /backups/restore-drill?file=<name>` 执行只读恢复演练，不覆盖当前数据库。
- 非回环监听默认要求 TLS；TLS 证书生成失败时拒绝启动，不允许静默降级到 HTTP。
- 数据库迁移会为用户数据补充 `owner_id`，并修复旧版单账户持仓表结构。

验证示例：

```powershell
python -m pytest engine/tests -q
npm.cmd run build
npm.cmd --prefix mobile run build
cd src-tauri
cargo check
```

仍需外部凭证或组织流程的项目不能由本地代码自行完成：真实券商沙盒联调、第三方渗透测试、Windows 代码签名证书、签名更新密钥和公网部署证书。未完成这些项目时，不应切换真实资金模式。

### 1. 防火墙配置

**仅允许特定IP访问**（生产环境）：
```bash
# Ubuntu/Debian (ufw)
sudo ufw allow from 192.168.1.0/24 to any port 8765

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="8765" protocol="tcp" accept'
sudo firewall-cmd --reload
```

### 2. 速率限制

在Nginx中添加：
```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

location /agent/run {
    limit_req zone=api_limit burst=5;
    proxy_pass http://quantdesk_backend;
}
```

### 3. 移动端令牌轮换

定期轮换移动端访问令牌（建议30天）：
1. 桌面端生成新配对码
2. 手机端重新配对
3. 旧令牌自动失效

### 4. 审计日志

引擎日志位置：
- `engine/logs/engine.log` - 主日志（10MB×5轮转）
- `engine/logs/spawn.log` - 子进程日志

监控关键事件：
```bash
# 登录失败
grep "登录失败" engine/logs/engine.log

# 实盘操作
grep "实盘" engine/logs/engine.log

# API错误
grep "ERROR" engine/logs/engine.log
```

---

## 性能优化建议

### 1. 数据库优化

**启用WAL模式**（已默认启用）：
```python
# database.py
conn.execute("PRAGMA journal_mode=WAL")
```

**定期VACUUM**：
```bash
# 每周执行一次（凌晨3点）
0 3 * * 0 sqlite3 ~/.quantdesk/quantdesk-$(date +\%Y\%m\%d).db "VACUUM;"
```

### 2. 缓存策略

**前端资源缓存**（Nginx）：
```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### 3. 并发配置

**Uvicorn worker数量**：
```bash
# 单worker模式（默认，适合开发）
python engine/main.py

# 多worker模式（生产环境，CPU密集型）
uvicorn engine.main:app --host 0.0.0.0 --port 8765 --workers 4
```

---

## 监控与告警

### 1. 健康检查端点

引擎自动提供：
```bash
curl http://localhost:8765/workspace/status
```

### 2. Prometheus监控

添加指标采集（可选）：
```python
# 在 main.py 中添加
from prometheus_client import Counter, Histogram, make_asgi_app

request_count = Counter('quantdesk_requests_total', 'Total requests')
request_duration = Histogram('quantdesk_request_duration_seconds', 'Request duration')

# 挂载到 /metrics
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)
```

### 3. 日志聚合

使用 ELK/Loki 收集日志：
```bash
# Filebeat 配置示例
filebeat.inputs:
- type: log
  paths:
    - /path/to/engine/logs/*.log
  fields:
    service: quantdesk
```

---

## 备份策略

### 自动备份（已内置）

引擎每日自动备份到 `~/.quantdesk/backups/`，保留14天。

### 手动触发备份

```bash
curl -X POST http://localhost:8765/backups/now \
  -H "X-QuantDesk-Token: YOUR_TOKEN"
```

### 异地备份

```bash
# 每日同步到云存储（示例：AWS S3）
0 4 * * * aws s3 sync ~/.quantdesk/backups/ s3://your-bucket/quantdesk-backups/
```

---

## 故障排查

### 引擎无法启动

**检查端口占用**：
```bash
# Windows
netstat -ano | findstr :8765

# Linux
lsof -i :8765
```

**查看日志**：
```bash
tail -f engine/logs/engine.log
```

### HTTPS证书错误

**验证证书**：
```bash
openssl s_client -connect localhost:8765 -showcerts
```

**检查证书有效期**：
```bash
openssl x509 -in ~/.quantdesk/engine_cert.pem -noout -dates
```

### 移动端无法连接

**检查防火墙**：
```bash
# Windows
netsh advfirewall firewall add rule name="QuantDesk" dir=in action=allow protocol=TCP localport=8765

# Linux
sudo ufw allow 8765/tcp
```

**测试网络连通性**：
```bash
# 从手机访问（替换为电脑IP）
curl http://192.168.1.100:8765/auth/status
```

---

## 升级指南

### 1. 停止引擎
```bash
# 找到进程
ps aux | grep "python.*main.py"

# 优雅停止
kill -TERM <PID>
```

### 2. 备份数据
```bash
cp -r ~/.quantdesk ~/.quantdesk.backup
```

### 3. 更新代码
```bash
git pull origin main
pip install -r engine/requirements.txt --upgrade
```

### 4. 运行迁移（如有）
```bash
python engine/migrate.py
```

### 5. 重启引擎
```bash
python engine/main.py
```

---

## 生产环境检查清单

- [ ] HTTPS 已启用（Let's Encrypt 或反向代理）
- [ ] 防火墙已配置（仅允许必要IP）
- [ ] 速率限制已启用
- [ ] 日志监控已配置
- [ ] 自动备份已验证
- [ ] 异地备份已配置
- [ ] 健康检查已配置
- [ ] 告警规则已设置
- [ ] API密钥已轮换
- [ ] 移动端令牌已过期策略
- [ ] 文档访问权限已限制（生产环境考虑关闭 /docs）

---

**更新时间**：2026-08-30  
**维护者**：QuantDesk Team
