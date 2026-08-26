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

两者均默认 Paper 模式。若显式切换到真实资金，还必须设置本地单笔金额/最大挂单上限，并在当次会话手动输入 `ENABLE LIVE TRADING` 才会暂时解锁下单；Agent 没有任何真实下单工具。
