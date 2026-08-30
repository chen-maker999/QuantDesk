# QuantDesk

QuantDesk 是由投资 Agent 主导的 Windows 本地优先量化研究桌面软件。用户提出投资目标，Agent 自主规划任务、调用行情/模型/回测/组合/风险工具并交付可审计结论。产品采用 Tauri + React、独立 Python 算法引擎和 SQLite 本地数据库，设计语言参考 Codex 桌面端的信息密度、侧边栏、命令面板与流式运行状态。

## 当前原型包含

- Agent 主工作区、任务执行轨迹、工具调用卡片、监督/自主权限、审批边界与上下文面板
- 市场总览、研究会话、模型中心、策略回测、数据中心、投资组合、风险中心与设置
- OpenAI Responses API，以及 DeepSeek、Qwen 的 OpenAI 兼容工具循环；过程文本、工具事件与最终答案逐段流式展示
- Alpha Vantage 全球股票与外汇日线、Tushare Pro A 股与国内期货合约日线，也支持 CSV 导入；完整日线会保留 OHLCV/成交额、市场、复权和来源元数据供因子研究使用，缺字段时不会填造
- `Ctrl+K` 命令面板、`Ctrl+N` 新任务、可折叠侧边栏与深浅主题
- 所有 API Key 通过 Windows Credential Manager 独立保存，不写入项目文件或浏览器存储
- Windows 后台算法引擎以无控制台模式运行，应用内不提供终端面板
- 实盘 OMS：Alpaca（官方 REST，默认 Paper）与 IBKR Client Portal Gateway（仅本机回环）；账户、持仓、订单、成交同步与受控下单均独立于 Agent 和模拟盘
- Python FastAPI 本地服务、SQLite/WAL 元数据与实验审计记录
- 点时特征工程、HistGradientBoosting/ExtraTrees/Ridge 加权集成、稳健缩放与验证集误差加权
- Ledoit–Wolf 收缩协方差、受约束均值方差优化、风险贡献、VaR/CVaR、最大回撤与含成本回测
- 模拟盘 T+1 / 涨跌停拒单、账户熔断、条件单；Agent 可走 Walk-Forward（动量/因子 IC/组合静态权重）与实验工件检索
- 移动端令牌与桌面进程令牌分权：实盘 OMS 仅桌面端

> 投资风险提示：该软件是研究与决策支持工具，预测结果不构成投资建议。任何实盘接入前都应完成数据授权、合规审查、样本外验证和小资金灰度测试。

## 本地运行

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r engine\requirements.txt
```

启动算法引擎和桌面端：

```powershell
.\.venv\Scripts\python.exe engine\main.py
npm run tauri dev
```

生成无需预装 Python 的 Windows 安装包：

```powershell
npm run engine:bundle
npm run tauri build
```

仅预览界面：

```powershell
npm run dev
```

## 日志与备份

- 引擎日志：源码模式在 `engine\logs\engine.log`（RotatingFileHandler 10MB×5 自动轮转），记录启动、端口绑定、鉴权失败与异常；桌面端 spawn 的子进程输出另存同目录 `spawn.log`（打包模式下位于安装目录 `logs\`）
- 数据库备份：引擎启动时与每日一次自动在线备份到 `~/.quantdesk/backups/quantdesk-YYYYMMDD.db`，保留最近 14 份；设置页或 `POST /backups/now` 可手动触发，`GET /backups` 查看列表
- 端口占用：引擎固定监听 8765，端口被 TIME_WAIT 占用时自动重试；多实例由桌面端单实例插件互斥
- 登录会话 7 天过期，需重新登录；可在设置中开启 TOTP 两步验证。后续注册用户默认为 operator（不能实盘）
- 研究持仓提案默认合并写入并保留快照，可用快照回滚；模拟盘按登录用户分户，支持停牌拒单、期货盯市、市价滑点与研究持仓升进
- 日线导入/K 线上限 2000 根（约 8 年）；模拟盘股票遵守 T+1 与涨跌停拒单
- Agent 可检索已保存实验（`get_experiment`），研究类回测/因子在只读模式下也会落盘工件

## 手机端访问与配对

1. 手机与电脑连同一局域网，引擎以 `QUANTDESK_ENGINE_HOST=0.0.0.0` 监听全部网卡（Windows 防火墙需放行 TCP 8765 入站）
   局域网监听必须同时设置 `QUANTDESK_ENGINE_TLS=1`；仅开发调试可额外设置 `QUANTDESK_ALLOW_INSECURE_LAN=1` 明确允许明文 HTTP。
2. 手机浏览器打开 `http://<电脑局域网IP>:8765/app`（或桌面端入口二维码）
3. 首次绑定需在桌面端「设置」生成 6 位一次性配对码（90 秒有效），手机端输入后自动兑换访问令牌；配对错误限流 5 次/5 分钟
4. 账户体系：首次访问需注册管理员账户，之后登录使用（PBKDF2 加盐哈希 + 会话令牌，登录失败限流）
5. 手机令牌**不能**访问实盘 OMS（`/brokers` 返回 403）；真实下单只允许持有桌面进程令牌的本机应用

## 验证

```powershell
npm run build
.\.venv\Scripts\python.exe -m unittest discover engine\tests -v
cd src-tauri
cargo check
```

## 生产化建议

当前安装包已内置独立算法引擎，目标电脑无需预装 Python。正式公开发布前仍需配置企业代码签名与自动更新；商业数据源和券商实盘适配器应按各自授权协议单独实现。默认架构有意将“研究/回测/模拟”与“真实下单”隔离，避免原型直接触达真实资金。

## 实盘 OMS 配置

在侧边栏“实盘 OMS”中配置。Alpaca 需填写官方 API Key/Secret；IBKR 需先在本机启动、登录并完成二次验证后的 Client Portal Gateway（默认地址 `https://localhost:5000/v1/api`）。券商凭据只保存在 Windows Credential Manager，并在引擎进程内存中使用。

两者均默认 Paper 模式。若显式切换到真实资金，还必须设置本地单笔金额/最大挂单上限，并在当次会话手动输入 `ENABLE LIVE TRADING` 才会暂时解锁下单；Agent 没有任何真实下单工具。手机端与纯登录会话也不能调用 OMS 接口。
