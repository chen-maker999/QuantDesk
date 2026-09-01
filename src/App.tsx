import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity, AlertTriangle, ArrowRight, ArrowUpRight, BarChart3, Bell, Bot, BrainCircuit, BriefcaseBusiness, Cable,
  CalendarClock, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, Circle, Clock3, Command, Database, ExternalLink, FileDown, FileUp, FlaskConical, Gauge, Globe, Landmark,
  Copy, KeyRound, LayoutDashboard, ListOrdered, Menu, Minus, Moon, MoreHorizontal, Newspaper, Pause, Play, Plus, RefreshCw, Search, Unlock,
  Settings, ShieldCheck, Sparkles, Square, Sun, Target, Trash2, TrendingUp, LogOut, X, Zap
} from "lucide-react";
import {
  configureEngine, approveAgentApproval, engineFetch, getAgentUsage, getAutoModel, getProviderModels, getPushPublicKey, getRecentAudit, getWebhook, getWorkspaceStatus, hasApiKey, importHoldingRows, importMarketRows, totpConfirm, totpSetup,
  type ProviderModel,
  listAgentApprovals, rejectAgentApproval, runBacktest, runEnsemble, runWalkForward, saveApiKey, pushSubscribe, pushTest, pushUnsubscribe, setWebhook, startEngine, streamAgent, syncMarketData, syncPublicQuotes, syncTushareData,
  getAuthStatus, authLogout, onUnauthorized, resolveEngineAssetUrl, type AccessMode, type AgentApproval, type AgentEvent, type AgentUsageResult, type AuthStatus, type EnsembleResult, type ReasoningLevel, type WalkForwardResult, type WorkspaceStatus
} from "./lib/backend";
import AuthScreen from "./AuthScreen";
import { deleteTask as deleteRemoteTask, describeFrequency, describeNext, loadTasks, runTaskNow, saveTasks, tasksEqual, type ScheduledTask } from "./lib/scheduler";
import { disablePush, enablePush, pushEnabledFlag, pushSupported } from "./lib/push";
import { assistantText, chatId, deleteThread, getActiveChatId, loadThread, loadThreads, setActiveChatId, syncThreadsFromServer, titleFromPrompt, upsertThread, type ChatThread, type ChatTurn } from "./lib/chats";
import { forgetRun, cancelAgentRun, getQueue, getRunInfo, hasUnreadRun, isThreadRunning, onRunsChange, removeQueuedRun, setActiveThread, startAgentRun } from "./lib/agent-runs";
import { AlertsCard, FactorResearchCard, NotificationsCard, PortfolioBacktestCard } from "./research";
import { MarketPage, NewsPage, RankingsPage, StockPage, ViewNewsStrip, type StockTarget } from "./market";
import { PaperTradePage } from "./papertrade";
import { BrokerOmsPage } from "./brokeroms";
import { configureBrokerEngine, hasBrokerCredentials, type BrokerId } from "./lib/brokers";
import { getQuotes, searchSymbols } from "./lib/market";
import { getPositions } from "./lib/trade";
import altasLight from "./assets/altas-light.png";
import altasDark from "./assets/altas-dark.png";

type PageId="agent"|"overview"|"sessions"|"models"|"backtest"|"data"|"portfolio"|"risk"|"browser"|"tasks"|"settings"|"market"|"rankings"|"news"|"stock"|"papertrade"|"brokeroms";
type Theme="light"|"dark"|"system";
type Notify=(message:string,tone?:"ok"|"error")=>void;
type ApiProvider="OpenAI"|"DeepSeek"|"Qwen"|"OpenRouter"|"AlphaVantage"|"Tushare";
const providerForModel=(model:string):"openai"|"deepseek"|"qwen"|"openrouter"=>model==="auto"?"openrouter":model.includes("/")?"openrouter":model.startsWith("deepseek-")?"deepseek":model.startsWith("qwen")?"qwen":"openai";
const providerReady=(status:WorkspaceStatus,model:string)=>{const provider=providerForModel(model);return provider==="openai"?status.agent_configured:provider==="deepseek"?status.deepseek_configured:provider==="qwen"?status.qwen_configured:status.openrouter_configured};
const providerLabel=(model:string)=>{const provider=providerForModel(model);return provider==="openai"?"OpenAI":provider==="deepseek"?"DeepSeek":provider==="qwen"?"Qwen":"OpenRouter"};
const apiProviderForModel=(model:string):ApiProvider=>providerLabel(model) as ApiProvider;
// 聊天输入框模型切换触发器上显示的短名：去掉厂商前缀（anthropic/xx → xx）
const shortModelName=(model:string)=>model==="auto"?"Auto":model.includes("/")?model.slice(model.lastIndexOf("/")+1):model;
const applyFontScale=(scale:number)=>{const root=document.getElementById("root");if(root)root.style.zoom=scale===1?"":String(scale)};
const withProviderConfigured=(status:WorkspaceStatus,provider:ApiProvider):WorkspaceStatus=>{
  if(provider==="OpenAI")return {...status,agent_configured:true};
  if(provider==="DeepSeek")return {...status,deepseek_configured:true};
  if(provider==="Qwen")return {...status,qwen_configured:true};
  if(provider==="OpenRouter")return {...status,openrouter_configured:true};
  if(provider==="AlphaVantage")return {...status,market_provider_configured:true,market_provider:"alpha_vantage"};
  return {...status,tushare_configured:true};
};

const emptyStatus:WorkspaceStatus={market_rows:0,market_symbols:0,market_latest:null,holding_count:0,portfolio_value:null,experiment_count:0,model_count:0,audit_count:0,agent_configured:false,deepseek_configured:false,qwen_configured:false,openrouter_configured:false,market_provider_configured:false,market_provider:null,tushare_configured:false};
const pageTitles:Record<PageId,{title:string;subtitle:string}>={
  agent:{title:"投资 Agent",subtitle:"提出目标，Agent 将叙述过程、调用工具并交付可审计结果"},
  overview:{title:"工作区",subtitle:"只显示来自本地数据库的真实状态"},
  sessions:{title:"对话历史",subtitle:"继续之前的 Agent 对话，或查看系统审计"},
  models:{title:"算法工具",subtitle:"Agent 可调用的内置量化算法"},
  backtest:{title:"策略回测",subtitle:"导入真实收益和信号序列进行回测"},
  data:{title:"数据中心",subtitle:"导入并管理真实市场数据"},
  portfolio:{title:"投资组合",subtitle:"导入真实持仓并交给 Agent 分析"},
  risk:{title:"风险中心",subtitle:"基于真实持仓与价格历史计算"},
  browser:{title:"内置浏览器",subtitle:"在应用内直接浏览网页，地址栏支持网址或关键词搜索"},
  tasks:{title:"定时任务",subtitle:"设置周期性 Agent 任务，到点自动运行并记录结果"},
  settings:{title:"设置",subtitle:"Agent、模型、外观和安全边界"},
  market:{title:"行情中心",subtitle:"大盘指数与标的搜索，A 股红涨绿跌"},
  rankings:{title:"涨跌排行",subtitle:"A 股实时涨幅 / 跌幅 / 成交额 / 换手率排行"},
  news:{title:"新闻资讯",subtitle:"东方财富财经快讯"},
  stock:{title:"个股详情",subtitle:"实时行情与 K 线"},
  papertrade:{title:"模拟交易",subtitle:"股票与期货模拟盘：下单、持仓、委托与成交"},
  brokeroms:{title:"实盘 OMS",subtitle:"IBKR 与 Alpaca：账户、持仓、订单与受控下单"},
};
const navGroups=[
  {label:"工作台",items:[{id:"agent" as PageId,label:"投资 Agent",icon:Bot},{id:"overview" as PageId,label:"工作区",icon:LayoutDashboard},{id:"sessions" as PageId,label:"对话历史",icon:Clock3}]},
  {label:"行情中心",items:[{id:"market" as PageId,label:"大盘",icon:BarChart3},{id:"news" as PageId,label:"新闻",icon:Newspaper}]},
  {label:"量化工具",items:[{id:"models" as PageId,label:"算法工具",icon:BrainCircuit},{id:"backtest" as PageId,label:"策略回测",icon:FlaskConical},{id:"data" as PageId,label:"数据中心",icon:Database}]},
  {label:"投资管理",items:[{id:"portfolio" as PageId,label:"投资组合",icon:BriefcaseBusiness},{id:"papertrade" as PageId,label:"模拟交易",icon:Landmark},{id:"brokeroms" as PageId,label:"实盘 OMS",icon:Cable},{id:"risk" as PageId,label:"风险中心",icon:ShieldCheck}]},
  {label:"效率工具",items:[{id:"browser" as PageId,label:"内置浏览器",icon:Globe},{id:"tasks" as PageId,label:"定时任务",icon:CalendarClock}]},
];
type ViewDef={key:string;page:PageId;title:string;subtitle:string;row:"top"|"bottom";stock?:StockTarget;stockFrom?:PageId};
type ViewModule={page:PageId;label:string;icon:typeof navGroups[number]["items"][number]["icon"]};
const VIEW_MODULES:ViewModule[]=[...navGroups.flatMap(g=>g.items).map(({id,label,icon})=>({page:id,label,icon})),{page:"settings",label:"设置",icon:Settings}];
// 各数据/模型提供商的官方 Key 申请页面（设置里点超链接跳转）
const PROVIDER_URLS:Record<ApiProvider,string>={
  OpenAI:"https://platform.openai.com/api-keys",
  DeepSeek:"https://platform.deepseek.com/api_keys",
  Qwen:"https://bailian.console.aliyun.com/?apiKey=1",
  OpenRouter:"https://openrouter.ai/settings/keys",
  AlphaVantage:"https://www.alphavantage.co/support/#api-key",
  Tushare:"https://tushare.pro/register",
};
// 每个提供商的兜底模型清单（目录接口失败时显示）；在线目录以引擎 /providers/models 为准。
const PROVIDER_MODELS:Record<ApiProvider,{value:string;label:string}[]>={
  OpenAI:[{value:"gpt-5.5",label:"gpt-5.5"},{value:"gpt-5.4",label:"gpt-5.4"},{value:"gpt-5.4-mini",label:"gpt-5.4-mini"},{value:"gpt-4o",label:"gpt-4o"},{value:"gpt-4o-mini",label:"gpt-4o-mini"}],
  DeepSeek:[{value:"deepseek-v4-flash",label:"deepseek-v4-flash"},{value:"deepseek-v4-pro",label:"deepseek-v4-pro"},{value:"deepseek-chat",label:"deepseek-chat（旧别名）"},{value:"deepseek-reasoner",label:"deepseek-reasoner（旧别名）"}],
  Qwen:[{value:"qwen3.8-max",label:"qwen3.8-max"},{value:"qwen3.7-plus",label:"qwen3.7-plus"},{value:"qwen3.7-flash",label:"qwen3.7-flash"},{value:"qwen-plus",label:"qwen-plus"},{value:"qwen-turbo",label:"qwen-turbo"},{value:"qwen-max",label:"qwen-max"}],
  OpenRouter:[{value:"anthropic/claude-opus-4.7",label:"anthropic/claude-opus-4.7"},{value:"openai/gpt-5.4",label:"openai/gpt-5.4"},{value:"google/gemini-3.1-pro",label:"google/gemini-3.1-pro"},{value:"x-ai/grok-4",label:"x-ai/grok-4"}],
  AlphaVantage:[],Tushare:[],
};
const algorithms=[
  {name:"异构集成预测",detail:"HistGradientBoosting · ExtraTrees · Ridge",icon:BrainCircuit,prompt:"使用已导入的真实数据训练并验证异构集成预测模型"},
  {name:"Alpha 排名",detail:"20 日动量 / 实现波动率",icon:TrendingUp,prompt:"扫描已导入市场数据中的 Alpha 排名机会"},
  {name:"组合优化",detail:"Ledoit–Wolf · 受约束 SLSQP",icon:Target,prompt:"基于我的真实持仓和价格历史优化投资组合"},
  {name:"风险引擎",detail:"VaR · CVaR · 回撤 · 压力指标",icon:ShieldCheck,prompt:"对我的真实投资组合执行完整风险分析"},
];
const REASONING_LEVELS=["off","low","medium","high"] as const;
const REASONING_LABEL:Record<ReasoningLevel,string>={off:"关闭",low:"快速",medium:"平衡",high:"深度"};
const REASONING_DESC:Record<ReasoningLevel,string>={off:"关闭思考，最快响应",low:"快速思考，适合简单任务",medium:"平衡思考（默认）",high:"深度思考，分析更充分"};
const ACCESS_MODES:{id:AccessMode;label:string;hint:string}[]=[
  {id:"ask",label:"只读提案",hint:"只读取数据和生成建议，不写入本地状态"},
  {id:"approve",label:"待批准提案",hint:"生成待审阅建议；切换完全访问后才可执行"},
  {id:"full",label:"完全访问",hint:"可执行受控的本地写操作，仍不能连接券商"}
];
type RoleId="general"|"adviser"|"risk"|"trader"|"news"|"researcher";
const ROLES:{id:RoleId;label:string;icon:ComponentType<{size?:number}>;hint:string;system:string;prompts:string[]}[]=[
  {id:"general",label:"通用",icon:Sparkles,hint:"不做预设，按任务自行发挥",system:"",prompts:["检查我的组合风险","扫描真实数据中的 Alpha 机会","运行点时策略回测"]},
  {id:"adviser",label:"理财师",icon:BriefcaseBusiness,hint:"资产配置 · 长期规划",system:"你是资深理财师。围绕长期资产配置与财务目标展开：先了解资金体量、期限与风险承受度，再给配置比例建议、再平衡纪律与费用注意事项。优先调用持仓与行情数据；数据缺失时明确告知，不编造收益率。",prompts:["根据我的持仓和风险偏好给一版资产配置建议","评估我的组合是否偏科，给出再平衡方案"]},
  {id:"risk",label:"风险评估师",icon:ShieldCheck,hint:"VaR · 回撤 · 压力测试",system:"你是量化风控专家。任务聚焦风险而非收益：计算组合 VaR/CVaR、最大回撤、波动率与集中度，做情景压力测试并给对冲建议。必须基于真实持仓与价格历史调用风险工具；数据不足时说明缺哪些字段；结论标注置信区间与假设。",prompts:["对我的真实组合做完整风险分析（VaR/回撤/压力测试）","哪些持仓在拖累组合？做风险归因"]},
  {id:"trader",label:"波段交易员",icon:TrendingUp,hint:"动量 · 买卖点 · 仓位",system:"你是波段交易员。任务寻找中短期机会：分析动量、支撑压力位、量价关系与止损止盈位，给出分批建仓/减仓计划，明确仓位上限与风险回报比。优先查看实时行情与模拟持仓；只讨论模拟交易，不暗示真实下单。",prompts:["今天有哪些适合波段交易的强势标的？","用我的模拟持仓做个止盈止损计划"]},
  {id:"news",label:"新闻解读员",icon:Newspaper,hint:"资讯解读 · 事件影响",system:"你是财经新闻解读员。任务把资讯翻译成投资含义：梳理事件对板块/个股的传导链条、市场情绪与预期差，区分事实与观点。优先拉取新闻快讯并关联行情；没有相关新闻时直说，不编造消息。",prompts:["解读今天的财经快讯对我持仓的影响","最近有什么能影响 A 股的重要事件？"]},
  {id:"researcher",label:"数据研究员",icon:Database,hint:"回测 · 统计 · 数据质量",system:"你是严谨的数据研究员。任务以可复现方式验证假设：先核对数据质量（字段/窗口/缺失），再跑回测或统计检验，报告显著性与稳健性并注明局限。优先用已导入的本地数据与算法工具；数据不足时不补数、不插值。",prompts:["验证我的一个交易信号是否统计显著","检查导入数据的质量并给出清洗建议"]},
];
const loadRole=():RoleId=>{const r=localStorage.getItem("quant-role")||"general";return ROLES.some(x=>x.id===r)?(r as RoleId):"general"};
function loadAccessMode():AccessMode{
  const stored=localStorage.getItem("quant-access-mode");
  if(stored==="ask"||stored==="approve"||stored==="full")return stored;
  return localStorage.getItem("quant-default-supervised")==="0"?"approve":"ask";
}

function MiniBadge({children,tone="gray"}:{children:React.ReactNode;tone?:string}){return <span className={`badge ${tone}`}>{children}</span>}

// ---------- Agent 审批中心（P0：pending 提案 → 批准真实执行 / 拒绝作废） ----------
const APPROVAL_LABELS:Record<string,string>={
  apply_portfolio_proposal:"写入组合提案",place_paper_order:"模拟下单",cancel_paper_order:"撤单",
  update_paper_risk_limits:"更新模拟盘风控限额",create_scheduled_task:"创建定时任务",
  delete_scheduled_task:"删除定时任务",manage_price_alerts:"预警管理",
  manage_conditional_orders:"条件单",manage_risk_guard:"账户熔断",
};
function ApprovalCenter({notify}:{notify:Notify}){
  const [items,setItems]=useState<AgentApproval[]>([]);
  const [busyId,setBusyId]=useState<string|null>(null);
  const load=useCallback(async()=>{try{setItems((await listAgentApprovals("pending")).approvals||[])}catch{/* 引擎未启动时静默 */}},[]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),8000);return()=>clearInterval(timer)},[load]);
  const decide=async(id:string,approve:boolean)=>{
    setBusyId(id);
    try{
      if(approve){const result=await approveAgentApproval(id);notify(`已批准并执行：${result.label} · ${result.detail}`,"ok")}
      else{await rejectAgentApproval(id);notify("提案已拒绝","ok")}
      await load();
    }catch(error){notify(error instanceof Error?error.message:"审批操作失败","error")}
    finally{setBusyId(null)}
  };
  if(items.length===0)return null;
  return <section className="approval-center"><h3>审批中心 <span className="approval-count">{items.length}</span></h3>
    {items.map(item=>{
      const args=typeof item.arguments==="string"?(()=>{try{return JSON.parse(item.arguments) as Record<string,unknown>}catch{return {} as Record<string,unknown>}})():(item.arguments||{}) as Record<string,unknown>;
      const summary=Object.entries(args).map(([k,v])=>`${k}=${typeof v==="object"?JSON.stringify(v):String(v)}`).join(" · ");
      const impact=item.impact;
      return <div className="approval-item" key={item.id}>
        <b>{APPROVAL_LABELS[item.tool]||item.tool}</b>
        {impact?.warning&&<p className={`approval-warning${impact.destructive?" destructive":""}`}>{String(impact.warning)}</p>}
        {summary&&<code>{summary}</code>}
        <div className="approval-actions">
          <button className="primary-btn" disabled={busyId===item.id} onClick={()=>void decide(item.id,true)}>批准执行</button>
          <button className="secondary-btn danger" disabled={busyId===item.id} onClick={()=>void decide(item.id,false)}>拒绝</button>
        </div>
      </div>;
    })}
  </section>;
}

// ---------- Agent 用量看板（Codex 风格：统计行 + Token 活动热力图 + 当日配额） ----------
type HeatMode="daily"|"weekly"|"cumulative";
function AgentUsageCard(){
  const [usage,setUsage]=useState<AgentUsageResult|null>(null);
  const [mode,setMode]=useState<HeatMode>("daily");
  const heatRef=useRef<HTMLDivElement>(null);
  const load=useCallback(async()=>{try{setUsage(await getAgentUsage(365))}catch{/* 引擎未启动时静默 */}},[]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer)},[load]);
  // 新数据/切换视图后把热力图滚到最右（今天在最后一列）
  useEffect(()=>{const el=heatRef.current;if(el)el.scrollLeft=el.scrollWidth},[mode,usage]);
  if(!usage)return null;
  const today=usage.series[usage.series.length-1];
  const quotaPct=usage.quota.daily_tool_calls>0?Math.min(100,Math.round(today.tool_calls/usage.quota.daily_tool_calls*100)):0;
  const s=usage.stats;
  const fmtTokens=(n:number)=>n>=1e8?`${(n/1e8).toFixed(1).replace(/\.0$/,"")}亿`:n>=1e4?`${(n/1e4).toFixed(1).replace(/\.0$/,"")}万`:n.toLocaleString();
  const fmtDuration=(sec:number)=>sec<=0?"—":`${Math.floor(sec/3600)>0?`${Math.floor(sec/3600)} 小时 `:""}${Math.round(sec%3600/60)} 分`;
  // 热力图: 按周分列(每周日开头), 每日=当天 tokens / 每周=周合计 / 累计=截至该周累计
  const cells=usage.series.map(d=>({day:d.day,v:Math.max(0,d.tokens||0)}));
  const lead=cells.length?new Date(`${cells[0].day}T00:00:00`).getDay():0;
  const cols:Array<Array<{day:string|null;v:number}>>=[];
  let cur:Array<{day:string|null;v:number}>=Array.from({length:lead},()=>({day:null,v:0}));
  for(const c of cells){cur.push(c);if(cur.length===7){cols.push(cur);cur=[]}}
  if(cur.length)cols.push([...cur,...Array.from({length:7-cur.length},()=>({day:null,v:0}))]);
  const weekly=cols.map(col=>col.reduce((sum,c)=>sum+c.v,0));
  const cumulative:Array<number>=[];let acc=0;for(const w of weekly){acc+=w;cumulative.push(acc)}
  const colValues=mode==="daily"?null:mode==="weekly"?weekly:cumulative;
  const visibleMax=Math.max(0,...(colValues??cols.flat().map(c=>c.v)));
  const level=(v:number)=>v<=0?0:Math.min(4,1+Math.floor(v/(visibleMax||1)*4));
  const monthMarks=cols.map((col,idx)=>{const first=col.find(c=>c.day);if(!first?.day)return "";const m=new Date(`${first.day}T00:00:00`).getMonth();const prev=idx>0?cols[idx-1].find(c=>c.day):undefined;const pm=prev?.day?new Date(`${prev.day}T00:00:00`).getMonth():-1;return m!==pm?`${m+1}月`:""});
  return <section className="agent-usage-card">
    <div className="usage-stats-row">
      <div><b>{fmtTokens(s.totalTokens)}</b><small>累计 Token 数</small></div>
      <div><b>{fmtTokens(s.peakTokens)}</b><small>峰值 Token 数</small></div>
      <div><b>{fmtDuration(s.longestChatSeconds)}</b><small>最长聊天时长</small></div>
      <div><b>{s.currentStreak} 天</b><small>当前连续天数</small></div>
      <div><b>{s.longestStreak} 天</b><small>最长连续天数</small></div>
    </div>
    <div className="usage-heat-head"><b>Token 活动</b><span className="usage-mode">{([["daily","每日"],["weekly","每周"],["cumulative","累计"]] as const).map(([id,label])=><button key={id} className={mode===id?"active":""} onClick={()=>setMode(id)}>{label}</button>)}</span></div>
    <div className="usage-heat-scroll" ref={heatRef}>
      <div className={`usage-heat${mode==="daily"?"":" single"}`}>
        {mode==="daily"
          ?cols.flat().map((c,i)=>!c.day
            ?<i key={i} className="heat-cell blank"/>
            :<i key={i} className={`heat-cell lv${level(c.v)}`} title={`${c.day}：${fmtTokens(c.v)} tokens`}/>)
          :cols.map((col,ci)=>{const v=(colValues??[])[ci]??0;const last=[...col].reverse().find(c=>c.day);return <i key={ci} className={`heat-cell lv${level(v)}`} title={last?.day?`截至 ${last.day}：${fmtTokens(v)} tokens`:""}/>;})}
      </div>
      <div className="usage-heat-months">{monthMarks.map((m,i)=><span key={i}>{m}</span>)}</div>
    </div>
    <div className="usage-quota"><span>今日配额</span><div className="usage-quota-track"><i style={{width:`${quotaPct}%`}}/></div><b>{today.tool_calls}/{usage.quota.daily_tool_calls}</b></div>
  </section>;
}

function EmptyState({icon:Icon,title,description,action,actionLabel}:{icon:typeof Database;title:string;description:string;action:()=>void;actionLabel:string}){
  return <div className="real-empty"><span><Icon size={22}/></span><h2>{title}</h2><p>{description}</p><button className="primary-btn" onClick={action}>{actionLabel}<ArrowRight size={14}/></button></div>;
}

function uniqueTools(events:AgentEvent[]){
  const map=new Map<string,AgentEvent>();
  for(const event of events){
    if(event.type!=="tool_start"&&event.type!=="tool_result")continue;
    const key=event.name||event.label||"tool";
    if(!map.has(key)||event.type==="tool_result")map.set(key,event);
  }
  return [...map.values()];
}

function OperationGroup({events,live}:{events:AgentEvent[];live:boolean}){
  const tools=uniqueTools(events);
  const allDone=tools.length>0&&tools.every(item=>item.status==="completed"||item.type==="tool_result");
  const running=live&&!allDone;
  const [open,setOpen]=useState(false);
  const current=tools.find(item=>item.status!=="completed"&&item.type!=="tool_result")||tools[tools.length-1];
  const labels=tools.map(item=>item.label||item.name||"操作").filter((label,index,list)=>list.indexOf(label)===index);
  const summary=running?`正在运行 ${current?.label||current?.name||"操作"}`:labels.join(" · ")||"操作";
  return <div className={`op-group ${allDone?"done":"live"}`}>
    <button className={`op-fold ${running?"running":""}`} onClick={()=>setOpen(v=>!v)}><i/><span>{summary}</span><small>{tools.length}</small><ChevronDown className={open?"":"collapsed"} size={13}/></button>
    {open&&<div className="op-chip-list">{tools.map((item,index)=>{const active=live&&item.status!=="completed"&&item.type!=="tool_result";return <span className={`op-chip ${active?"running":""}`} key={`${item.name}-${index}`} title={item.detail||item.label}><em>{active?"正在运行":"已完成"}</em> {item.label||item.name}</span>})}</div>}
  </div>;
}

function MessageRail({turns,feedRef}:{turns:{id:string;role:"user"|"assistant";text:string;events:AgentEvent[]}[];feedRef:RefObject<HTMLDivElement|null>}){
  const railRef=useRef<HTMLDivElement>(null);
  const [hover,setHover]=useState<{id:string;top:number}|null>(null);
  const [active,setActive]=useState<string|null>(null);
  useEffect(()=>{
    const root=feedRef.current;if(!root)return;
    const obs=new IntersectionObserver(entries=>{
      const vis=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>Math.abs(a.boundingClientRect.top-root.getBoundingClientRect().top)-Math.abs(b.boundingClientRect.top-root.getBoundingClientRect().top))[0];
      if(vis)setActive((vis.target as HTMLElement).dataset.turn||null);
    },{root,threshold:.15,rootMargin:"-12% 0px -55% 0px"});
    const nodes=root.querySelectorAll("[data-turn]");
    nodes.forEach(node=>obs.observe(node));
    return()=>obs.disconnect();
  },[turns,feedRef]);
  const jump=(id:string)=>{const el=feedRef.current?.querySelector(`[data-turn="${id}"]`);el?.scrollIntoView({behavior:"smooth",block:"center"})};
  const preview=(id:string)=>{const turn=turns.find(item=>item.id===id);if(!turn)return {role:"",text:""};const text=(turn.role==="user"?turn.text:turn.text||assistantText(turn.events)).replace(/\s+/g," ").trim();return {role:turn.role==="user"?"你":"Agent",text:text.slice(0,220)||"（空消息）"}};
  if(turns.length<2)return null;
  const shown=hover?preview(hover.id):null;
  return <div className="msg-rail" ref={railRef}>
    {turns.map(turn=><button key={turn.id} type="button" className={`msg-tick ${turn.role}${active===turn.id?" active":""}${hover?.id===turn.id?" hover":""}`} aria-label={turn.role==="user"?"跳转到你的消息":"跳转到 Agent 回复"} onMouseEnter={e=>{const rail=railRef.current?.getBoundingClientRect();const tick=e.currentTarget.getBoundingClientRect();setHover({id:turn.id,top:tick.top-(rail?.top||0)+tick.height/2})}} onMouseLeave={()=>setHover(null)} onClick={()=>jump(turn.id)}/>)}
    {shown&&hover&&<div className="msg-preview" style={{top:hover.top}}><small>{shown.role}</small><p>{shown.text}</p></div>}
  </div>;
}

const AgentFeed=memo(function AgentFeed({turns,working}:{turns:ChatTurn[];working:boolean}){
  // 抽出成 memo：`elapsed` 每秒计时会让整个 AgentPage 重渲染，若不 memo，
  // 步骤停顿期每秒都重新解析全部 markdown → 画面抽动。turns 引用不变时整块跳过。
  return <>{turns.map((turn,index)=>{
    if(turn.role==="user")return <div className="user-line" data-turn={turn.id} key={turn.id}><p>{turn.text}</p></div>;
    const isLast=index===turns.length-1;
    const live=working&&isLast;
    const blocks=groupAssistantEvents(turn.events);
    const waiting=live&&!turn.events.some(e=>e.type==="done"||e.type==="error"||e.type==="narration"||e.type==="tool_start");
    return <div className="assistant-stream" data-turn={turn.id} key={turn.id}><div>
      {waiting&&<p className="thinking-shimmer">正在思考</p>}
      {blocks.map((block,blockIndex)=>block.kind==="compacting"?<div className={`compact-divider ${block.done?"done":""}`} key={blockIndex}><span className="compact-line"/><span className="compact-label">{block.done?"上下文已压缩":block.text||"正在压缩上下文"}</span><span className="compact-line"/></div>:block.kind==="ops"?<OperationGroup key={blockIndex} events={block.events} live={live&&!turn.events.some(e=>e.type==="done"||e.type==="error")}/>:block.kind==="error"?<div className="inline-error" key={blockIndex}><AlertTriangle size={14}/><span>{block.text}</span></div>:block.kind==="incomplete"?<div className="inline-error incomplete" key={blockIndex}><AlertTriangle size={14}/><span>{block.text}</span></div>:block.kind==="plan"?<div className="plan-card" key={blockIndex}><strong>任务计划</strong><ol>{block.text.split("\n").filter(Boolean).map((step,i)=><li key={i}>{step.replace(/^\d+\.\s*/,"")}</li>)}</ol></div>:<div className={`codex-copy ${block.conclusion?"final-answer":"narration"} ${live&&block.conclusion?"streaming-markdown":""}`} key={blockIndex}><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={resolveEngineAssetUrl}>{block.text}</ReactMarkdown></div></div>)}
    </div></div>;
  })}</>;
});

// 引导对话: 根据工作区状态与角色生成后续追问建议(Codex 风格的引导 chips)
function followUpSuggestions(status:WorkspaceStatus,role:RoleId):string[]{
  const picks:string[]=[];
  if(!status.market_rows&&!status.holding_count)picks.push("先帮我导入市场数据或持仓，再做一次组合诊断");
  else if(!status.holding_count)picks.push("用已导入数据扫描 Alpha 信号并解读排名","基于这些数据做一次策略回测");
  else picks.push("结合最新行情复盘我的持仓风险","根据以上结论给出下一步行动计划");
  if(role!=="general"){const info=ROLES.find(item=>item.id===role);if(info&&info.prompts[0])picks.push(info.prompts[0])}
  return [...new Set(picks)].slice(0,3);
}

function groupAssistantEvents(events:AgentEvent[]){  type Block={kind:"text";text:string;conclusion?:boolean}|{kind:"ops";events:AgentEvent[]}|{kind:"error";text:string}|{kind:"plan";text:string}|{kind:"incomplete";text:string}|{kind:"compacting";text:string;done:boolean};
  const blocks:Block[]=[];
  let ops:AgentEvent[]=[];
  const flush=()=>{if(ops.length){blocks.push({kind:"ops",events:ops});ops=[]}};
  for(const event of events){
    if(event.type==="tool_result"&&event.name==="submit_plan"){
      flush();
      blocks.push({kind:"plan",text:event.detail||""});
      continue;
    }
    if(event.type==="tool_start"&&event.name==="submit_plan")continue;
    if(event.type==="tool_start"||event.type==="tool_result"){ops.push(event);continue}
    flush();
    if(event.type==="compacting")blocks.push({kind:"compacting",text:event.text||"",done:event.status==="completed"});
    else if((event.type==="narration"||event.type==="status")&&event.text)blocks.push({kind:"text",text:event.text});
    else if(event.type==="done"&&event.text)blocks.push({kind:"text",text:event.text,conclusion:true});
    else if(event.type==="error")blocks.push({kind:"error",text:event.text||"出错了"});
    else if(event.type==="incomplete")blocks.push({kind:"incomplete",text:event.text||"工具轮次已用尽，任务可能未完成。"});
  }
  flush();
  return blocks;
}

function ReasoningSlider({value,onChange}:{value:ReasoningLevel;onChange:(level:ReasoningLevel)=>void}){
  const trackRef=useRef<HTMLDivElement>(null);
  const idx=REASONING_LEVELS.indexOf(value);
  const pick=(clientX:number)=>{const el=trackRef.current;if(!el)return;const rect=el.getBoundingClientRect();const t=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));onChange(REASONING_LEVELS[Math.round(t*(REASONING_LEVELS.length-1))])};
  return <div className="cc-slider">
    <div className="cc-slider-track" ref={trackRef} onPointerDown={e=>{e.preventDefault();(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);pick(e.clientX)}} onPointerMove={e=>{if(e.buttons)pick(e.clientX)}}>
      <div className="cc-slider-fill" style={{width:`${idx/3*100}%`}}/>
      <div className="cc-slider-thumb" style={{left:`${idx/3*100}%`}}/>
    </div>
    <div className="cc-slider-marks">{REASONING_LEVELS.map((level,index)=><button key={level} className={idx===index?"active":""} onClick={()=>onChange(level)}>{REASONING_LABEL[level]}</button>)}</div>
  </div>;
}

function AgentPage({status,onNavigate,onSetup,ensureProvider,initialDraft,clearDraft,model,setModel,notify,ctxCollapsed,onToggleCtx,activeChatId,onChatId}:{status:WorkspaceStatus;onNavigate:(p:PageId)=>void;onSetup:(provider:ApiProvider)=>void;ensureProvider:(provider:ApiProvider)=>Promise<boolean>;initialDraft:string;clearDraft:()=>void;model:string;setModel:(m:string)=>void;notify:Notify;ctxCollapsed:boolean;onToggleCtx:()=>void;activeChatId:string|null;onChatId:(id:string|null)=>void}){
  const [prompt,setPrompt]=useState(initialDraft);
  const [thread,setThread]=useState<ChatThread|null>(()=>loadThread(activeChatId||getActiveChatId()));
  const [history,setHistory]=useState<ChatThread[]>(()=>loadThreads());
  const [working,setWorking]=useState(false); const [startedAt,setStartedAt]=useState<number|null>(null); const [elapsed,setElapsed]=useState(0); const [accessMode,setAccessMode]=useState<AccessMode>(loadAccessMode); const [accessOpen,setAccessOpen]=useState(false); const [traceOpen,setTraceOpen]=useState(true); const [reasoning,setReasoning]=useState<ReasoningLevel>(()=>((localStorage.getItem("quant-reasoning") as ReasoningLevel)||"medium")); const [reasoningOpen,setReasoningOpen]=useState(false); const [role,setRole]=useState<RoleId>(loadRole); const [roleOpen,setRoleOpen]=useState(false);
  const [modelOpen,setModelOpen]=useState(false); const [dynModels,setDynModels]=useState<Record<string,ProviderModel[]|null|undefined>>({}); const [autoModel,setAutoModel]=useState<string|null>(null); const [modelQuery,setModelQuery]=useState("");
  useEffect(()=>{if(!modelOpen||autoModel)return;getAutoModel().then(r=>setAutoModel(r.model)).catch(()=>undefined)},[modelOpen,autoModel]);
  // 打开卡片时按需拉取各已配置提供商的在线模型目录；undefined=未配置，[]=加载中，null=失败用兜底清单
  useEffect(()=>{if(!modelOpen)return;const targets:{key:"openai"|"deepseek"|"qwen"|"openrouter";configured:boolean}[]=[{key:"openai",configured:status.agent_configured},{key:"deepseek",configured:status.deepseek_configured},{key:"qwen",configured:status.qwen_configured},{key:"openrouter",configured:status.openrouter_configured}];for(const target of targets){if(!target.configured||dynModels[target.key]!==undefined)continue;setDynModels(state=>({...state,[target.key]:[]}));getProviderModels(target.key).then(result=>setDynModels(state=>({...state,[target.key]:result.models}))).catch(()=>setDynModels(state=>({...state,[target.key]:null})))}},[modelOpen,status.agent_configured,status.deepseek_configured,status.qwen_configured,status.openrouter_configured,dynModels]);
  const [queueItems,setQueueItems]=useState<string[]>(()=>getQueue(activeChatId).map(item=>item.displayText));
  const showSuggestions=localStorage.getItem("quant-suggestions")!=="0";
  const feedRef=useRef<HTMLDivElement>(null);
  const pinnedRef=useRef(true);
  const followRaf=useRef(0);
  const commit=(next:ChatThread)=>{setThread(next);upsertThread(next);setHistory(loadThreads());onChatId(next.id)};
  useEffect(()=>{if(initialDraft){setPrompt(initialDraft);clearDraft()}},[initialDraft,clearDraft]);
  useEffect(()=>{setThread(current=>current?.id===activeChatId?current:loadThread(activeChatId));setHistory(loadThreads())},[activeChatId]);
  useEffect(()=>{if(!startedAt||!working)return;const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-startedAt)/1000)),1000);return()=>clearInterval(timer)},[startedAt,working]);
  useEffect(()=>{
    // 滚动跟随是否生效只看"用户是否钉在底部"这个持久状态，而不是每次渲染的瞬时距离：
    // 手动上滑阅读 → scroll 事件把它置 false → 停止跟随；回到底部 → 置 true → 恢复。
    // 这样新块即使超过阈值也能持续跟随，同时绝不抢用户上滑的位置（上次 90px 阈值会拽人）。
    const el=feedRef.current;if(!el)return;
    const onScroll=()=>{pinnedRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<24};
    el.addEventListener("scroll",onScroll,{passive:true});
    return()=>el.removeEventListener("scroll",onScroll);
  },[]);
  useEffect(()=>{
    // 引擎 narration 每 ~12ms 发一块，事件密集到达时把滚动跟随合并到每帧一次，
    // 避免高频设置 scrollTop 造成画面抽动；任务结束/打开历史对话仍平滑滚到底。
    const el=feedRef.current;if(!el)return;
    if(followRaf.current)cancelAnimationFrame(followRaf.current);
    followRaf.current=requestAnimationFrame(()=>{
      const node=feedRef.current;if(!node)return;
      if(working){if(pinnedRef.current)node.scrollTop=node.scrollHeight}
      else node.scrollTo({top:node.scrollHeight,behavior:"smooth"});
    });
    return()=>{if(followRaf.current)cancelAnimationFrame(followRaf.current)};
  },[thread,working]);
  useEffect(()=>{if(!working||localStorage.getItem("quant-keep-awake")==="0")return;let released=false;let lock:{release:()=>Promise<void>}|undefined;const wakeLock=(navigator as Navigator&{wakeLock?:{request:(kind:"screen")=>Promise<{release:()=>Promise<void>}>}}).wakeLock;void wakeLock?.request("screen").then(value=>{if(released)void value.release();else lock=value}).catch(()=>undefined);return()=>{released=true;if(lock)void lock.release()}},[working]);
  // 订阅后台运行 store:同步 working、重读被流式写入的显示线程、刷新历史列表。
  useEffect(()=>{
    const sync=()=>{
      setWorking(!!activeChatId&&isThreadRunning(activeChatId));
      const queued=getQueue(activeChatId).map(item=>item.displayText);
      setQueueItems(prev=>prev.length===queued.length&&prev.every((t,i)=>t===queued[i])?prev:queued);
      setThread(current=>{
        if(!current||current.id!==activeChatId)return current;
        const fresh=activeChatId?loadThread(activeChatId):null;
        return fresh&&fresh.updatedAt!==current.updatedAt?fresh:current;
      });
      setHistory(prev=>{
        const next=loadThreads();
        return prev.length===next.length&&prev.every((t,i)=>t.id===next[i].id&&t.updatedAt===next[i].updatedAt)?prev:next;
      });
    };
    sync();
    return onRunsChange(sync);
  },[activeChatId]);
  // 服务端对话合并完成后刷新历史列表
  useEffect(()=>{const fn=()=>{setHistory(loadThreads())};window.addEventListener("quant-threads-updated",fn);return()=>window.removeEventListener("quant-threads-updated",fn)},[]);
  // 汇报当前查看的线程;离开 Agent 页(卸载)时清空 → 后台完成视为未读。
  useEffect(()=>{setActiveThread(activeChatId);return()=>setActiveThread(null)},[activeChatId]);
  const submit=async(value?:string)=>{
    const text=(value??prompt).trim();if(!text)return;
    const provider=apiProviderForModel(model);
    const restored=await ensureProvider(provider);
    if(!restored){onSetup(provider);notify(`请先配置 ${providerLabel(model)} API Key`,"error");return}
    const current=thread??{id:chatId(),title:titleFromPrompt(text),turns:[],model,updatedAt:Date.now()};
    setPrompt("");
    const modeContext=accessMode==="ask"?"权限：只读提案。只可读取数据、运行研究与生成建议，禁止任何本地写操作和真实下单。":accessMode==="approve"?"权限：待批准提案。生成可审阅建议，禁止任何本地写操作和真实下单；用户切换完全访问后才可执行。":"权限：完全访问。可以执行受控本地写操作；禁止连接券商或真实下单。";
    const verbosity=localStorage.getItem("quant-verbosity")||"balanced";
    const personality=localStorage.getItem("quant-personality")||"professional";
    const customInstructions=localStorage.getItem("quant-custom-instructions")?.trim();
    const responseContext=`回答详略：${verbosity==="concise"?"简洁，只保留结论、依据和风险":verbosity==="detailed"?"详细，解释方法、假设、数据限制和风险":"平衡，先给结论再给必要依据"}。表达风格：${personality==="teaching"?"教学式，解释专业术语":personality==="direct"?"直接务实":"专业审慎"}。`;
    const roleInfo=ROLES.find(r=>r.id===role)||ROLES[0];
    const roleContext=roleInfo.id!=="general"?`当前角色：${roleInfo.label}。${roleInfo.system}\n`:"";
    // 会话记忆已迁到引擎侧(thread_messages,含工具轨迹):不再在前端拼接历史文本。
    // 线程忙时任务自动排队(Codex 风格):消息先以胶囊展示,等当前运行结束才入正文并启动。
    startAgentRun({
      threadId:current.id,
      prompt:`${modeContext}\n${responseContext}\n${roleContext}${customInstructions?`\n用户的长期指令：${customInstructions}`:""}\n\n用户目标：${text}`,
      displayText:text,
      model,provider:providerForModel(model),reasoning,accessMode,role,
      onStart:()=>{
        const base=loadThread(current.id)||current;
        const now=Date.now();
        const userTurn={id:chatId(),role:"user" as const,text,events:[],at:now};
        const assistantTurn={id:chatId(),role:"assistant" as const,text:"",events:[],at:now};
        commit({...base,turns:[...base.turns,userTurn,assistantTurn],updatedAt:now});
        setStartedAt(now);setElapsed(0);pinnedRef.current=true;
      },
      onError:()=>{if(localStorage.getItem("quant-notifications")!=="0")notify("Agent 任务失败","error")},
      onFinished:()=>{setHistory(loadThreads());if(hasUnreadRun(current.id)&&localStorage.getItem("quant-notifications")!=="0"){notify(`Agent 任务完成：${current.title||"对话"}`,"ok");if("Notification" in window&&Notification.permission==="granted"&&!document.hasFocus()){try{new Notification("QuantDesk",{body:`Agent 任务完成：${current.title||"对话"}`})}catch{/* 系统通知失败静默 */}}}},
    });
  };
  const openThread=(id:string)=>{onChatId(id);setActiveThread(id);setThread(loadThread(id));setHistory(loadThreads())};
  const removeThread=(id:string)=>{deleteThread(id);forgetRun(id);setHistory(loadThreads());if(thread?.id===id){setThread(null);onChatId(null);setActiveThread(null)}};
  const download=()=>{if(!thread)return;const text=thread.turns.map(turn=>turn.role==="user"?`用户：${turn.text}`:`助手：${turn.text||assistantText(turn.events)}`).filter(Boolean).join("\n\n");const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=`quantdesk-chat-${thread.id}.txt`;a.click();URL.revokeObjectURL(url);notify("对话已导出")};
  const turns=thread?.turns||[];
  const hasChat=turns.length>0;
  // Trae 式模型切换卡片：只列出已配置密钥的提供商及其模型（在线目录优先，失败退兜底清单）
  const modelGroups=(()=>{
    const groups:{provider:string;label:string;items:{value:string;label:string;meta?:string;free?:boolean}[]}[]=[];
    const push=(provider:string,label:string,items:{value:string;label:string;meta?:string;free?:boolean}[])=>{if(items.length)groups.push({provider,label,items})};
    const entries=(key:"openai"|"deepseek"|"qwen"|"openrouter",fallback:ApiProvider)=>{const dyn=dynModels[key];return dyn&&dyn.length?dyn.map(model=>({value:model.id,label:model.id,meta:key==="openrouter"?(model.free?"免费":`${Math.round((model.context||0)/1000)}K`):undefined,free:!!model.free})):PROVIDER_MODELS[fallback].map(model=>({value:model.value,label:model.label,free:false}))};
    if(status.agent_configured)push("openai","OpenAI",entries("openai","OpenAI"));
    if(status.deepseek_configured)push("deepseek","DeepSeek",entries("deepseek","DeepSeek"));
    if(status.qwen_configured)push("qwen","Qwen / 阿里云百炼",entries("qwen","Qwen"));
    if(status.openrouter_configured)push("openrouter","OpenRouter",entries("openrouter","OpenRouter"));
    return groups;
  })();
  return <div className={`agent-page-v3${ctxCollapsed?" ctx-collapsed":""}`}>
    <section className="codex-thread">
      <div className="codex-thread-head"><div><span><strong>{hasChat?thread?.title||"Quant Agent":"Quant Agent"}</strong><small>{providerReady(status,model)?`已连接 ${providerLabel(model)}`:`等待配置 ${providerLabel(model)} Key`}</small></span></div>{hasChat&&<div className="thread-head-actions"><button className="icon-btn" title="导出对话" onClick={download}><FileDown size={14}/></button></div>}</div>
      <div className="codex-body">
      {hasChat&&<MessageRail turns={turns} feedRef={feedRef}/>}
      <div className="codex-feed" ref={feedRef}>
        {!hasChat?<div className="agent-welcome-v3"><span><Sparkles size={22}/></span><h1>今天要完成什么投资任务？</h1><p>Agent 会先说明下一步，再调用真实数据、回测、组合和风险工具。没有数据时会明确告诉你缺少什么，不生成替代数字。</p><div className="welcome-state"><span className={providerReady(status,model)?"ok":"warn"}>{providerReady(status,model)?<CheckCircle2/>:<KeyRound/>}<b>{providerReady(status,model)?`${providerLabel(model)} 已配置`:`需要 ${providerLabel(model)} Key`}</b></span><span className={status.market_rows>0?"ok":"warn"}>{status.market_rows>0?<CheckCircle2/>:<Database/>}<b>{status.market_rows>0?`${status.market_rows.toLocaleString()} 行市场数据`:"尚无市场数据"}</b></span><span className={status.holding_count>0?"ok":"warn"}>{status.holding_count>0?<CheckCircle2/>:<BriefcaseBusiness/>}<b>{status.holding_count>0?`${status.holding_count} 个持仓`:"尚无持仓"}</b></span></div></div>:<>
          {working&&<div className="elapsed-row"><button onClick={()=>setTraceOpen(!traceOpen)}><span>耗时 {Math.floor(elapsed/60)}分 {elapsed%60}秒</span><ChevronDown className={traceOpen?"":"collapsed"} size={13}/></button></div>}
          <AgentFeed turns={turns} working={working}/>
        </>}
      </div>
      </div>
      <div className="agent-composer-v3"><div>{(reasoningOpen||accessOpen||roleOpen||modelOpen)&&<div className="popover-backdrop" onClick={()=>{setReasoningOpen(false);setAccessOpen(false);setRoleOpen(false);setModelOpen(false)}}/>}{modelOpen&&<div className="model-popover"><div className="model-popover-head"><strong>切换模型</strong><small>仅显示已配置密钥的提供商；免费模型以灰色标识</small></div><div className="model-search"><Search size={12}/><input value={modelQuery} onChange={e=>setModelQuery(e.target.value)} placeholder="搜索模型…" autoFocus/></div><div className="model-popover-list">{modelGroups.length===0&&<p className="model-popover-empty">尚未配置任何模型 API，请先在设置中添加</p>}{<div><div className="model-group-label">自动</div><button className={model==="auto"?"active":""} onClick={()=>{if(!status.openrouter_configured){setModelOpen(false);onSetup("OpenRouter");notify("Auto 模式需要先配置 OpenRouter Key","error");return}setModel("auto");localStorage.setItem("quant-model","auto");setModelOpen(false);if(model!=="auto")notify("Auto 模式已开启，将调用免费模型")}}><span className="model-name">Auto</span><small>{autoModel?`免费 · ${autoModel}`:"自动选用免费模型"}</small>{model==="auto"&&<Check size={13}/>}</button></div>}{(()=>{const q=modelQuery.trim().toLowerCase();const groups=q?modelGroups.map(group=>({group,items:group.items.filter(item=>item.label.toLowerCase().includes(q)||item.value.toLowerCase().includes(q))})).filter(entry=>entry.items.length>0):modelGroups.map(group=>({group,items:group.items}));if(q&&groups.length===0)return <p className="model-popover-empty">没有匹配“{modelQuery}”的模型</p>;return groups.map(({group,items})=><div key={group.provider}><div className="model-group-label">{group.label}</div>{items.map(item=><button key={item.value} className={`${model===item.value?"active":""}${item.free?" free":""}`} onClick={()=>{setModel(item.value);localStorage.setItem("quant-model",item.value);setModelOpen(false);if(model!==item.value)notify(`已切换到 ${item.label}`)}}><span className="model-name">{item.label}</span>{item.meta&&<small>{item.meta}</small>}{model===item.value&&<Check size={13}/>}</button>)}</div>)})()}</div><button className="model-add" onClick={()=>{setModelOpen(false);onNavigate("settings")}}><Plus size={13}/>添加模型</button></div>}{reasoningOpen&&<div className="reasoning-popover"><div className="reasoning-popover-head"><strong>思考等级</strong><small>{REASONING_DESC[reasoning]}</small></div><ReasoningSlider value={reasoning} onChange={level=>{setReasoning(level);localStorage.setItem("quant-reasoning",level)}}/></div>}{accessOpen&&<div className="access-popover">{ACCESS_MODES.map(mode=><button key={mode.id} className={`${accessMode===mode.id?"active":""}${mode.id==="full"?" access-full":""}`} onClick={()=>{setAccessMode(mode.id);localStorage.setItem("quant-access-mode",mode.id);setAccessOpen(false)}}><span><strong>{mode.label}</strong><small>{mode.hint}</small></span>{accessMode===mode.id&&<Check size={13}/>}</button>)}</div>}{roleOpen&&<div className="role-popover"><div className="reasoning-popover-head"><strong>Agent 角色</strong><small>角色决定 Agent 优先获取哪些信息、以什么方式分析</small></div>{ROLES.map(r=>{const Icon=r.icon;return <button key={r.id} className={role===r.id?"active":""} onClick={()=>{setRole(r.id);localStorage.setItem("quant-role",r.id);setRoleOpen(false)}}><Icon size={13}/><span><strong>{r.label}</strong><small>{r.hint}</small></span>{role===r.id&&<Check size={13}/>}</button>})}</div>}<textarea value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{const ctrlSend=localStorage.getItem("quant-send-mode")==="ctrl-enter";if(e.key==="Enter"&&(ctrlSend?(e.ctrlKey||e.metaKey):!e.shiftKey)){e.preventDefault();void submit()}}} placeholder={localStorage.getItem("quant-send-mode")==="ctrl-enter"?`${hasChat?"继续提问":"描述投资目标"}，Ctrl+Enter 发送…`:`${hasChat?"继续提问":"描述投资目标"}，Enter 发送…`}/><div className="composer-row"><div><button className={`model-trigger ${modelOpen?"active":""}`} onClick={()=>{setModelOpen(v=>!v);setModelQuery("");setAccessOpen(false);setReasoningOpen(false);setRoleOpen(false)}} title="切换模型"><BrainCircuit size={13}/>{shortModelName(model)}<ChevronDown size={12}/></button><button className={`role-trigger ${roleOpen?"active":""}${role!=="general"?" role-set":""}`} onClick={()=>{setRoleOpen(v=>!v);setAccessOpen(false);setReasoningOpen(false);setModelOpen(false)}} title="切换 Agent 角色"><Bot size={13}/>{ROLES.find(r=>r.id===role)?.label||"通用"}<ChevronDown size={12}/></button><button className={`access-trigger ${accessOpen?"active":""}${accessMode==="full"?" access-full":""}`} onClick={()=>{setAccessOpen(v=>!v);setReasoningOpen(false);setRoleOpen(false);setModelOpen(false)}}>{accessMode==="full"?<Unlock size={13}/>:<ShieldCheck size={13}/>}{ACCESS_MODES.find(mode=>mode.id===accessMode)?.label}<ChevronDown size={12}/></button><span className="composer-divider"/><span className={`reasoning-trigger ${reasoningOpen?"active":""}`} onClick={()=>{setReasoningOpen(open=>!open);setAccessOpen(false);setRoleOpen(false);setModelOpen(false)}} title="切换思考等级"><Sparkles size={13}/>思考 {REASONING_LABEL[reasoning]}</span></div><button className={`send-button${working?" stop":""}`} title={working?"停止本次运行":"发送"} disabled={!working&&!prompt.trim()} onClick={()=>{if(working){if(thread)cancelAgentRun(thread.id)}else void submit()}}>{working?<Square size={15}/>:<ArrowUpRight size={16}/>}</button></div></div>{hasChat&&showSuggestions&&!working&&<div className="suggest-chips">{followUpSuggestions(status,role).map(text=><button key={text} onClick={()=>void submit(text)}><Sparkles size={11}/>{text}</button>)}</div>}{queueItems.length>0&&<div className="run-queue"><span className="rq-label"><Clock3 size={12}/>排队中 {queueItems.length} 条，当前任务完成后依次运行</span>{queueItems.map((text,index)=><span className="queued-pill" key={`${index}-${text.slice(0,12)}`}><em>{text.length>46?`${text.slice(0,46)}…`:text}</em><i title="移除该排队任务" onClick={()=>{if(activeChatId)removeQueuedRun(activeChatId,index)}}><X size={10}/></i></span>)}</div>}{!hasChat&&showSuggestions&&<div className="quick-prompts">{(ROLES.find(r=>r.id===role)||ROLES[0]).prompts.map(text=><button key={text} onClick={()=>void submit(text)}>{text}</button>)}</div>}</div>
    </section>
    {ctxCollapsed?<div className="ctx-rail"><button className="icon-btn rail-expand" title="展开上下文面板" onClick={onToggleCtx}><ChevronsLeft size={16}/></button><span className="rail-caption">上下文</span></div>:<aside className="agent-context-v3"><div className="ctx-head"><button className="icon-btn ctx-collapse" title="折叠上下文面板" onClick={onToggleCtx}><ChevronsRight size={15}/></button></div><ApprovalCenter notify={notify}/><AgentUsageCard/><section><h3>对话历史</h3>{history.length===0?<p className="chat-empty">还没有保存的对话</p>:<div className="chat-history-list">{history.slice(0,12).map(item=>{const run=getRunInfo(item.id);const running=run?.status==="running";const unread=run?.status==="done"&&run.unread;return <button key={item.id} className={thread?.id===item.id?"active":""} onClick={()=>openThread(item.id)}><span><b>{item.title}</b><small>{new Date(item.updatedAt).toLocaleString()}</small></span>{running?<i className="chat-run-spin" title="Agent 正在运行"/>:unread?<i className="chat-run-dot" title="Agent 已完成,点开查看"/>:null}<i className="chat-del" title="删除" onClick={e=>{e.stopPropagation();removeThread(item.id)}}><X size={12}/></i></button>})}</div>}</section><section><h3>工作区上下文</h3><button onClick={()=>onNavigate("data")}><Database/><span><b>市场数据</b><small>{status.market_rows?`${status.market_symbols} 个标的 · ${status.market_latest}`:"未导入"}</small></span><ChevronRight/></button><button onClick={()=>onNavigate("portfolio")}><BriefcaseBusiness/><span><b>投资组合</b><small>{status.holding_count?`${status.holding_count} 个持仓`:"未导入"}</small></span><ChevronRight/></button><button onClick={()=>onNavigate("models")}><BrainCircuit/><span><b>算法工具</b><small>4 类本地算法</small></span><ChevronRight/></button></section><section><h3>权限边界</h3><div className="permission-line"><i className="ok"/>读取本地数据<MiniBadge tone="green">允许</MiniBadge></div><div className="permission-line"><i className="ok"/>运行研究工具<MiniBadge tone="green">允许</MiniBadge></div><div className="permission-line"><i className={accessMode==="full"?"":"warn"}/>修改组合<MiniBadge tone={accessMode==="full"?"red":"orange"}>{accessMode==="full"?"完全访问":"仅提案"}</MiniBadge></div><div className="permission-line"><i/>真实交易<MiniBadge>禁用</MiniBadge></div></section><section><h3>运行模型</h3><button onClick={()=>setModelOpen(true)}><Gauge/><span><b>{shortModelName(model)}</b><small>点击切换模型</small></span><ChevronRight/></button></section></aside>}
  </div>;
}

function OverviewPage({status,onNavigate}:{status:WorkspaceStatus;onNavigate:(p:PageId)=>void}){
  const values=[{label:"市场数据",value:status.market_rows.toLocaleString(),sub:status.market_latest||"未导入",icon:Database,page:"data" as PageId},{label:"投资持仓",value:String(status.holding_count),sub:status.portfolio_value?`¥${status.portfolio_value.toLocaleString()}`:"未导入",icon:BriefcaseBusiness,page:"portfolio" as PageId},{label:"回测实验",value:String(status.experiment_count),sub:"本地数据库",icon:FlaskConical,page:"backtest" as PageId},{label:"审计记录",value:String(status.audit_count),sub:"Agent 与工具",icon:Activity,page:"sessions" as PageId}];
  return <div className="page-body v3-page"><div className="real-stat-grid">{values.map(({label,value,sub,icon:Icon,page})=><button className="card real-stat" key={label} onClick={()=>onNavigate(page)}><Icon/><span><small>{label}</small><strong>{value}</strong><em>{sub}</em></span><ChevronRight/></button>)}</div>{status.market_rows===0?<EmptyState icon={Database} title="工作区还没有真实市场数据" description="导入包含 symbol、date、close 列的 CSV。所有图表、信号与风险指标只会基于导入的数据生成。" action={()=>onNavigate("data")} actionLabel="导入市场数据"/>:<div className="real-ready card"><CheckCircle2/><div><h2>真实数据工作区已就绪</h2><p>Agent 可以访问 {status.market_symbols} 个标的、{status.market_rows.toLocaleString()} 行价格记录。</p></div><button className="primary-btn" onClick={()=>onNavigate("agent")}>交给 Agent<ArrowRight size={14}/></button></div>}</div>;
}

function SessionsPage({notify,onOpenChat}:{notify:Notify;onOpenChat:(id:string)=>void}){
  const [threads,setThreads]=useState(()=>loadThreads());
  const [items,setItems]=useState<Array<{event:string;payload:Record<string,unknown>;created_at:string}>>([]);const [loading,setLoading]=useState(true);
  const load=async()=>{setLoading(true);try{setItems(await getRecentAudit());setThreads(loadThreads())}catch(e){notify(e instanceof Error?e.message:"加载失败","error")}finally{setLoading(false)}};useEffect(()=>{void load()},[]);
  useEffect(()=>onRunsChange(()=>setThreads(loadThreads())),[]);
  const labels:Record<string,string>={engine_started:"引擎已启动",agent_configured:"Agent 已配置",agent_run_started:"Agent 任务开始",agent_run_completed:"Agent 任务完成",agent_run_failed:"Agent 任务失败",market_data_imported:"市场数据已导入",holdings_imported:"持仓已导入",backtest_completed:"回测已完成"};
  return <div className="page-body v3-page">
    <div className="page-action-row"><p>对话保存在本机浏览器存储，点开即可继续。</p><button className="secondary-btn" onClick={()=>void load()}><RefreshCw size={13}/>刷新</button></div>
    {threads.length===0?<EmptyState icon={Clock3} title="还没有对话历史" description="在投资 Agent 里发一条消息后，对话会自动保存在这里，下次打开还能继续。" action={()=>onOpenChat("")} actionLabel="开始新对话"/>:
    <div className="chat-session-list">{threads.map(item=>{const run=getRunInfo(item.id);const running=run?.status==="running";const unread=run?.status==="done"&&run.unread;const preview=item.turns.find(turn=>turn.role==="assistant")?.text||item.turns.find(turn=>turn.role==="user")?.text||"";return <button className="card chat-session-item" key={item.id} onClick={()=>onOpenChat(item.id)}><span><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()} · {item.turns.filter(turn=>turn.role==="user").length} 轮</small><em>{preview.slice(0,80)}</em></span>{running?<i className="chat-run-spin" title="Agent 正在运行"/>:unread?<i className="chat-run-dot" title="Agent 已完成,点开查看"/>:null}<i className="chat-del" title="删除" onClick={e=>{e.stopPropagation();deleteThread(item.id);forgetRun(item.id);setThreads(loadThreads())}}><X size={14}/></i></button>})}</div>}
    <h3 className="audit-heading">系统审计</h3>
    {loading?<div className="loading-state"><RefreshCw className="spin"/>正在读取…</div>:items.length===0?<p className="chat-empty">还没有审计事件</p>:<div className="audit-list card">{items.map((item,index)=><div key={`${item.created_at}-${index}`}><span className="audit-dot"/><span><strong>{labels[item.event]||item.event}</strong><small>{item.created_at}</small></span><code>{Object.entries(item.payload).map(([k,v])=>`${k}=${String(v)}`).join(" · ")||"—"}</code></div>)}</div>}
  </div>;
}

function ModelsPage({launchAgent}:{launchAgent:(prompt:string)=>void}){
  const [ensBusy,setEnsBusy]=useState(false);
  const [ensResult,setEnsResult]=useState<EnsembleResult|null>(null);
  const runEnsembleNow=async()=>{
    setEnsBusy(true);setEnsResult(null);
    try{setEnsResult(await runEnsemble())}
    catch(e){setEnsResult({available:false,reason:e instanceof Error?e.message:"引擎未响应"})}
    finally{setEnsBusy(false)}
  };
  return <div className="page-body v3-page"><div className="algorithm-real-grid">{algorithms.map(({name,detail,icon:Icon,prompt})=>{
    const isEnsemble=name==="异构集成预测";
    return <div className="card algorithm-real" key={name}><Icon/><h3>{name}</h3><p>{detail}</p><MiniBadge tone={isEnsemble?"blue":""}>{isEnsemble?"可真实运行":"等待真实数据"}</MiniBadge>
      <div className="algo-actions">
        {isEnsemble&&<button className="primary-btn" disabled={ensBusy} onClick={()=>void runEnsembleNow()}><RefreshCw size={12} className={ensBusy?"spin":""}/>{ensBusy?"训练中…":"直接运行"}</button>}
        <button className="secondary-btn" onClick={()=>launchAgent(prompt)}><Bot size={13}/>交给 Agent</button>
      </div>
      {isEnsemble&&ensResult&&<div className="ens-result">
        {!ensResult.available?<p className="ens-empty">{ensResult.reason||"引擎未返回结果"}</p>:
          <div className="ens-list">{(ensResult.symbols||[]).map(s=>{const m=ensResult.models?.[s];return <div className="ens-item" key={s}>
            <b>{s}</b>
            {!m?.available?<small>{m?.reason||"无结果"}</small>:<>
              <em className={m.forecast?.direction==="up"?"tone-up":"tone-down"}>{m.forecast?.direction==="up"?"↑":"↓"}{((m.forecast?.next_return??0)*100>=0?"+":"")}{((m.forecast?.next_return??0)*100).toFixed(2)}%</em>
              <small>{m.window?.end} · {m.rows} 行 · 前滚 {m.walk_forward?.folds} 折 · 命中 {Math.round((m.walk_forward?.backtest?.hit_rate??0)*100)}%</small>
            </>}
          </div>})}</div>}
      </div>}
    </div>;
  })}</div><div className="data-policy"><ShieldCheck/><span><strong>算法不会使用示例样本补齐结果</strong><small>数据量不满足最低窗口时，工具会返回“数据不足”并说明所需字段和数量。</small></span></div></div>;
}

function DataPage({status,onImported,onProviderKey,onTushareKey,notify}:{status:WorkspaceStatus;onImported:(s:WorkspaceStatus)=>void;onProviderKey:()=>void;onTushareKey:()=>void;notify:Notify}){
  const input=useRef<HTMLInputElement>(null);const [busy,setBusy]=useState(false);const [syncing,setSyncing]=useState(false);const [assetType,setAssetType]=useState<"stock"|"fx">("stock");const [symbol,setSymbol]=useState("");const [fromSymbol,setFromSymbol]=useState("EUR");const [toSymbol,setToSymbol]=useState("USD");const [tsAsset,setTsAsset]=useState<"stock"|"future">("stock");const [tsSymbol,setTsSymbol]=useState("");const [tsSyncing,setTsSyncing]=useState(false);const [publicSymbols,setPublicSymbols]=useState("");const [publicSyncing,setPublicSyncing]=useState(false);
  const importFile=async(file:File)=>{setBusy(true);try{const text=await file.text();const lines=text.trim().split(/\r?\n/);const headers=lines.shift()?.split(",").map(x=>x.trim().toLowerCase())||[];const si=headers.indexOf("symbol"),di=headers.indexOf("date"),ci=headers.indexOf("close"),oi=headers.indexOf("open"),hi=headers.indexOf("high"),li=headers.indexOf("low"),vi=headers.indexOf("volume"),ai=headers.indexOf("amount");if(si<0||di<0||ci<0)throw new Error("CSV 必须包含 symbol、date、close 列");const optional=(cells:string[],index:number)=>index<0||!cells[index]?.trim()?undefined:Number(cells[index]);const rows=lines.filter(Boolean).map(line=>{const cells=line.split(",");return{symbol:cells[si].trim(),date:cells[di].trim(),close:Number(cells[ci]),open:optional(cells,oi),high:optional(cells,hi),low:optional(cells,li),volume:optional(cells,vi),amount:optional(cells,ai)}}).filter(row=>row.symbol&&row.date&&Number.isFinite(row.close)&&row.close>0&&[row.open,row.high,row.low,row.volume,row.amount].every(value=>value===undefined||Number.isFinite(value)));if(!rows.length)throw new Error("文件中没有有效价格记录");const next=await importMarketRows(rows);onImported(next);notify(`已导入 ${rows.length.toLocaleString()} 行真实价格数据`)}catch(e){notify(e instanceof Error?e.message:"导入失败","error")}finally{setBusy(false);if(input.current)input.current.value=""}};
  const sync=async()=>{if(!status.market_provider_configured){onProviderKey();notify("请先配置 Alpha Vantage API Key","error");return}setSyncing(true);try{const result=assetType==="stock"?await syncMarketData({asset_type:"stock",symbol:symbol.trim()}):await syncMarketData({asset_type:"fx",from_symbol:fromSymbol.trim(),to_symbol:toSymbol.trim()});onImported(result.status);notify(`已从 ${result.source} 同步 ${result.symbol} 的 ${result.imported_rows} 行日线`)}catch(e){notify(e instanceof Error?e.message:"行情同步失败","error")}finally{setSyncing(false)}};
  const syncTs=async()=>{if(!status.tushare_configured){onTushareKey();notify("请先配置 Tushare Pro Token","error");return}setTsSyncing(true);try{const result=await syncTushareData({asset_type:tsAsset,symbol:tsSymbol.trim()});onImported(result.status);notify(`已从 ${result.source} 同步 ${result.symbol} 的 ${result.imported_rows} 行日线`)}catch(e){notify(e instanceof Error?e.message:"Tushare 同步失败","error")}finally{setTsSyncing(false)}};
  const syncPublic=async()=>{const symbols=publicSymbols.split(/[,，\s]+/).map(item=>item.trim()).filter(Boolean);if(!symbols.length){notify("请输入至少一个代码","error");return}setPublicSyncing(true);try{const result=await syncPublicQuotes(symbols.slice(0,8));onImported(result.status);notify(`已从公开行情同步 ${result.symbols.join("、")} 共 ${result.imported_rows} 行${result.errors?.length?`，部分失败：${result.errors.join("；")}`:""}`)}catch(e){notify(e instanceof Error?e.message:"公开行情同步失败","error")}finally{setPublicSyncing(false)}};
  return <div className="page-body v3-page"><input ref={input} hidden type="file" accept=".csv,text/csv" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file)}}/>
    <div className="market-provider card"><div className="provider-heading"><span><Globe/></span><div><h2>公开行情（无需 API Key）</h2><p>用 Yahoo Finance 拉取日线，A 股可用 000001.SZ / 600519.SS。不经过 Alpha Vantage 或 Tushare。</p></div><MiniBadge tone="green">免费</MiniBadge></div>
      <div className="provider-sync"><label>代码（逗号分隔）<input value={publicSymbols} onChange={e=>setPublicSymbols(e.target.value.toUpperCase())} placeholder="例如 000001.SZ, 600519.SS, MSFT"/></label><button className="primary-btn" disabled={publicSyncing||!publicSymbols.trim()} onClick={()=>void syncPublic()}>{publicSyncing?<RefreshCw className="spin"/>:<RefreshCw/>}同步公开行情</button></div>
    </div>
    <div className="market-provider card"><div className="provider-heading"><span><Zap/></span><div><h2>Alpha Vantage 在线行情源</h2><p>直接同步全球股票与外汇日线，结果落入本地 SQLite。</p></div><MiniBadge tone={status.market_provider_configured?"green":"gray"}>{status.market_provider_configured?"已连接":"需要 API Key"}</MiniBadge><button className="secondary-btn" onClick={onProviderKey}><KeyRound size={13}/>{status.market_provider_configured?"更新 Key":"配置 Key"}</button></div>
      <div className="provider-sync"><div className="asset-switch"><button className={assetType==="stock"?"active":""} onClick={()=>setAssetType("stock")}>股票</button><button className={assetType==="fx"?"active":""} onClick={()=>setAssetType("fx")}>外汇</button></div>{assetType==="stock"?<label>股票代码<input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="例如 MSFT、600104.SHH"/></label>:<div className="fx-pair"><label>基础货币<input maxLength={3} value={fromSymbol} onChange={e=>setFromSymbol(e.target.value.toUpperCase())}/></label><b>/</b><label>计价货币<input maxLength={3} value={toSymbol} onChange={e=>setToSymbol(e.target.value.toUpperCase())}/></label></div>}<button className="primary-btn" disabled={syncing||(assetType==="stock"&&!symbol.trim())} onClick={()=>void sync()}>{syncing?<RefreshCw className="spin"/>:<RefreshCw/>}同步最近 100 日</button></div>
    </div>
    <div className="market-provider card"><div className="provider-heading"><span><TrendingUp/></span><div><h2>Tushare Pro 中国市场</h2><p>同步 A 股和国内期货真实合约日线；需要相应的数据积分权限。</p></div><MiniBadge tone={status.tushare_configured?"green":"gray"}>{status.tushare_configured?"已连接":"需要 Token"}</MiniBadge><button className="secondary-btn" onClick={onTushareKey}><KeyRound size={13}/>{status.tushare_configured?"更新 Token":"配置 Token"}</button></div>
      <div className="provider-sync"><div className="asset-switch"><button className={tsAsset==="stock"?"active":""} onClick={()=>setTsAsset("stock")}>A 股</button><button className={tsAsset==="future"?"active":""} onClick={()=>setTsAsset("future")}>期货</button></div><label>{tsAsset==="stock"?"TS 股票代码":"TS 期货合约代码"}<input value={tsSymbol} onChange={e=>setTsSymbol(e.target.value.toUpperCase())} placeholder={tsAsset==="stock"?"例如 000001.SZ":"例如 CU2510.SHF、IF2509.CFX"}/></label><button className="primary-btn" disabled={tsSyncing||!tsSymbol.trim()} onClick={()=>void syncTs()}>{tsSyncing?<RefreshCw className="spin"/>:<RefreshCw/>}同步可用历史</button></div>
    </div>
    <div className="source-real card"><span><Database/></span><div><h2>CSV 市场数据</h2><p>必填 symbol、date、close；可选真实 open、high、low、volume、amount。数据只保存在本机。</p></div><MiniBadge tone={status.market_rows?"green":"gray"}>{status.market_rows?"已有数据":"未导入"}</MiniBadge><button className="secondary-btn" disabled={busy} onClick={()=>input.current?.click()}>{busy?<RefreshCw className="spin"/>:<FileUp/>}{status.market_rows?"追加 CSV":"选择 CSV"}</button></div>{status.market_rows>0&&<div className="real-data-summary"><div className="card"><small>价格记录</small><strong>{status.market_rows.toLocaleString()}</strong></div><div className="card"><small>标的数量</small><strong>{status.market_symbols}</strong></div><div className="card"><small>最新日期</small><strong>{status.market_latest}</strong></div></div>}<div className="format-help card"><h3>CSV 格式</h3><pre>symbol,date,open,high,low,close,volume,amount{"\n"}000001.SZ,2026-08-21,12.20,12.50,12.10,12.35,1234567,15200000</pre><p>OHLCV/成交额必须来自真实数据；不会自动生成、补齐或插值缺失记录。</p></div></div>;
}

function PortfolioPage({status,onImported,launchAgent,notify}:{status:WorkspaceStatus;onImported:(s:WorkspaceStatus)=>void;launchAgent:(p:string)=>void;notify:Notify}){
  const input=useRef<HTMLInputElement>(null);const [busy,setBusy]=useState(false);
  const importFile=async(file:File)=>{setBusy(true);try{const text=await file.text();const lines=text.trim().split(/\r?\n/);const headers=lines.shift()?.split(",").map(x=>x.trim().toLowerCase())||[];const idx=(name:string)=>headers.indexOf(name);if(idx("symbol")<0||idx("quantity")<0)throw new Error("CSV 必须包含 symbol、quantity 列");const rows=lines.filter(Boolean).map(line=>{const c=line.split(",");return{symbol:c[idx("symbol")].trim(),name:idx("name")>=0?c[idx("name")].trim():undefined,quantity:Number(c[idx("quantity")]),avg_cost:idx("avg_cost")>=0?Number(c[idx("avg_cost")]):undefined,market_value:idx("market_value")>=0?Number(c[idx("market_value")]):undefined}}).filter(r=>r.symbol&&Number.isFinite(r.quantity));if(!rows.length)throw new Error("文件中没有有效持仓");const next=await importHoldingRows(rows);onImported(next);notify(`已导入 ${rows.length} 个真实持仓`)}catch(e){notify(e instanceof Error?e.message:"导入失败","error")}finally{setBusy(false);if(input.current)input.current.value=""}};
  return <div className="page-body v3-page"><input ref={input} hidden type="file" accept=".csv,text/csv" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file)}}/>{status.holding_count===0?<EmptyState icon={BriefcaseBusiness} title="还没有真实持仓" description="导入包含 symbol、quantity 的 CSV；可选字段为 name、avg_cost、market_value。导入会替换当前持仓。" action={()=>input.current?.click()} actionLabel="导入持仓 CSV"/>:<><div className="portfolio-real card"><BriefcaseBusiness/><span><small>真实持仓</small><strong>{status.holding_count} 个标的</strong><em>{status.portfolio_value?`市值 ¥${status.portfolio_value.toLocaleString()}`:"未提供 market_value"}</em></span><button className="secondary-btn" disabled={busy} onClick={()=>input.current?.click()}><FileUp size={13}/>重新导入</button><button className="primary-btn" onClick={()=>launchAgent("基于我的真实持仓和价格历史，分析风险并提出需要我批准的优化方案")}><Bot size={13}/>Agent 分析</button></div><div className="data-policy"><ShieldCheck/><span><strong>真实交易保持禁用</strong><small>Agent 只能分析和提出方案，不能向券商发送订单。</small></span></div></>}</div>;
}

function WalkForwardCard({returns,notify}:{returns:number[];notify:Notify}){
  const [train,setTrain]=useState(252);const [test,setTest]=useState(63);const [cost,setCost]=useState(12);
  const [result,setResult]=useState<WalkForwardResult|null>(null);const [busy,setBusy]=useState(false);
  const run=async()=>{setBusy(true);try{const next=await runWalkForward({returns,lookbacks:[5,10,20,60],trainDays:train,testDays:test,costBps:cost});setResult(next);notify(`Walk-Forward 完成：${next.n_windows} 个滚动窗`)}catch(e){notify(e instanceof Error?e.message:"检验失败","error")}finally{setBusy(false)}};
  const vals=result?.combined.equity_curve||[];const min=vals.length?Math.min(...vals):0;const max=vals.length?Math.max(...vals):1;const span=max-min||1;
  return <div className="backtest-real card"><div><h2>Walk-Forward 滚动检验</h2><p>对上方导入的收益序列做滚动训练/测试：每窗在训练段(默认 252 日)选出样本内最优动量参数(网格 5/10/20/60 日)，再在紧随的测试段做样本外评估。样本外显著弱于样本内即过拟合信号。</p></div>
    <label>训练窗(日)<input type="number" min="60" max="1250" value={train} onChange={e=>setTrain(Math.max(60,Math.min(1250,Number(e.target.value)||252)))}/></label>
    <label>测试窗(日)<input type="number" min="10" max="250" value={test} onChange={e=>setTest(Math.max(10,Math.min(250,Number(e.target.value)||63)))}/></label>
    <label>成本（bps）<input type="number" min="0" max="100" value={cost} onChange={e=>setCost(Math.max(0,Math.min(100,Number(e.target.value))||0))}/></label>
    <button className="primary-btn" disabled={busy||returns.length<train+test} onClick={()=>void run()}>{busy?<RefreshCw className="spin"/>:<FlaskConical/>}运行 Walk-Forward</button>
    {returns.length<train+test&&<p className="ens-empty">至少需要 {train+test} 行收益（当前 {returns.length} 行）。</p>}
    {result&&<div className="factor-result">
      <div className="result-real-grid">
        <div className="card"><small>滚动窗数</small><strong>{result.n_windows}</strong></div>
        <div className="card"><small>OOS 天数</small><strong>{result.oos_days}</strong></div>
        <div className="card"><small>OOS 合并年化</small><strong className={result.combined.annual_return>0?"tone-up":"tone-down"}>{(result.combined.annual_return*100).toFixed(2)}%</strong></div>
        <div className="card"><small>OOS 合并夏普</small><strong>{result.combined.sharpe.toFixed(2)}</strong></div>
        <div className="card"><small>OOS 合并回撤</small><strong className="tone-down">{(result.combined.max_drawdown*100).toFixed(2)}%</strong></div>
        <div className="card"><small>IS→OOS 夏普衰减</small><strong className={result.overfit_check.degradation<0.6?"tone-down":""}>{result.overfit_check.degradation.toFixed(2)}</strong></div>
      </div>
      {vals.length>1&&<svg viewBox={`0 0 520 100`} className="nav-chart"><polyline points={vals.map((v,i)=>`${(i/(vals.length-1))*520},${100-((v-min)/span)*100}`).join(" ")} fill="none" stroke="#2563eb" strokeWidth="1.6"/></svg>}
      <p className="decay-line">样本内平均夏普 {result.overfit_check.mean_is_sharpe.toFixed(2)} → 样本外平均夏普 {result.overfit_check.mean_oos_sharpe.toFixed(2)} · 各窗 OOS 净值拼接为上方曲线</p>
      <div className="layer-table">{result.windows.map((w,i)=><span key={i}><em>{w.train.start.slice(0,10)}→{w.test.end.slice(0,10)}</em><b className={w.oos_sharpe>0?"tone-up":"tone-down"}>OOS 夏普 {w.oos_sharpe.toFixed(2)}</b><small>选中 {w.params.lookback} 日动量 · IS {w.is_sharpe.toFixed(2)} · 回撤 {(w.oos_max_drawdown*100).toFixed(1)}%</small></span>)}</div>
    </div>}
  </div>;
}

function BacktestPage({status,onChanged,notify}:{status:WorkspaceStatus;onChanged:()=>void;notify:Notify}){
  const input=useRef<HTMLInputElement>(null);const [rows,setRows]=useState<Array<{ret:number;signal:number}>>([]);const [cost,setCost]=useState(12);const [result,setResult]=useState<Record<string,unknown>|null>(null);const [busy,setBusy]=useState(false);
  const importFile=async(file:File)=>{try{const text=await file.text();const lines=text.trim().split(/\r?\n/);const headers=lines.shift()?.split(",").map(x=>x.trim().toLowerCase())||[];const ri=headers.indexOf("return"),si=headers.indexOf("signal");if(ri<0||si<0)throw new Error("CSV 必须包含 return、signal 列");const parsed=lines.map(line=>{const c=line.split(",");return{ret:Number(c[ri]),signal:Number(c[si])}}).filter(x=>Number.isFinite(x.ret)&&Number.isFinite(x.signal));if(parsed.length<20)throw new Error("至少需要 20 行有效记录");setRows(parsed);setResult(null);notify(`已读取 ${parsed.length} 行回测输入`)}catch(e){notify(e instanceof Error?e.message:"读取失败","error")}};
  const run=async()=>{setBusy(true);try{const next=await runBacktest(rows.map(x=>x.ret),rows.map(x=>x.signal),cost);setResult(next);onChanged();notify("回测已完成")}catch(e){notify(e instanceof Error?e.message:"回测失败","error")}finally{setBusy(false)}};
  return <div className="page-body v3-page"><input ref={input} hidden type="file" accept=".csv,text/csv" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file)}}/><div className="backtest-real card"><div><h2>点时信号回测</h2><p>输入必须是你自己的真实收益和信号序列。引擎自动滞后一周期，并扣除换手成本。</p></div><button className="secondary-btn" onClick={()=>input.current?.click()}><FileUp size={13}/>{rows.length?"更换 CSV":"导入 CSV"}</button><label>成本（bps）<input type="number" min="0" max="100" value={cost} onChange={e=>setCost(Number(e.target.value))}/></label><button className="primary-btn" disabled={rows.length<20||busy} onClick={()=>void run()}>{busy?<RefreshCw className="spin"/>:<FlaskConical/>}运行回测</button></div><div className="input-status">{rows.length?`已加载 ${rows.length} 行真实记录`:`等待 CSV：return,signal`}</div>{result&&<div className="result-real-grid">{([["年化收益","annual_return"],["年化波动","annual_volatility"],["夏普比率","sharpe"],["最大回撤","max_drawdown"],["胜率","win_rate"],["年化换手","turnover"]] as [string,string][]).map(([label,key])=>{const v=typeof result[key]==="number"?Number(result[key]):undefined;const tone=key==="annual_return"?(v??0)>0?"tone-up":(v??0)<0?"tone-down":"":key==="max_drawdown"?"tone-down":"";return <div className="card" key={key}><small>{label}</small><strong className={tone}>{v!==undefined?(v*(key==="sharpe"?1:100)).toFixed(2)+(key==="sharpe"?"":"%"):"—"}</strong></div>})}</div>}<WalkForwardCard returns={rows.map(x=>x.ret)} notify={notify}/><FactorResearchCard status={status}/><PortfolioBacktestCard status={status}/></div>;
}

function RiskPage({status,launchAgent,onNavigate}:{status:WorkspaceStatus;launchAgent:(p:string)=>void;onNavigate:(p:PageId)=>void}){return <div className="page-body v3-page">{status.holding_count===0?<EmptyState icon={ShieldCheck} title="无法计算组合风险" description="风险引擎需要真实持仓，以及这些标的至少 21 个交易日的价格历史。" action={()=>onNavigate("portfolio")} actionLabel="先导入持仓"/>:status.market_rows===0?<EmptyState icon={Database} title="缺少价格历史" description="已检测到持仓，但还没有市场价格。导入价格数据后才能计算 VaR、CVaR 与回撤。" action={()=>onNavigate("data")} actionLabel="导入市场数据"/>:<div className="real-ready card"><ShieldCheck/><div><h2>风险计算条件已满足</h2><p>{status.holding_count} 个持仓，{status.market_rows.toLocaleString()} 行价格记录。让 Agent 调用风险工具并解释结果。</p></div><button className="primary-btn" onClick={()=>launchAgent("基于我的真实持仓和导入的价格历史计算 VaR、CVaR、最大回撤，并解释主要风险来源")}><Bot size={13}/>运行风险 Agent</button></div>}</div>}

function LegacySettingsPage({theme,setTheme,onApiKey,status,model,setModel,notify}:{theme:Theme;setTheme:(t:Theme)=>void;onApiKey:(provider:ApiProvider)=>void;status:WorkspaceStatus;model:string;setModel:(m:string)=>void;notify:Notify}){
  const [section,setSection]=useState("general");const [notifications,setNotifications]=useState(()=>localStorage.getItem("quant-notifications")!=="0");const [autostart,setAutostart]=useState(()=>localStorage.getItem("quant-autostart")!=="0");
  const toggle=(key:string,value:boolean,setter:(v:boolean)=>void)=>{setter(value);localStorage.setItem(key,value?"1":"0");notify("设置已保存")};
  return <div className="page-body settings-page fade-in"><aside className="settings-nav">{[["general","通用"],["agent","Agent 与模型"],["safety","安全边界"],["notifications","通知"]].map(([id,label])=><button key={id} className={section===id?"active":""} onClick={()=>setSection(id)}>{label}</button>)}</aside><div className="settings-content">
    {section==="general"&&<><section><h2>外观</h2><p>选择应用主题。</p><div className="theme-options"><button className={theme==="light"?"active":""} onClick={()=>setTheme("light")}><span className="theme-preview light-preview"><i/><i/><i/></span><CheckCircle2/>浅色</button><button className={theme==="dark"?"active":""} onClick={()=>setTheme("dark")}><span className="theme-preview dark-preview"><i/><i/><i/></span><CheckCircle2/>深色</button></div></section><section><h2>启动</h2><div className="settings-row"><span><strong>启动时运行 Agent 引擎</strong><small>控制下一次桌面应用启动时是否自动加载本地引擎</small></span><button className={`toggle ${autostart?"on":""}`} onClick={()=>toggle("quant-autostart",!autostart,setAutostart)}><i/></button></div></section></>}
    {section==="agent"&&<><section><h2>模型 API</h2><p>各提供商密钥独立加密保存在 Windows Credential Manager。</p><div className="provider-key-list"><div className="settings-row"><span><strong>OpenAI</strong><small>{status.agent_configured?"已连接":"尚未配置"}</small></span><button className="secondary-btn" onClick={()=>onApiKey("OpenAI")}><KeyRound size={13}/>配置</button></div><div className="settings-row"><span><strong>DeepSeek</strong><small>{status.deepseek_configured?"已连接":"尚未配置"}</small></span><button className="secondary-btn" onClick={()=>onApiKey("DeepSeek")}><KeyRound size={13}/>配置</button></div><div className="settings-row"><span><strong>Qwen / 阿里云百炼</strong><small>{status.qwen_configured?"已连接":"尚未配置"}</small></span><button className="secondary-btn" onClick={()=>onApiKey("Qwen")}><KeyRound size={13}/>配置</button></div></div></section><section><h2>行情数据 API</h2><p>行情凭据独立保存，不会发送给模型提供商。</p><div className="provider-key-list"><div className="settings-row"><span><strong>Alpha Vantage</strong><small>{status.market_provider_configured?"已连接，全球股票与外汇日线":"尚未配置"}</small></span><button className="secondary-btn" onClick={()=>onApiKey("AlphaVantage")}><KeyRound size={13}/>配置</button></div><div className="settings-row"><span><strong>Tushare Pro</strong><small>{status.tushare_configured?"已连接，A 股与国内期货日线":"尚未配置；期货接口需要相应积分权限"}</small></span><button className="secondary-btn" onClick={()=>onApiKey("Tushare")}><KeyRound size={13}/>配置</button></div></div></section><section><h2>默认模型</h2><label className="real-select">Agent 模型<select value={model} onChange={e=>{setModel(e.target.value);localStorage.setItem("quant-model",e.target.value);notify("模型已切换")}}><optgroup label="OpenAI"><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.5">gpt-5.5</option></optgroup><optgroup label="DeepSeek"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></optgroup><optgroup label="Qwen"><option value="qwen3.7-flash">Qwen 3.7 Flash</option><option value="qwen3.7-plus">Qwen 3.7 Plus</option><option value="qwen3.8-max">Qwen 3.8 Max</option></optgroup></select></label></section></>}
    {section==="safety"&&<section><h2>不可绕过的安全边界</h2><p>这些限制由本地 Agent 指令和工具层共同执行。</p><div className="safety-list"><div><Check/>读取本地数据和运行研究工具</div><div><AlertTriangle/>修改组合必须获得明确批准</div><div><AlertTriangle/>真实券商仅在 OMS 页面手动操作，默认模拟且真实模式需会话解锁</div><div><X/>Agent 无法读取已保存密钥的明文，也没有真实下单工具</div></div><PairingSettings notify={notify}/><TotpSettings notify={notify}/></section>}
    {section==="notifications"&&<section><h2>通知</h2><div className="settings-row"><span><strong>任务完成通知</strong><small>Agent 完成或失败时在应用内提示</small></span><button className={`toggle ${notifications?"on":""}`} onClick={()=>toggle("quant-notifications",!notifications,setNotifications)}><i/></button></div></section>}
  </div></div>;
}

function SettingsPage({theme,setTheme,onApiKey,status,model,setModel,notify,onOpenExternal}:{theme:Theme;setTheme:(t:Theme)=>void;onApiKey:(provider:ApiProvider)=>void;status:WorkspaceStatus;model:string;setModel:(m:string)=>void;notify:Notify;onOpenExternal:(url:string)=>void}){
  const [section,setSection]=useState("general");
  const [notifications,setNotifications]=useState(()=>localStorage.getItem("quant-notifications")!=="0");
  const [autostart,setAutostart]=useState(()=>localStorage.getItem("quant-autostart")!=="0");
  const [keepAwake,setKeepAwake]=useState(()=>localStorage.getItem("quant-keep-awake")!=="0");
  const [pointer,setPointer]=useState(()=>localStorage.getItem("quant-pointer")!=="0");
  const [alwaysOnTop,setAlwaysOnTop]=useState(()=>localStorage.getItem("quant-always-on-top")==="1");
  const [sendMode,setSendMode]=useState(()=>localStorage.getItem("quant-send-mode")||"enter");
  const [defaultAccess,setDefaultAccess]=useState<AccessMode>(loadAccessMode);
  const [suggestions,setSuggestions]=useState(()=>localStorage.getItem("quant-suggestions")!=="0");
  const [verbosity,setVerbosity]=useState(()=>localStorage.getItem("quant-verbosity")||"balanced");
  const [personality,setPersonality]=useState(()=>localStorage.getItem("quant-personality")||"professional");
  const [customInstructions,setCustomInstructions]=useState(()=>localStorage.getItem("quant-custom-instructions")||"");
  const [fontScale,setFontScale]=useState<number>(()=>Number(localStorage.getItem("quant-font-scale"))||1);
  const [tone,setTone]=useState<"cn"|"intl">(()=>localStorage.getItem("quant-tone")==="intl"?"intl":"cn");
  const [browserHome,setBrowserHome]=useState(()=>localStorage.getItem("quant-browser-home")||"");
  const [webhookUrl,setWebhookUrl]=useState("");
  useEffect(()=>{void getWebhook().then(r=>setWebhookUrl(r.url)).catch(()=>undefined)},[]);
  const toggle=(key:string,value:boolean,setter:(value:boolean)=>void)=>{setter(value);localStorage.setItem(key,value?"1":"0");notify("设置已保存")};
  const saveChoice=(key:string,value:string,setter:(value:string)=>void)=>{setter(value);localStorage.setItem(key,value);notify("设置已保存")};
  const setFont=(scale:number)=>{setFontScale(scale);localStorage.setItem("quant-font-scale",String(scale));applyFontScale(scale);notify("字体大小已更新")};
  const togglePointer=()=>{const value=!pointer;toggle("quant-pointer",value,setPointer);document.documentElement.dataset.pointer=value?"1":"0"};
  const toggleAlwaysOnTop=async()=>{const value=!alwaysOnTop;try{await getCurrentWindow().setAlwaysOnTop(value);toggle("quant-always-on-top",value,setAlwaysOnTop)}catch{notify("无法修改窗口置顶状态","error")}};
  const setToneMode=(t:"cn"|"intl")=>{setTone(t);localStorage.setItem("quant-tone",t);document.documentElement.dataset.tone=t;notify("涨跌颜色已更新")};
  const applyBrowserHome=()=>{localStorage.setItem("quant-browser-home",browserHome.trim());notify("浏览器主页已保存")};
  return <div className="page-body settings-page fade-in"><aside className="settings-nav">{[["general","通用"],["appearance","外观"],["market","行情"],["agent","Agent 与模型"],["safety","安全边界"],["notifications","通知"]].map(([id,label])=><button key={id} className={section===id?"active":""} onClick={()=>setSection(id)}>{label}</button>)}</aside><div className="settings-content">
    {section==="general"&&<>
      <section><h2>输入与运行</h2><p>采用 Codex 的任务输入与长时间运行偏好。</p><label className="real-select">发送消息<select value={sendMode} onChange={event=>saveChoice("quant-send-mode",event.target.value,setSendMode)}><option value="enter">Enter 发送，Shift+Enter 换行</option><option value="ctrl-enter">Ctrl+Enter 发送，Enter 换行</option></select></label><div className="settings-row"><span><strong>任务运行时防止休眠</strong><small>使用系统支持的屏幕唤醒锁，任务结束后自动释放</small></span><button className={`toggle ${keepAwake?"on":""}`} onClick={()=>toggle("quant-keep-awake",!keepAwake,setKeepAwake)}><i/></button></div><div className="settings-row"><span><strong>始终置顶</strong><small>让 QuantDesk 保持在其他窗口上方</small></span><button className={`toggle ${alwaysOnTop?"on":""}`} onClick={()=>void toggleAlwaysOnTop()}><i/></button></div></section>
      <section><h2>启动</h2><div className="settings-row"><span><strong>启动时运行 Agent 引擎</strong><small>自动加载本地 Python 算法引擎和已保存凭据</small></span><button className={`toggle ${autostart?"on":""}`} onClick={()=>toggle("quant-autostart",!autostart,setAutostart)}><i/></button></div></section>
    </>}
    {section==="appearance"&&<>
      <section><h2>主题</h2><p>支持浅色、深色或跟随 Windows；深色使用 Codex 的 #181818 中性背景。</p><div className="theme-options"><button className={theme==="light"?"active":""} onClick={()=>setTheme("light")}><span className="theme-preview light-preview"><i/><i/><i/></span><CheckCircle2/>浅色</button><button className={theme==="dark"?"active":""} onClick={()=>setTheme("dark")}><span className="theme-preview dark-preview"><i/><i/><i/></span><CheckCircle2/>深色</button><button className={theme==="system"?"active":""} onClick={()=>setTheme("system")}><span className="theme-preview system-preview"><i/><i/><i/></span><CheckCircle2/>跟随系统</button></div></section>
      <section><h2>字体大小</h2><p>调整界面文字显示比例，立即生效并保存。</p><div className="segmented"><button className={fontScale===0.9?"active":""} onClick={()=>setFont(0.9)}>小</button><button className={fontScale===1?"active":""} onClick={()=>setFont(1)}>标准</button><button className={fontScale===1.12?"active":""} onClick={()=>setFont(1.12)}>大</button><button className={fontScale===1.28?"active":""} onClick={()=>setFont(1.28)}>特大</button></div></section>
      <section><h2>交互</h2><div className="settings-row"><span><strong>交互元素使用手型光标</strong><small>关闭后按钮保持系统默认箭头，与 Codex 设置一致</small></span><button className={`toggle ${pointer?"on":""}`} onClick={togglePointer}><i/></button></div></section>
    </>}
    {section==="market"&&<>
      <section><h2>涨跌颜色</h2><p>A 股习惯红涨绿跌；国际行情习惯绿涨红跌。影响行情文字、K 线、涨跌榜与资金流。</p><div className="segmented"><button className={tone==="cn"?"active":""} onClick={()=>setToneMode("cn")}>红涨绿跌</button><button className={tone==="intl"?"active":""} onClick={()=>setToneMode("intl")}>绿涨红跌</button></div></section>
      <section><h2>浏览器</h2><p>浏览器面板打开时默认加载的地址，留空使用必应。</p><input className="settings-text" type="text" value={browserHome} onChange={e=>setBrowserHome(e.target.value)} onBlur={applyBrowserHome} placeholder="https://www.bing.com"/><div className="settings-row"><span><strong>恢复默认主页</strong><small>清除自定义主页，回到必应</small></span><button className="secondary-btn" onClick={()=>{setBrowserHome("");localStorage.removeItem("quant-browser-home");notify("已恢复默认主页")}}>恢复默认</button></div></section>
    </>}
    {section==="agent"&&<>
      <section><h2>模型 API</h2><p>密钥独立加密保存在 Windows Credential Manager。模型切换请到对话界面左下角，这里只管理密钥。</p><div className="provider-key-list">{(["OpenAI","DeepSeek","Qwen","OpenRouter"] as ApiProvider[]).map(provider=>{const configured=provider==="OpenAI"?status.agent_configured:provider==="DeepSeek"?status.deepseek_configured:provider==="Qwen"?status.qwen_configured:status.openrouter_configured;const isDefault=(provider==="OpenAI"&&!model.includes("/")&&!model.startsWith("deepseek-")&&!model.startsWith("qwen")&&model!=="auto")||(provider==="DeepSeek"&&model.startsWith("deepseek-"))||(provider==="Qwen"&&model.startsWith("qwen"))||(provider==="OpenRouter"&&(model.includes("/")||model==="auto"));return <div className={`provider-card ${isDefault?"active":""}`} key={provider}><div className="provider-card-head"><span><strong>{provider==="Qwen"?"Qwen / 阿里云百炼":provider}</strong><small>{configured?"已连接":"尚未配置"}{isDefault?" · 当前默认":""}</small></span><button className="provider-link" title={`前往 ${provider==="Qwen"?"阿里云百炼":provider} 官网申请 Key`} onClick={()=>onOpenExternal(PROVIDER_URLS[provider])}><ExternalLink size={12}/>官网</button><button className="secondary-btn" onClick={()=>onApiKey(provider)}><KeyRound size={13}/>配置</button></div></div>})}</div></section>
      <section><h2>行情数据 API</h2><p>行情凭据不会发送给模型提供商。</p><div className="provider-key-list"><div className="provider-card"><div className="provider-card-head"><span><strong>Alpha Vantage</strong><small>{status.market_provider_configured?"已连接，全球股票与外汇":"尚未配置"}</small></span><button className="provider-link" title="前往 Alpha Vantage 申请免费 Key" onClick={()=>onOpenExternal(PROVIDER_URLS.AlphaVantage)}><ExternalLink size={12}/>官网</button><button className="secondary-btn" onClick={()=>onApiKey("AlphaVantage")}><KeyRound size={13}/>配置</button></div></div><div className="provider-card"><div className="provider-card-head"><span><strong>Tushare Pro</strong><small>{status.tushare_configured?"已连接，A 股与国内期货":"尚未配置"}</small></span><button className="provider-link" title="前往 Tushare Pro 注册" onClick={()=>onOpenExternal(PROVIDER_URLS.Tushare)}><ExternalLink size={12}/>官网</button><button className="secondary-btn" onClick={()=>onApiKey("Tushare")}><KeyRound size={13}/>配置</button></div></div></div></section>
      <section><h2>回答行为</h2><div className="settings-choice-grid"><label className="real-select">回答详略<select value={verbosity} onChange={event=>saveChoice("quant-verbosity",event.target.value,setVerbosity)}><option value="concise">简洁</option><option value="balanced">平衡</option><option value="detailed">详细</option></select></label><label className="real-select">表达风格<select value={personality} onChange={event=>saveChoice("quant-personality",event.target.value,setPersonality)}><option value="professional">专业审慎</option><option value="direct">直接务实</option><option value="teaching">教学解释</option></select></label></div><label className="real-select" style={{marginTop:10}}>默认权限<select value={defaultAccess} onChange={event=>{const value=event.target.value as AccessMode;setDefaultAccess(value);localStorage.setItem("quant-access-mode",value);notify("默认权限已更新")}}><option value="ask">只读提案</option><option value="approve">待批准提案</option><option value="full">完全访问</option></select></label>{defaultAccess==="full"&&<small className="access-full-hint">完全访问可执行受控本地写操作，仍不能真实下单</small>}<div className="settings-row"><span><strong>显示建议任务</strong><small>在新任务页显示基于工作区的快捷提示</small></span><button className={`toggle ${suggestions?"on":""}`} onClick={()=>toggle("quant-suggestions",!suggestions,setSuggestions)}><i/></button></div></section>
      <section><h2>自定义指令</h2><p>每次任务都会附加到 Agent 上下文；不要在此填写 API Key。</p><textarea className="settings-textarea" value={customInstructions} onChange={event=>setCustomInstructions(event.target.value)} onBlur={()=>{localStorage.setItem("quant-custom-instructions",customInstructions);notify("自定义指令已保存")}} placeholder="例如：默认使用人民币计价；所有建议必须列出数据日期与主要风险。"/></section>
    </>}
    {section==="safety"&&<section><h2>不可绕过的安全边界</h2><p>这些限制由本地 Agent 指令和工具层共同执行。</p><div className="safety-list"><div><Check/>读取本地数据和运行研究工具</div><div><AlertTriangle/>修改组合必须获得明确批准</div><div><AlertTriangle/>真实券商仅在 OMS 页面手动操作，默认模拟且真实模式需会话解锁</div><div><X/>Agent 无法读取已保存密钥的明文，也没有真实下单工具</div></div><PairingSettings notify={notify}/><TotpSettings notify={notify}/></section>}
    {section==="notifications"&&<section><h2>通知</h2><div className="settings-row"><span><strong>任务完成通知</strong><small>Agent 完成或失败时在应用内提示</small></span><button className={`toggle ${notifications?"on":""}`} onClick={()=>toggle("quant-notifications",!notifications,setNotifications)}><i/></button></div><div className="settings-row"><span><strong>系统通知</strong><small>预警触发与任务完成时弹出 Windows 通知</small></span><button className="secondary-btn" onClick={()=>{if("Notification" in window)void Notification.requestPermission().then(p=>notify(p==="granted"?"已允许系统通知":"系统通知被拒绝","ok"))}}>申请权限</button></div><label className="real-select" style={{marginTop:10}}>Webhook 推送<input className="settings-text" type="text" value={webhookUrl} onChange={e=>setWebhookUrl(e.target.value)} placeholder="https://example.com/hook（留空关闭）"/></label><button className="secondary-btn" style={{marginTop:8}} onClick={()=>{setWebhook(webhookUrl.trim()).then(()=>notify("Webhook 已保存")).catch((e:unknown)=>notify(e instanceof Error?e.message:"保存失败","error"))}}><Check size={13}/>保存 Webhook</button><PushSettings notify={notify}/></section>}
  </div></div>;
}

// Web Push 订阅设置（设置 → 通知）：把 Agent 任务结果与预警推到系统通知（含手机浏览器）
function PushSettings({notify}:{notify:Notify}){
  const [on,setOn]=useState(()=>pushEnabledFlag());
  const [busy,setBusy]=useState(false);
  const supported=pushSupported();
  const toggle=async()=>{
    if(busy)return;
    setBusy(true);
    try{
      if(on){
        await disablePush(pushUnsubscribe);
        setOn(false);notify("Web Push 已关闭");
      }else{
        const res=await enablePush(getPushPublicKey,sub=>pushSubscribe({endpoint:sub.endpoint,keys:sub.keys,userAgent:navigator.userAgent.slice(0,290)}));
        if(res.ok){setOn(true);notify("Web Push 已开启")}
        else notify(res.error||"开启失败","error");
      }
    }catch(e){notify(e instanceof Error?e.message:"推送设置失败","error")}finally{setBusy(false)}
  };
  const test=()=>{pushTest().then(()=>notify("测试通知已发送")).catch((e:unknown)=>notify(e instanceof Error?e.message:"测试发送失败","error"))};
  return <div className="settings-row" style={{marginTop:10}}><span><strong>Web Push 浏览器推送</strong><small>{on?"已订阅，预警/定时任务结果将推送系统通知":supported?"订阅后预警与定时任务结果会推送到本机与已连接的浏览器":"当前环境不支持 Web Push"}</small></span><div style={{display:"flex",gap:8}}><button className="secondary-btn" onClick={()=>void toggle()} disabled={busy||!supported}>{busy?<RefreshCw className="spin"/>:on?"关闭":"订阅"}</button>{on&&<button className="secondary-btn" onClick={test}><Zap size={12}/>测试</button>}</div></div>;
}

// 移动端配对码（设置 → 安全边界）：桌面端生成 6 位一次性配对码，
// 手机端在「设置 → 引擎连接」输入即可换取访问令牌，90 秒内有效。
function PairingSettings({notify}:{notify:Notify}){
  const [code,setCode]=useState("");
  const [expireAt,setExpireAt]=useState(0);
  const [left,setLeft]=useState(0);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(!expireAt)return;
    const timer=window.setInterval(()=>{
      const rest=Math.max(0,Math.ceil((expireAt-Date.now())/1000));
      setLeft(rest);
      if(rest<=0)window.clearInterval(timer);
    },250);
    return ()=>window.clearInterval(timer);
  },[expireAt]);
  const create=async()=>{
    setBusy(true);
    try{
      const r=await engineFetch("/pair/create",{method:"POST"});
      const data=await r.json() as {ok?:boolean;code?:string;expires_in?:number;detail?:string};
      if(!r.ok||!data.ok){notify(data.detail||"生成配对码失败","error");return}
      setCode(data.code||"");setExpireAt(Date.now()+(data.expires_in||90)*1000);setLeft(data.expires_in||90);
      notify("配对码已生成，90 秒内在手机端输入");
    }catch(e){notify(e instanceof Error?e.message:"生成配对码失败","error")}finally{setBusy(false)}
  };
  return <div style={{marginTop:14}}>
    <div className="settings-row"><span><strong>移动端配对</strong><small>手机端「设置 → 引擎连接」输入配对码即可自动完成连接授权（一次性，90 秒有效）</small></span><button className="secondary-btn" disabled={busy} onClick={()=>void create()}>{busy?<RefreshCw className="spin"/>:<Copy size={13}/>}生成配对码</button></div>
    {code&&left>0&&<div className="pair-code-box"><code>{code}</code><em>{left}s 后失效</em></div>}
  </div>;
}

function TotpSettings({notify}:{notify:Notify}){
  const [secret,setSecret]=useState("");
  const [url,setUrl]=useState("");
  const [code,setCode]=useState("");
  const [busy,setBusy]=useState(false);
  const setup=async()=>{
    setBusy(true);
    try{
      const r=await totpSetup();
      setSecret(r.secret);setUrl(r.otpauth_url);notify("请用验证器扫描密钥，再输入 6 位码确认");
    }catch(e){notify(e instanceof Error?e.message:"无法开始两步验证","error")}
    finally{setBusy(false)}
  };
  const confirm=async()=>{
    setBusy(true);
    try{await totpConfirm(code);notify("两步验证已开启","ok");setCode("")}
    catch(e){notify(e instanceof Error?e.message:"验证失败","error")}
    finally{setBusy(false)}
  };
  return <div style={{marginTop:14}}>
    <div className="settings-row"><span><strong>两步验证 (TOTP)</strong><small>登录时额外输入验证器 6 位码。进程令牌桌面端仍可在未登录时访问本机引擎。</small></span><button className="secondary-btn" disabled={busy} onClick={()=>void setup()}>{busy?<RefreshCw className="spin"/>:<KeyRound size={13}/>}生成密钥</button></div>
    {secret&&<p className="settings-help">密钥 <code>{secret}</code>{url?<> · <a href={url}>otpauth</a></>:null}</p>}
    {secret&&<div className="settings-row"><input className="settings-text" value={code} onChange={e=>setCode(e.target.value)} placeholder="输入 6 位验证码" maxLength={12}/><button className="primary-btn" disabled={busy||code.length<6} onClick={()=>void confirm()}>确认开启</button></div>}
  </div>;
}

function KeyModal({provider,onClose,onSaved,notify,onOpenExternal}:{provider:ApiProvider;onClose:()=>void;onSaved:(provider:ApiProvider)=>void;notify:Notify;onOpenExternal:(url:string)=>void}){
  const [key,setKey]=useState("");
  const [show,setShow]=useState(false);
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  const names:Record<ApiProvider,string>={OpenAI:"OpenAI",DeepSeek:"DeepSeek",Qwen:"Qwen / 阿里云百炼",OpenRouter:"OpenRouter",AlphaVantage:"Alpha Vantage",Tushare:"Tushare Pro"};
  const isMarket=provider==="AlphaVantage"||provider==="Tushare";
  useEffect(()=>{void hasApiKey(provider).then(setSaved).catch(()=>undefined)},[provider]);
  const save=async()=>{if(key.trim().length<8){notify("请输入有效的 API Key 或 Token","error");return}setBusy(true);try{await saveApiKey(provider,key.trim());await configureEngine(provider);onSaved(provider);notify(`${names[provider]} 凭据已保存并连接`);onClose()}catch(e){notify(e instanceof Error?e.message:"配置失败","error")}finally{setBusy(false)}};
  return <div className="modal-backdrop"><div className="key-modal"><button className="modal-close" onClick={onClose}><X/></button><span className="modal-icon"><KeyRound/></span><h2>{saved?"更新":"配置"} {names[provider]} {provider==="Tushare"?"Token":"API Key"}</h2><p>{isMarket?"用于直接拉取真实行情，不会发送给任何模型提供商。":"用于 Agent 推理与本地工具编排；没有对应 Key 时不会编造替代结果。"}凭据存入 Windows Credential Manager。{saved?" 已填入当前保存的密钥，默认隐藏，点显示可查看。":""}</p><label>{provider==="Tushare"?"Token":"API Key"}<div className="key-input"><KeyRound/><input autoFocus type={show?"text":"password"} value={key} onChange={e=>setKey(e.target.value)} placeholder={isMarket?"输入行情凭据":"输入模型 API Key"}/><button onClick={()=>setShow(!show)}>{show?"隐藏":"显示"}</button></div></label><button className="provider-link key-link" onClick={()=>onOpenExternal(PROVIDER_URLS[provider])}><ExternalLink size={11}/>还没有 Key？前往官网申请</button><button className="primary-btn wide" disabled={busy} onClick={()=>void save()}>{busy?<RefreshCw className="spin"/>:<Check/>}保存并连接</button></div></div>;
}

function CommandPalette({onClose,navigate,launchAgent,onOpenStock}:{onClose:()=>void;navigate:(p:PageId)=>void;launchAgent:(p:string)=>void;onOpenStock:(t:StockTarget)=>void}){
  type PaletteItem={key:string;group:string;label:string;sub:string;icon:ComponentType<{size?:number}>;action:()=>void};
  const baseCommands=[{label:"新建 Agent 任务",icon:Plus,action:()=>navigate("agent")},{label:"查看大盘行情",icon:BarChart3,action:()=>navigate("market")},{label:"查看涨跌排行",icon:ListOrdered,action:()=>navigate("rankings")},{label:"查看财经快讯",icon:Newspaper,action:()=>navigate("news")},{label:"打开模拟交易",icon:Landmark,action:()=>navigate("papertrade")},{label:"导入市场数据",icon:Database,action:()=>navigate("data")},{label:"导入投资组合",icon:BriefcaseBusiness,action:()=>navigate("portfolio")},{label:"运行风险分析",icon:ShieldCheck,action:()=>launchAgent("对我的真实组合执行风险分析")},{label:"打开设置",icon:Settings,action:()=>navigate("settings")}];
  const [query,setQuery]=useState("");
  const [extras,setExtras]=useState<PaletteItem[]>([]);
  const needle=query.trim().toLowerCase();
  const local=useMemo<PaletteItem[]>(()=>{
    const items:PaletteItem[]=[];
    for(const c of baseCommands){if(!needle||c.label.toLowerCase().includes(needle))items.push({key:`c-${c.label}`,group:"命令",label:c.label,sub:"",icon:c.icon,action:c.action});}
    for(const g of navGroups){for(const it of g.items){const t=pageTitles[it.id];const hay=`${it.label} ${t.title} ${t.subtitle}`.toLowerCase();if(!needle||hay.includes(needle))items.push({key:`p-${it.id}`,group:"页面",label:it.label,sub:t.subtitle,icon:it.icon,action:()=>navigate(it.id)});}}
    if(!needle||"设置 settings".includes(needle))items.push({key:"p-settings",group:"页面",label:"设置",sub:pageTitles.settings.subtitle,icon:Settings,action:()=>navigate("settings")});
    return items;
  },[needle]);
  useEffect(()=>{
    if(!needle){setExtras([]);return;}
    const timer=setTimeout(async()=>{
      const out:PaletteItem[]=[];
      try{const s=await searchSymbols(needle);for(const h of (s.results||[]).slice(0,6))out.push({key:`s-${h.type}-${h.symbol}`,group:"行情",label:h.name,sub:`${h.symbol} · ${h.type==="index"?"指数":"股票"}`,icon:BarChart3,action:()=>onOpenStock({market:h.type==="index"?"index":"a",symbol:h.symbol,name:h.name})});}catch{/* 搜索失败静默 */ }
      if(/[a-z]{1,4}\d{2,6}/i.test(needle)){try{const fq=await getQuotes([needle.toUpperCase()],"futures");for(const q of (fq.quotes||[]).filter(x=>x.price!=null).slice(0,3))out.push({key:`f-${q.symbol}`,group:"期货",label:q.name||q.symbol,sub:`${q.symbol} · 现价 ${q.price}`,icon:TrendingUp,action:()=>navigate("papertrade")});}catch{/* 期货查询失败静默 */ }}
      try{const p=await getPositions();for(const pos of (p.positions||[]).filter(x=>`${x.name||""} ${x.symbol}`.toLowerCase().includes(needle)).slice(0,6))out.push({key:`pos-${pos.market}-${pos.symbol}`,group:"模拟持仓",label:pos.name||pos.symbol,sub:`${pos.symbol} · ${pos.side_label} ${Math.abs(pos.quantity)}`,icon:Landmark,action:()=>navigate("papertrade")});}catch{/* 持仓读取失败静默 */ }
      setExtras(out);
    },250);
    return()=>clearTimeout(timer);
  },[needle]);
  const items=[...local,...extras];
  const groups:Array<{g:string;its:PaletteItem[]}>=[];
  for(const it of items){const found=groups.find(x=>x.g===it.group);if(found)found.its.push(it);else groups.push({g:it.group,its:[it]});}
  const first=items[0];
  return <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}><div className="command-palette" onMouseDown={e=>e.stopPropagation()}><div className="command-search"><Search/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&first){first.action();onClose()}else if(e.key==="Escape")onClose()}} placeholder="搜索命令、页面、股票 / 期货代码、持仓…"/><kbd>ESC</kbd></div>{groups.map(({g,its})=><div className="command-group" key={g}><small>{g}</small>{its.map(it=><button key={it.key} onClick={()=>{it.action();onClose()}}><it.icon size={14}/><span><strong>{it.label}</strong>{it.sub&&<small>{it.sub}</small>}</span></button>)}</div>)}{items.length===0&&<div className="command-group"><p className="command-empty">没有匹配结果——试试股票代码（如 600519）或名称</p></div>}</div></div>;
}

const BROWSER_TOPBAR_H=40;   // 应用顶部栏高度（与 .topbar 一致）
const BROWSER_TOOLBAR_H=44;  // 面板内工具栏高度
const BROWSER_SPLIT=6;       // 面板左侧拖拽分割条宽度（该条不被 webview 覆盖，用于改宽/折叠）
const BROWSER_INSET=12;      // 停靠面板距窗口右/下的边距：卡片式圆角留白，内容区 margin 需加上该值
const BROWSER_MIN_W=260;     // 面板最小宽度
const BROWSER_MAX_RATIO=0.5; // 面板最大宽度 = 窗口可用宽的 50%（随窗口大小按比例动态限制）
const CONTENT_MIN_W=400;     // 拖拽时左侧内容区保底宽度：dock 宽度不得超过 窗口宽-侧边栏-该值
const VIEW_SPLIT=6;          // 多视图间分隔条宽度 px
const VIEW_MIN_PANE=290;     // 多视图面板最小宽 px
const VIEW_MAX_PANE=1200;    // 多视图面板最大宽 px（防止拖得过大）
const VIEW_MIN_ROW=170;      // 上下两行并存时每行最小高 px
// 由分隔条位置(fr 累积占比)生成 grid-template-columns：面板用 fr 弹性轨道、分隔条固定 px
function viewCols(splits:number[]):string{
  const parts:string[]=[];
  let prev=0;
  for(let k=0;k<=splits.length;k++){
    const end=k===splits.length?1:Math.max(prev,Math.min(1,splits[k]));
    parts.push(`${Math.max(end-prev,0.001)}fr`);
    prev=end;
    if(k<splits.length)parts.push(`${VIEW_SPLIT}px`);
  }
  return parts.join(" ");
}
function viewRows(h:number):string{
  const top=Math.max(0.001,Math.min(0.999,h));
  return `${top}fr ${VIEW_SPLIT}px ${Math.max(0.001,1-top)}fr`;
}
function normalizeUrl(input:string):string{
  const trimmed=input.trim();if(!trimmed)return "https://www.bing.com";
  if(/^https?:\/\//i.test(trimmed))return trimmed;
  if(/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(trimmed))return `https://${trimmed}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
}
// 浏览器是主窗口右侧的停靠面板：Rust 端用 Window::add_child 在主窗口内创建原生子 webview，
// 完全在应用内、不产生独立窗口。导航用 navigate 原地跳转（保留页面状态），
// 折叠用 hide/show，缩放用 set_bounds；后退/前进/刷新由 JS 记录 URL 历史后重新 navigate。
function BrowserDock({open,dockW,collapsed,sidebarW,externalUrl,onExternalConsumed,onResize,onToggleCollapse,onClose,notify}:{
  open:boolean;dockW:number;collapsed:boolean;sidebarW:number;
  externalUrl:string|null;onExternalConsumed:()=>void;
  onResize:(w:number)=>void;onToggleCollapse:()=>void;onClose:()=>void;notify:Notify;
}){
  const [url,setUrl]=useState(()=>localStorage.getItem("quant-browser-home")||"https://www.bing.com");
  const [history,setHistory]=useState<string[]>(()=>[localStorage.getItem("quant-browser-home")||"https://www.bing.com"]);
  const [index,setIndex]=useState(0);
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const labelRef=useRef<string|null>(null);
  const openRef=useRef(open);
  const slotRef=useRef<HTMLDivElement>(null);
  const dockWRef=useRef(dockW);dockWRef.current=dockW;
  const collapsedRef=useRef(collapsed);collapsedRef.current=collapsed;
  const sidebarWRef=useRef(sidebarW);sidebarWRef.current=sidebarW;
  const cmd=(name:string,args:Record<string,unknown>)=>invoke(`browser_${name}`,args);
  // 用槽位的可视矩形定位原生 webview。硬编码 innerWidth/顶部高度在 DPI、
  // 字体 zoom（#root.style.zoom）和工具栏实高变化时都会和界面错位。
  // 命令参数是 i32/u32，必须取整，否则 deserialize 失败。
  const bounds=()=>{
    const slot=slotRef.current;
    if(slot){
      const r=slot.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),w:Math.max(0,Math.round(r.width)),h:Math.max(0,Math.round(r.height))};
    }
    const w=dockWRef.current;
    return {x:Math.round(Math.max(0,window.innerWidth-w+BROWSER_SPLIT)),y:Math.round(BROWSER_TOPBAR_H+BROWSER_TOOLBAR_H),w:Math.max(0,Math.round(w-BROWSER_SPLIT)),h:Math.max(0,Math.round(window.innerHeight-BROWSER_TOPBAR_H-BROWSER_TOOLBAR_H))};
  };
  const closeWebview=async()=>{
    const label=labelRef.current;if(!label)return;
    try{await cmd("close",{label})}catch{}
    labelRef.current=null;
  };
  const positionWebview=async()=>{
    const label=labelRef.current;if(!label)return;
    // 任何拖拽进行中跳过：set_bounds 走 IPC 异步滞后，快速拖动会让网页以旧矩形戳出卡片边界，
    // 统一由拖拽结束(up)时按最终尺寸定位一次
    if(document.documentElement.dataset.dragging==="1")return;
    const b=bounds();
    if(b.w<=0||b.h<=0)return;
    try{await cmd("bounds",{label,x:b.x,y:b.y,width:b.w,height:b.h})}catch{}
  };
  const openWebview=async(dest:string)=>{
    await closeWebview();
    const b=bounds();
    const label=`quant-browser-${Date.now()}`;
    labelRef.current=label;
    try{
      await cmd("open",{label,url:dest,x:b.x,y:b.y,width:b.w,height:b.h});
      if(collapsedRef.current)await cmd("hide",{label});
      else await positionWebview();
    }catch(e){labelRef.current=null;throw e}
  };
  const navigateWebview=async(dest:string)=>{
    const label=labelRef.current;if(!label)return;
    await cmd("navigate",{label,url:dest});
  };
  useEffect(()=>{
    if(!open){void closeWebview();return}
    const dest=externalUrl||url;
    openWebview(dest).catch(()=>notify("无法打开浏览器面板","error"));
    if(externalUrl){
      setUrl(dest);
      setHistory(prev=>[...prev.slice(0,index+1),dest]);
      setIndex(prev=>prev+1);
      onExternalConsumed();
    }
    return()=>{void closeWebview()};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open]);
  useEffect(()=>{
    if(!open||collapsed)return;
    const onResizeEv=()=>void positionWebview();
    window.addEventListener("resize",onResizeEv);
    window.visualViewport?.addEventListener("resize",onResizeEv);
    const slot=slotRef.current;
    const ro=slot?new ResizeObserver(onResizeEv):null;
    if(slot)ro?.observe(slot);
    const root=document.getElementById("root");
    const mo=root?new MutationObserver(onResizeEv):null;
    mo?.observe(root!,{attributes:true,attributeFilter:["style"]});
    return()=>{
      window.removeEventListener("resize",onResizeEv);
      window.visualViewport?.removeEventListener("resize",onResizeEv);
      ro?.disconnect();
      mo?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,collapsed]);
  useEffect(()=>{
    const label=labelRef.current;if(!label||!open)return;
    if(collapsed){void cmd("hide",{label})}
    else{void cmd("show",{label}).then(()=>positionWebview())}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,collapsed,dockW]);
  const go=async(target:string,record=true)=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);
    try{
      const dest=normalizeUrl(target);
      if(labelRef.current){await navigateWebview(dest)}else{await openWebview(dest)}
      setUrl(dest);
      if(record){setHistory(prev=>[...prev.slice(0,index+1),dest]);setIndex(prev=>prev+1)}
    }catch{notify("无法打开页面，请检查应用权限","error")}finally{busyRef.current=false;setBusy(false)}
  };
  const step=async(dir:-1|1)=>{
    if(busyRef.current||!open)return;const targetIndex=index+dir;if(targetIndex<0||targetIndex>=history.length)return;
    const dest=history[targetIndex];busyRef.current=true;setBusy(true);
    try{await navigateWebview(dest);setUrl(dest);setIndex(targetIndex)}catch{notify(dir<0?"后退失败":"前进失败","error")}finally{busyRef.current=false;setBusy(false)}
  };
  const reload=async()=>{if(busyRef.current||!open)return;busyRef.current=true;setBusy(true);try{await navigateWebview(url)}catch{notify("刷新失败","error")}finally{busyRef.current=false;setBusy(false)}};
  // 外部 URL（新闻"查看原文"）：面板已挂载则原地导航；首次随 open 一起打开时由上方 [open] effect 以 dest 直接打开，
  // 本 effect 靠 openRef 区分这两种情况，避免同一 URL 被 openWebview 打开两次造成重载。
  useEffect(()=>{
    if(!externalUrl)return;
    if(openRef.current){
      void go(externalUrl);
      onExternalConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[externalUrl]);
  useEffect(()=>{openRef.current=open},[open]);
  // 整页刷新后旧的浏览器子 webview 不会随前端卸载清理，仍残留浮在主窗口上（孤儿 webview），
  // 且新上下文不知道其 label 无法单独关闭。仅当是真正的页面刷新（非 HMR 热替换）时清一次。
  useEffect(()=>{
    const nav=performance.getEntriesByType("navigation")?.[0] as PerformanceNavigationTiming|undefined;
    if(nav?.type==="reload")void invoke("browser_close_all").catch(()=>{});
  },[]);
  // 拖拽过程中直接改 DOM（面板宽 + 内容区 margin），不触发 React 重渲染，拖动才跟手；
  // 只在松开时提交一次 state，并节流更新子 webview 的 bounds。
  const startResize=(e:ReactPointerEvent<HTMLDivElement>)=>{
    e.preventDefault();
    const target=e.currentTarget as HTMLElement;
    const startX=e.clientX;const startW=dockWRef.current;
    const dockEl=target.closest(".browser-dock") as HTMLElement|null;
    const contentEl=document.querySelector(".content-scroll") as HTMLElement|null;
    // 拖拽期间禁用 .content-scroll 的 margin-right 过渡：否则每帧都在做 250ms 动画，内容区永远跟不上光标（"延迟"的根因）
    if(contentEl)contentEl.style.transition="none";
    document.documentElement.dataset.dragging="1"; // 全局标记：图表/positionWebview 延迟到松开再处理
    // 快速拖动时 set_bounds 经 IPC 异步滞后，网页会以旧矩形短暂戳出卡片边界：拖拽期隐藏 webview，只拖边框，松开后按最终尺寸恢复
    const draggingLabel=labelRef.current;
    if(draggingLabel)void cmd("hide",{label:draggingLabel});
    target.setPointerCapture(e.pointerId);
    const apply=(next:number)=>{
      dockWRef.current=next;
      if(dockEl)dockEl.style.width=next+"px";
      if(contentEl)contentEl.style.marginRight=(next+BROWSER_INSET)+"px";
    };
    const move=(ev:PointerEvent)=>{
      const availW=window.innerWidth-sidebarWRef.current;
      const maxW=Math.max(BROWSER_MIN_W,Math.min(Math.round(availW*BROWSER_MAX_RATIO),availW-CONTENT_MIN_W-BROWSER_INSET));
      apply(Math.round(Math.max(BROWSER_MIN_W,Math.min(maxW,startW-(ev.clientX-startX)))));
    };
    const up=()=>{
      document.documentElement.dataset.dragging="0";
      if(contentEl)contentEl.style.transition="";
      window.dispatchEvent(new Event("quant-drag-end"));
      target.removeEventListener("pointermove",move);target.removeEventListener("pointerup",up);target.removeEventListener("pointercancel",up);
      onResize(dockWRef.current);
      // 松开后恢复 webview 并按最终位置定位一次
      const lbl=labelRef.current;
      if(lbl)void cmd("show",{label:lbl}).then(()=>positionWebview());
      else void positionWebview();
    };
    target.addEventListener("pointermove",move);
    target.addEventListener("pointerup",up);
    target.addEventListener("pointercancel",up);
  };
  if(!open)return null;
  if(collapsed)return <div className="browser-rail">
    <button className="icon-btn rail-expand" title="展开浏览器面板" onClick={onToggleCollapse}><ChevronsLeft size={16}/></button>
    <span className="rail-caption">浏览器</span>
  </div>;
  return <div className="browser-dock" style={{width:dockW}}>
    <div className="browser-dock-splitter" onPointerDown={startResize} onDoubleClick={onToggleCollapse} title="拖动调整浏览器宽度，双击折叠"/>
    <div className="browser-toolbar">
      <button className="icon-btn" title="后退" disabled={index<=0} onClick={()=>void step(-1)}><ChevronLeft size={15}/></button>
      <button className="icon-btn" title="前进" disabled={index>=history.length-1} onClick={()=>void step(1)}><ChevronRight size={15}/></button>
      <button className="icon-btn" title="刷新" onClick={()=>void reload()}><RefreshCw className={busy?"spin":""} size={14}/></button>
      <form className="browser-address" onSubmit={e=>{e.preventDefault();void go(url)}}><Globe size={13}/><input value={url} onChange={e=>setUrl(e.target.value)} spellCheck={false} placeholder="输入网址或搜索关键词，回车打开…"/></form>
      <button className="icon-btn" title="折叠浏览器面板" onClick={onToggleCollapse}><ChevronsRight size={15}/></button>
      <button className="icon-btn browser-close" title="关闭浏览器面板" onClick={onClose}><X size={15}/></button>
    </div>
    <div className="browser-webview-slot" ref={slotRef}/>
  </div>;
}

// 浏览器环境（无 Tauri 运行时）下隐藏窗口控制按钮，避免 getCurrentWindow() 同步抛错导致整页崩溃
const inTauri=()=>typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;

function WindowControls(){
  const [maximized,setMaximized]=useState(false);
  const native=inTauri();
  useEffect(()=>{
    if(!native)return;
    const win=getCurrentWindow();
    const sync=()=>{void win.isMaximized().then(setMaximized).catch(()=>undefined)};
    sync();
    let unlisten:undefined|(()=>void);
    void win.onResized(sync).then(fn=>{unlisten=fn}).catch(()=>undefined);
    return()=>{unlisten?.()};
  },[native]);
  if(!native)return null;
  const run=(fn:()=>Promise<unknown>)=>{void fn().catch(()=>undefined)};
  return <div className="window-controls">
    <button className="win-btn" title="最小化" onClick={()=>run(()=>getCurrentWindow().minimize())}><Minus size={14}/></button>
    <button className="win-btn" title={maximized?"还原":"最大化"} onClick={()=>run(()=>getCurrentWindow().toggleMaximize())}>{maximized?<Copy size={12}/>:<Square size={12}/>}</button>
    <button className="win-btn win-close" title="关闭" onClick={()=>run(()=>getCurrentWindow().close())}><X size={14}/></button>
  </div>;
}

const WEEKDAY_LABELS=["日","一","二","三","四","五","六"];
function TasksPage({tasks,setTasks,model,status,runTask,notify}:{tasks:ScheduledTask[];setTasks:(tasks:ScheduledTask[])=>void;model:string;status:WorkspaceStatus;runTask:(task:ScheduledTask)=>Promise<void>;notify:Notify}){
  const [showForm,setShowForm]=useState(false);
  const [name,setName]=useState("");const [prompt,setPrompt]=useState("");
  const [frequency,setFrequency]=useState<ScheduledTask["frequency"]>("daily");
  const [hour,setHour]=useState(9);const [minute,setMinute]=useState(0);const [intervalMinutes,setIntervalMinutes]=useState(60);
  const [weekdays,setWeekdays]=useState<number[]>([1,2,3,4,5]);
  const [taskModel,setTaskModel]=useState("");
  const [tradingDaysOnly,setTradingDaysOnly]=useState(false);
  const addTask=()=>{
    if(!prompt.trim()){notify("请填写任务内容","error");return}
    const task:ScheduledTask={id:`t${Date.now()}_${Math.random().toString(36).slice(2,7)}`,name:name.trim()||prompt.trim().slice(0,24),prompt:prompt.trim(),frequency,hour,minute,intervalMinutes,weekdays:frequency==="weekly"?weekdays:undefined,model:taskModel||undefined,enabled:true,tradingDaysOnly:frequency!=="once"?tradingDaysOnly:undefined,createdAt:Date.now(),history:[]};
    const next=[...tasks,task];void saveTasks(next);setTasks(next);setShowForm(false);setName("");setPrompt("");setTaskModel("");notify("定时任务已创建");
  };
  const toggleTask=(task:ScheduledTask)=>{const next=tasks.map(t=>t.id===task.id?{...t,enabled:!t.enabled}:t);void saveTasks(next);setTasks(next)};
  const deleteTask=(task:ScheduledTask)=>{const next=tasks.filter(t=>t.id!==task.id);void deleteRemoteTask(task.id).catch(()=>undefined);void saveTasks(next);setTasks(next);notify("定时任务已删除")};
  return <div className="page-body tasks-page fade-in">
    <AlertsCard/>
    <NotificationsCard/>
    <div className="page-action-row"><p>QuantDesk 运行期间会自动检查并触发；一次性、每小时、每天、每周或固定间隔都支持。</p><button className="secondary-btn" onClick={()=>setShowForm(v=>!v)}><Plus size={13}/>{showForm?"收起表单":"新建任务"}</button></div>
    {showForm&&<div className="task-form card">
      <h3>新建定时任务</h3>
      <label>任务名称<input value={name} onChange={e=>setName(e.target.value)} placeholder="可选，默认取内容前 24 字"/></label>
      <label>任务内容<textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="到点后交给 Agent 执行的内容，例如：汇总今日市场数据并给出持仓风险提示"/></label>
      <div className="task-form-grid">
        <label>频率<select value={frequency} onChange={e=>setFrequency(e.target.value as ScheduledTask["frequency"])}><option value="once">一次性</option><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔（分钟）</option></select></label>
        {frequency==="interval"?<label>间隔分钟数<input type="number" min="1" max="10080" value={intervalMinutes} onChange={e=>setIntervalMinutes(Math.max(1,Number(e.target.value)||60))}/></label>:<label>时间<input type="time" value={`${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`} onChange={e=>{const [h,m]=e.target.value.split(":").map(Number);setHour(Number.isFinite(h)?h:9);setMinute(Number.isFinite(m)?m:0)}}/></label>}
      </div>
      {frequency==="weekly"&&<div className="weekday-row">{WEEKDAY_LABELS.map((label,index)=><button key={index} className={weekdays.includes(index)?"active":""} onClick={()=>setWeekdays(prev=>prev.includes(index)?prev.filter(w=>w!==index):[...prev,index].sort())}>{label}</button>)}</div>}
      {frequency!=="once"&&<label className="task-trading-days"><input type="checkbox" checked={tradingDaysOnly} onChange={e=>setTradingDaysOnly(e.target.checked)}/>仅交易日运行（周末与节假日跳过）</label>}
      <label>模型（留空用默认）<select value={taskModel} onChange={e=>setTaskModel(e.target.value)}><option value="">默认（{model}）</option><optgroup label="OpenAI"><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.5">gpt-5.5</option></optgroup><optgroup label="DeepSeek"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></optgroup><optgroup label="Qwen"><option value="qwen3.7-flash">Qwen 3.7 Flash</option><option value="qwen3.7-plus">Qwen 3.7 Plus</option><option value="qwen3.8-max">Qwen 3.8 Max</option></optgroup><optgroup label="OpenRouter"><option value="anthropic/claude-opus-4.7">Claude Opus 4.7</option><option value="openai/gpt-5.4">GPT-5.4</option><option value="google/gemini-3.1-pro">Gemini 3.1 Pro</option><option value="x-ai/grok-4">Grok 4</option></optgroup></select></label>
      <div className="task-form-actions"><button className="secondary-btn" onClick={()=>setShowForm(false)}>取消</button><button className="primary-btn" onClick={addTask}><Plus size={13}/>创建</button></div>
    </div>}
    {tasks.length===0?<div className="real-empty"><span><CalendarClock/></span><h2>还没有定时任务</h2><p>设置一个周期任务，QuantDesk 会在到点时自动运行 Agent 并把结果记录在这里。任务保存在本机，重启后继续生效。</p><button className="primary-btn" onClick={()=>setShowForm(true)}><Plus size={13}/>新建定时任务</button></div>:
    <div className="task-list">{tasks.map(task=><div className="task-item card" key={task.id}>
      <div className="task-item-head"><span className={`task-status ${task.lastStatus||"idle"}`}><i/></span><div className="task-item-title"><strong>{task.name}</strong><small>{describeFrequency(task)} · 下次 {describeNext(task)}</small></div></div>
      <p className="task-prompt">{task.prompt}</p>
      {task.lastResult&&<p className="task-result">最近结果：{task.lastResult.length>180?`${task.lastResult.slice(0,180)}…`:task.lastResult}</p>}
      <div className="task-actions">
        <button className={`toggle ${task.enabled?"on":""}`} title={task.enabled?"点击关闭":"点击启用"} onClick={()=>toggleTask(task)}><i/></button>
        <button className="secondary-btn" disabled={task.lastStatus==="running"} onClick={()=>void runTask(task)}>{task.lastStatus==="running"?<RefreshCw className="spin" size={12}/>:<Play size={12}/>}立即运行</button>
        <button className="icon-btn task-delete" title="删除任务" onClick={()=>deleteTask(task)}><Trash2 size={14}/></button>
      </div>
      {task.history.length>0&&<div className="task-history">{task.history.slice(0,3).map((entry,index)=><div key={index}><span className={entry.status==="done"?"ok":"err"}/><small>{new Date(entry.at).toLocaleString()}</small><em>{entry.status==="done"?"完成":"失败"}</em><span>{entry.preview}</span></div>)}</div>}
    </div>)}</div>}
  </div>;
}

// 任务栏图标: 用品牌首字母 "Q" 动态生成 RGBA 图标,
// 跟随 Windows 深色/浅色模式切换配色(浅色任务栏→深底浅字, 反之亦然)。
async function applyTaskbarIcon(darkTaskbar: boolean): Promise<void> {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = darkTaskbar ? "#f5f4ef" : "#1c1c1a";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = darkTaskbar ? "#1c1c1a" : "#f5f4ef";
    ctx.font = `bold 38px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Q", size / 2, size / 2 + 3);
    // PNG 字节交给 Tauri 解码(需要 image-png feature)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    await getCurrentWindow().setIcon(new Uint8Array(await blob.arrayBuffer()));
  } catch { /* set_icon 权限或平台不支持时静默 */ }
}

export default function App(){
  const [page,setPage]=useState<PageId>("agent");const [activeChatId,setActiveChatIdState]=useState<string|null>(()=>getActiveChatId());const [theme,setThemeState]=useState<Theme>(()=>(localStorage.getItem("quant-theme") as Theme)||"light");const [collapsed,setCollapsed]=useState(false);const [palette,setPalette]=useState(false);const [keyModal,setKeyModal]=useState<ApiProvider|null>(null);const [status,setStatus]=useState<WorkspaceStatus>(emptyStatus);const [draft,setDraft]=useState("");const [model,setModel]=useState(()=>localStorage.getItem("quant-model")||"gpt-5.4-mini");const [toast,setToast]=useState<{message:string;tone:string}|null>(null);const [tasks,setTasks]=useState<ScheduledTask[]>([]);const [browserOpen,setBrowserOpen]=useState(false);
  const [dockW,setDockW]=useState(()=>{const v=Number(localStorage.getItem("quant-dock-w"));return v>=260&&v<=760?v:430});
  const [dockCollapsed,setDockCollapsed]=useState(()=>localStorage.getItem("quant-dock-collapsed")==="1");
  const [ctxCollapsed,setCtxCollapsed]=useState(()=>localStorage.getItem("quant-ctx-collapsed")==="1");
  const [stock,setStock]=useState<StockTarget|null>(null);
  const [stockFrom,setStockFrom]=useState<PageId>("market");
  const [views,setViews]=useState<ViewDef[]>([]);
  const [addViewOpen,setAddViewOpen]=useState(false);
  const [addBottomOpen,setAddBottomOpen]=useState(false);
  const mainView=useMemo<ViewDef>(()=>({key:"main",page,title:page==="stock"?(stock?`${stock.name} · ${stock.symbol}`:"个股详情"):pageTitles[page].title,subtitle:page==="stock"?"实时行情与 K 线，A 股红涨绿跌":pageTitles[page].subtitle,row:"top",stock:stock??undefined,stockFrom}),[page,stock,stockFrom]);
  const activeView=mainView;
  const openStock=(target:StockTarget)=>{setStockFrom(activeView.page);setStock(target);setPage("stock")};
  const openStockFor=(key:string)=>(target:StockTarget)=>{
    if(key==="main"){setStockFrom(mainView.page);setStock(target);setPage("stock")}
    else setViews(prev=>prev.map(v=>v.key===key?{...v,page:"stock",stock:target,stockFrom:v.page}:v));
  };
  const addView=(m:ViewModule,row:"top"|"bottom"="top")=>{
    const closeMenus=()=>{setAddViewOpen(false);setAddBottomOpen(false)};
    if(m.page==="browser"){setBrowserOpen(true);setDockCollapsed(false);closeMenus();return}
    if(m.page==="settings"){setPage("settings");closeMenus();return}
    if(views.some(v=>v.page===m.page)){closeMenus();return}
    if(views.filter(v=>v.row===row).length>=2){notify(row==="top"?"上方最多 3 个并排（主视图 + 2 个附加）":"下方最多 2 个并排","error");closeMenus();return}
    const key=`view-${row}-${m.page}-${Date.now()}`;
    setViews(prev=>[...prev,{key,page:m.page,title:m.label,subtitle:pageTitles[m.page].subtitle,row}]);
    closeMenus();
  };
  const closeView=(key:string)=>{setViews(prev=>prev.filter(v=>v.key!==key))};
  // 多视图面板尺寸：vSplits/vSplitsB 为各排竖直分隔条在绘图区内的 fr 累积占比，hSplit 为上下两行时上行高度占比
  const multiRef=useRef<HTMLDivElement>(null);
  const topRowRef=useRef<HTMLDivElement>(null);
  const bottomRowRef=useRef<HTMLDivElement>(null);
  const [vSplits,setVSplits]=useState<number[]>([0.5]);
  const [vSplitsB,setVSplitsB]=useState<number[]>([0.5]);
  const [hSplit,setHSplit]=useState(0.6);
  const vSplitsRef=useRef(vSplits);vSplitsRef.current=vSplits;
  const vSplitsBRef=useRef(vSplitsB);vSplitsBRef.current=vSplitsB;
  const hSplitRef=useRef(hSplit);hSplitRef.current=hSplit;
  // 拖拽分隔条：直接改 DOM 的 grid 轨道保持跟手，松开才提交 state
  // 竖直分隔条拖拽工厂：rowRef 定位所在排、splitsRef/commit 读写该排的分隔条位置
  const vsplitDrag=(k:number,rowRef:RefObject<HTMLDivElement|null>,splitsRef:RefObject<number[]>,commit:(s:number[])=>void)=>(e:React.PointerEvent<HTMLDivElement>)=>{
    e.preventDefault();
    const t=e.currentTarget as HTMLElement;
    const el=rowRef.current!;
    const rect=el.getBoundingClientRect();
    const cs=getComputedStyle(el);
    const padL=parseFloat(cs.paddingLeft)||0;
    const padR=parseFloat(cs.paddingRight)||0;
    const m=splitsRef.current.length;
    const availW=Math.max(rect.width-padL-padR-m*VIEW_SPLIT,1);
    const minF=VIEW_MIN_PANE/availW,maxF=VIEW_MAX_PANE/availW;
    // 全局拖拽门控：图表拖拽期不重渲，松开再同步；同时禁用内容区 margin 过渡，避免浏览器刚开/刚调宽时干扰
    const contentEl=document.querySelector(".content-scroll") as HTMLElement|null;
    if(contentEl)contentEl.style.transition="none";
    document.documentElement.dataset.dragging="1";
    t.setPointerCapture(e.pointerId);
    // rAF 节流：pointermove 可能一帧多次，只在一帧内写一次 grid 轨道，避免重复布局造成拖拽延迟
    let raf=0;
    const flush=()=>{raf=0;if(rowRef.current)rowRef.current.style.gridTemplateColumns=viewCols(splitsRef.current)};
    const apply=(x:number)=>{
      const cur=splitsRef.current;
      const raw=(x-rect.left-padL-k*VIEW_SPLIT-VIEW_SPLIT/2)/availW;
      // 左邻面板在 [min,max]，右邻面板在 [min,max]，取交集
      const leftMin=k===0?minF:cur[k-1]+minF;
      const leftMax=k===0?maxF:cur[k-1]+maxF;
      const rightMin=k===m-1?1-minF:cur[k+1]-minF;
      const rightMax=k===m-1?1-maxF:cur[k+1]-maxF;
      const lo=Math.max(leftMin,rightMax);
      const hi=Math.min(leftMax,rightMin);
      const next=[...cur];next[k]=Math.max(lo,Math.min(hi,raw));
      splitsRef.current=next;
      if(!raf)raf=requestAnimationFrame(flush);
    };
    const move=(ev:PointerEvent)=>apply(ev.clientX);
    const up=()=>{
      if(raf){cancelAnimationFrame(raf);raf=0}
      if(contentEl)contentEl.style.transition="";
      document.documentElement.dataset.dragging="0";
      window.dispatchEvent(new Event("quant-drag-end"));
      t.removeEventListener("pointermove",move);t.removeEventListener("pointerup",up);t.removeEventListener("pointercancel",up);
      flush();
      commit(splitsRef.current);
    };
    t.addEventListener("pointermove",move);
    t.addEventListener("pointerup",up);
    t.addEventListener("pointercancel",up);
  };
  const vsplitTopDrag=(k:number)=>vsplitDrag(k,topRowRef,vSplitsRef,setVSplits);
  const vsplitBottomDrag=(k:number)=>vsplitDrag(k,bottomRowRef,vSplitsBRef,setVSplitsB);
  const startHRowDrag=(e:React.PointerEvent<HTMLDivElement>)=>{
    e.preventDefault();
    const t=e.currentTarget as HTMLElement;
    const el=multiRef.current!;
    const rect=el.getBoundingClientRect();
    const cs=getComputedStyle(el);
    const padT=parseFloat(cs.paddingTop)||0;
    const padB=parseFloat(cs.paddingBottom)||0;
    const availH=Math.max(rect.height-padT-padB-VIEW_SPLIT,1);
    const minF=VIEW_MIN_ROW/availH;
    const contentEl=document.querySelector(".content-scroll") as HTMLElement|null;
    if(contentEl)contentEl.style.transition="none";
    document.documentElement.dataset.dragging="1";
    t.setPointerCapture(e.pointerId);
    let raf=0;
    const flush=()=>{raf=0;if(multiRef.current)multiRef.current.style.gridTemplateRows=viewRows(hSplitRef.current)};
    const apply=(y:number)=>{
      const raw=(y-rect.top-padT-VIEW_SPLIT/2)/availH;
      hSplitRef.current=Math.max(minF,Math.min(1-minF,raw));
      if(!raf)raf=requestAnimationFrame(flush);
    };
    const move=(ev:PointerEvent)=>apply(ev.clientY);
    const up=()=>{
      if(raf){cancelAnimationFrame(raf);raf=0}
      if(contentEl)contentEl.style.transition="";
      document.documentElement.dataset.dragging="0";
      window.dispatchEvent(new Event("quant-drag-end"));
      t.removeEventListener("pointermove",move);t.removeEventListener("pointerup",up);t.removeEventListener("pointercancel",up);
      flush();
      setHSplit(hSplitRef.current);
    };
    t.addEventListener("pointermove",move);
    t.addEventListener("pointerup",up);
    t.addEventListener("pointercancel",up);
  };
  const [externalUrl,setExternalUrl]=useState<string|null>(null);
  const openUrlInBrowser=useCallback((url:string)=>{setExternalUrl(url);setDockCollapsed(false);setBrowserOpen(true)},[]);
  const [sidebarW,setSidebarW]=useState(()=>{const v=Number(localStorage.getItem("quant-sidebar-w"));return v>=180&&v<=420?v:244});
  const [systemDark,setSystemDark]=useState(()=>matchMedia("(prefers-color-scheme: dark)").matches);
  const notify:Notify=(message,tone="ok")=>{setToast({message,tone});setTimeout(()=>setToast(null),3200)};
  const refresh=async()=>{try{setStatus(await getWorkspaceStatus())}catch{/* engine may still be starting */}};
  const markProviderConfigured=(provider:ApiProvider)=>setStatus(current=>withProviderConfigured(current,provider));
  const ensureProvider=async(provider:ApiProvider):Promise<boolean>=>{
    try{
      if(!await hasApiKey(provider))return false;
      await configureEngine(provider);
      markProviderConfigured(provider);
      return true;
    }catch{return false}
  };
  const restoreStoredCredentials=async()=>{
    const providers:ApiProvider[]=["OpenAI","DeepSeek","Qwen","OpenRouter","AlphaVantage","Tushare"];
    const stored=(await Promise.all(providers.map(async provider=>({provider,stored:await hasApiKey(provider).catch(()=>false)})))).filter(item=>item.stored);
    await Promise.allSettled(stored.map(item=>configureEngine(item.provider)));
    const brokers:BrokerId[]=["alpaca","ibkr"];
    const storedBrokers=(await Promise.all(brokers.map(async broker=>({broker,stored:await hasBrokerCredentials(broker).catch(()=>false)})))).filter(item=>item.stored);
    await Promise.allSettled(storedBrokers.map(item=>configureBrokerEngine(item.broker)));
    await refresh();
  };
  // 定时任务的执行已迁到引擎侧(见 engine/main.py _run_agent_headless / POST /scheduler/tasks/{id}/run):
  // 到点自动跑由引擎后台调度循环负责, 前端只负责展示与「立即运行」。
  const runScheduledTask=async(task:ScheduledTask)=>{
    setTasks(prev=>prev.map(t=>t.id===task.id?{...t,lastStatus:"running" as const,lastRunAt:Date.now()}:t));
    try{
      await runTaskNow(task.id);
      const list=await loadTasks();
      setTasks(list);
      const done=list.find(t=>t.id===task.id);
      if(localStorage.getItem("quant-notifications")!=="0")notify(`定时任务「${task.name}」${done?.lastStatus==="error"?"执行失败":"已执行"}`,"ok");
    }catch(e){
      setTasks(await loadTasks().catch(()=>[]));
      const message=e instanceof Error?e.message:String(e);
      if(localStorage.getItem("quant-notifications")!=="0")notify(`定时任务「${task.name}」失败：${message.slice(0,60)}`,"error");
    }
  };
  useEffect(()=>{const media=matchMedia("(prefers-color-scheme: dark)");const update=()=>setSystemDark(media.matches);media.addEventListener("change",update);return()=>media.removeEventListener("change",update)},[]);
  useEffect(()=>{document.documentElement.dataset.theme=theme==="system"?(systemDark?"dark":"light"):theme},[theme,systemDark]);
  // 任务栏图标跟随 Windows/应用深浅色切换
  const effectiveDark=theme==="system"?systemDark:theme==="dark";
  useEffect(()=>{void applyTaskbarIcon(effectiveDark)},[effectiveDark]);
  useEffect(()=>{localStorage.setItem("quant-dock-w",String(dockW))},[dockW]);
  useEffect(()=>{localStorage.setItem("quant-dock-collapsed",dockCollapsed?"1":"0")},[dockCollapsed]);
  useEffect(()=>{localStorage.setItem("quant-ctx-collapsed",ctxCollapsed?"1":"0")},[ctxCollapsed]);
  useEffect(()=>{localStorage.setItem("quant-sidebar-w",String(sidebarW))},[sidebarW]);
  useEffect(()=>{document.documentElement.dataset.tone=localStorage.getItem("quant-tone")||"cn";document.documentElement.dataset.pointer=localStorage.getItem("quant-pointer")!=="0"?"1":"0";if(localStorage.getItem("quant-always-on-top")==="1"&&inTauri())void getCurrentWindow().setAlwaysOnTop(true).catch(()=>undefined);applyFontScale(Number(localStorage.getItem("quant-font-scale"))||1)},[]);
  // 账户门控：checking=探测中 gate=显示登录/注册 ready=已登录进入工作区
  const [auth,setAuth]=useState<{phase:"checking"|"gate"|"ready";mode:"login"|"register";user:string|null;note:string}>({phase:"checking",mode:"login",user:null,note:""});
  const bootWorkspace=async()=>{
    for(let i=0;i<20;i++){
      try{await getWorkspaceStatus();await restoreStoredCredentials();break}
      catch{await new Promise(r=>setTimeout(r,400))}
    }
    // 引擎就绪后: 把 SQLite 里镜像的对话合并回本地 + 申请系统通知权限
    await syncThreadsFromServer();
    window.dispatchEvent(new Event("quant-threads-updated"));
    if("Notification" in window&&Notification.permission==="default")void Notification.requestPermission().catch(()=>undefined);
  };
  useEffect(()=>{void (async()=>{
    // 凭据恢复必须无条件执行：autostart 只决定是否拉起引擎，
    // 不能因为引擎端口被占用（startEngine reject）就跳过恢复，否则每次重启都要重新配置 Key。
    let engineNote="";
    if(localStorage.getItem("quant-autostart")!=="0"){try{await startEngine()}catch(e){engineNote=String(e)}}
    // 引擎就绪后先探测账户状态：未初始化→注册首个管理员；已初始化未登录→登录页
    // 冻结引擎（onefile）首次启动需解压约 20-40 秒，探测窗口必须足够长
    let probe:AuthStatus|null=null;
    for(let i=0;i<90;i++){
      try{probe=await getAuthStatus();break}
      catch{await new Promise(r=>setTimeout(r,500))}
    }
    if(!probe){
      // 兜底：显式再拉起一次引擎（覆盖 autostart 被关闭但用户期望可用的场景），再探测 30 秒
      try{await startEngine()}catch(e){engineNote=engineNote||String(e)}
      for(let i=0;i<60;i++){
        try{probe=await getAuthStatus();break}
        catch{await new Promise(r=>setTimeout(r,500))}
      }
    }
    if(!probe){setAuth({phase:"gate",mode:"login",user:null,note:`本地引擎未就绪${engineNote?`：${engineNote}`:"，请重启应用后重试"}`});return}
    if(!probe.initialized){setAuth({phase:"gate",mode:"register",user:null,note:""});return}
    if(!probe.authenticated){setAuth({phase:"gate",mode:"login",user:null,note:""});return}
    setAuth({phase:"ready",mode:"login",user:probe.user?.username??null,note:""});
    await bootWorkspace();
  })()},[]);
  // 任何接口在令牌重试后仍 401（会话过期）→ 回到登录页
  useEffect(()=>onUnauthorized(()=>{
    setAuth(a=>a.phase==="ready"?{...a,phase:"gate",mode:"login",user:null,note:"登录会话已失效，请重新登录"}:a);
  }),[]);
  // 引擎进程意外退出时给出明确提示（后端监控线程发出），不再让用户面对无法解释的连接错误
  useEffect(()=>{
    let unlisten:(()=>void)|null=null;
    void listen<{code:number|null}>("engine-exited",event=>{
      const code=event.payload?.code;
      notify(`本地引擎已退出${code!==null&&code!==undefined?`（退出码 ${code}）`:""}，请重启应用`, "error");
    }).then(fn=>{unlisten=fn}).catch(()=>undefined);
    return()=>{unlisten?.()};
  },[]);
  const handleAuthed=(username:string)=>{
    setAuth({phase:"ready",mode:"login",user:username,note:""});
    void bootWorkspace();
  };
  const handleLogout=async()=>{
    await authLogout();
    setAuth(a=>({...a,phase:"gate",mode:"login",user:null,note:"已退出登录"}));
  };
  // 定时任务的到点触发已迁到引擎后台调度循环, 前端轮询只做展示刷新,
  // 因此应用不在前台/引擎仍存活时任务照跑, 不再依赖 setInterval 在前台触发。
  useEffect(()=>{
    let last: ScheduledTask[] | null = null;
    const refresh=async()=>{
      const list=await loadTasks().catch(()=>last ?? []);
      // 把引擎里 Agent 新建/删除/运行更新后的任务同步进 UI;内容无变化则不触发 re-render。
      if(!last||!tasksEqual(list,last))setTasks(list);
      const changed=last!==null&&!tasksEqual(list,last);
      last=list;
      // 定时任务到点执行后, 引擎会把结果写入任务专属对话线程(chat_threads)。
      // 这里检测到任务状态变化就拉取一次服务端线程并广播, 让对话区实时出现运行记录。
      if(changed){
        await syncThreadsFromServer().catch(()=>undefined);
        window.dispatchEvent(new Event("quant-threads-updated"));
      }
    };
    void refresh();
    const timer=setInterval(refresh,15000);
    return()=>clearInterval(timer);
  },[]);
  const setTheme=(value:Theme)=>{setThemeState(value);localStorage.setItem("quant-theme",value)};
  const selectChat=(id:string|null)=>{setActiveChatId(id);setActiveChatIdState(id);setActiveThread(id);setPage("agent")};
  const launchAgent=(prompt:string)=>{setDraft(prompt);selectChat(null)};
  useEffect(()=>{const fn=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setPalette(v=>!v)}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="n"){e.preventDefault();setDraft("");selectChat(null)}if((e.ctrlKey||e.metaKey)&&e.key===","){e.preventDefault();setPage("settings")}if(e.key==="Escape"){setPalette(false);setKeyModal(null);setAddViewOpen(false);setAddBottomOpen(false)}};addEventListener("keydown",fn);return()=>removeEventListener("keydown",fn)},[]);
  const renderView=useCallback((av:ViewDef,onOpenStock:(t:StockTarget)=>void)=>{
    if(av.page==="agent")return <AgentPage status={status} onNavigate={setPage} onSetup={setKeyModal} ensureProvider={ensureProvider} initialDraft={draft} clearDraft={()=>setDraft("")} model={model} setModel={setModel} notify={notify} ctxCollapsed={ctxCollapsed} onToggleCtx={()=>setCtxCollapsed(v=>!v)} activeChatId={activeChatId} onChatId={id=>{setActiveChatId(id);setActiveChatIdState(id)}}/>;
    if(av.page==="overview")return <OverviewPage status={status} onNavigate={setPage}/>;
    if(av.page==="sessions")return <SessionsPage notify={notify} onOpenChat={id=>selectChat(id||null)}/>;
    if(av.page==="models")return <ModelsPage launchAgent={launchAgent}/>;
    if(av.page==="data")return <DataPage status={status} onImported={setStatus} onProviderKey={()=>setKeyModal("AlphaVantage")} onTushareKey={()=>setKeyModal("Tushare")} notify={notify}/>;
    if(av.page==="portfolio")return <PortfolioPage status={status} onImported={setStatus} launchAgent={launchAgent} notify={notify}/>;
    if(av.page==="backtest")return <BacktestPage status={status} onChanged={()=>void refresh()} notify={notify}/>;
    if(av.page==="risk")return <RiskPage status={status} launchAgent={launchAgent} onNavigate={setPage}/>;
    if(av.page==="tasks")return <TasksPage tasks={tasks} setTasks={setTasks} model={model} status={status} runTask={runScheduledTask} notify={notify}/>;
    if(av.page==="market")return <MarketPage onOpenStock={onOpenStock}/>;
    if(av.page==="rankings")return <RankingsPage onOpenStock={onOpenStock}/>;
    if(av.page==="news")return <NewsPage onOpenExternal={openUrlInBrowser}/>;
    if(av.page==="stock")return av.stock?<StockPage target={av.stock} onBack={()=>{const from=av.stockFrom||"market";if(av.key==="main")setPage(from);else setViews(prev=>prev.map(v=>v.key===av.key?{...v,page:from,stock:undefined}:v))}} onOpenStock={onOpenStock}/>:<MarketPage onOpenStock={onOpenStock}/>;
    if(av.page==="papertrade")return <PaperTradePage notify={notify}/>;
    if(av.page==="brokeroms")return <BrokerOmsPage notify={notify}/>;
    return <SettingsPage theme={theme} setTheme={setTheme} onApiKey={setKeyModal} status={status} model={model} setModel={setModel} notify={notify} onOpenExternal={openUrlInBrowser}/>;
  },[status,draft,model,theme,tasks,ctxCollapsed,activeChatId,openUrlInBrowser]);
  const topAdded=views.filter(v=>v.row==="top");
  const bottomViews=views.filter(v=>v.row==="bottom");
  const topPanels=[mainView,...topAdded];
  const hasViews=views.length>0;
  // 面板数量变化时把各排竖直分隔条重置为均分（上行最多 3 列，下行最多 2 列）
  useEffect(()=>{
    const topCols=Math.min(topPanels.length,3);
    const ts:number[]=[];
    for(let k=1;k<topCols;k++)ts.push(k/topCols);
    setVSplits(ts);
    const bCols=Math.min(bottomViews.length,2);
    const bs:number[]=[];
    for(let k=1;k<bCols;k++)bs.push(k/bCols);
    setVSplitsB(bs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[topPanels.length,bottomViews.length]);
  // 渲染用分隔条位置：数量不匹配时退化为均分，避免新增/关闭视图瞬间错位
  const topCols=Math.min(topPanels.length,3);
  const splitCount=Math.max(0,topCols-1);
  const renderSplits=splitCount===0?[]:(vSplits.length===splitCount?vSplits:Array.from({length:splitCount},(_,k)=>(k+1)/topCols));
  const bCols=Math.min(bottomViews.length,2);
  const bSplitCount=Math.max(0,bCols-1);
  const renderSplitsB=bSplitCount===0?[]:(vSplitsB.length===bSplitCount?vSplitsB:Array.from({length:bSplitCount},(_,k)=>(k+1)/bCols));
  const title=hasViews?{title:"多视图",subtitle:bottomViews.length?`${topPanels.length+bottomViews.length} 个面板 · 上 ${topPanels.length} 下 ${bottomViews.length} 并排`:`${topPanels.length} 个面板并排（上方最多 3 个）`}:mainView.page==="stock"?{title:mainView.stock?.name?`${mainView.stock.name} · ${mainView.stock.symbol}`:"个股详情",subtitle:"实时行情与 K 线，A 股红涨绿跌"}:{title:mainView.title,subtitle:mainView.subtitle};
  const paneNode=(v:ViewDef)=>{
    const openStockV=openStockFor(v.key);
    return <div className="view-pane"><div className="view-pane-head"><span className="vph-title" title={v.subtitle}>{v.title}</span>{v.key!=="main"&&<i className="vph-close" onClick={()=>closeView(v.key)} title="关闭视图"><X size={12}/></i>}</div><div className="view-pane-body"><div className="page-enter" key={v.page==="stock"?`stock-${v.stock?.symbol||"x"}`:v.page}>{renderView(v,openStockV)}</div></div></div>;
  };
  // 资讯条最右侧"添加下方视图"按钮：向下排添加视图（最多 2 个并排），菜单自栏内向上弹出
  const addBottomActions = bottomViews.length < 2 ? (
    <span className="vns-add-wrap">
      <button className="vns-add-btn" title="添加下方视图" onClick={()=>setAddBottomOpen(v=>!v)}><Plus size={13}/></button>
      {addBottomOpen&&<>
        <div className="view-add-backdrop" onClick={()=>setAddBottomOpen(false)}/>
        <div className="view-add-drop vns-add-drop">
          <div className="view-add-head">添加下方视图<small>最多 2 个并排</small></div>
          {VIEW_MODULES.map(m=><button key={m.page} onClick={()=>addView(m,"bottom")}><m.icon size={14}/><span>{m.label}</span>{views.some(v=>v.page===m.page&&m.page!=="browser")&&<Check size={12} className="vad-check"/>}</button>)}
        </div>
      </>}
    </span>
  ) : undefined;
  // 账户门控：登录/注册完成前不渲染工作区
  if(auth.phase!=="ready"){
    if(auth.phase==="checking")return <div className="auth-screen"><div className="auth-boot"><img className="auth-logo" src={altasDark} alt="QuantDesk" draggable={false}/><img className="auth-logo dark" src={altasLight} alt="" aria-hidden="true" draggable={false}/><span>正在连接本地引擎…</span></div></div>;
    return <AuthScreen mode={auth.mode} note={auth.note} onAuthed={handleAuthed}/>;
  }
  return <div className={`app-shell ${collapsed?"sidebar-collapsed":""}${browserOpen&&!dockCollapsed?" dock-open":""}`} style={{gridTemplateColumns:collapsed?"72px 1fr":`${sidebarW}px 1fr`}}>{collapsed?null:<div className="sidebar-splitter" style={{left:sidebarW}} onPointerDown={e=>{e.preventDefault();const t=e.currentTarget as HTMLElement;const startX=e.clientX;const startW=sidebarW;const shell=document.querySelector(".app-shell") as HTMLElement|null;t.setPointerCapture(e.pointerId);let lastW=startW;if(shell)shell.classList.add("no-anim");const move=(ev:PointerEvent)=>{lastW=Math.round(Math.max(180,Math.min(420,startW+(ev.clientX-startX))));if(shell)shell.style.gridTemplateColumns=`${lastW}px 1fr`;t.style.left=lastW+"px"};const up=()=>{t.removeEventListener("pointermove",move);t.removeEventListener("pointerup",up);t.removeEventListener("pointercancel",up);if(shell)shell.classList.remove("no-anim");setSidebarW(lastW)};t.addEventListener("pointermove",move);t.addEventListener("pointerup",up);t.addEventListener("pointercancel",up)}} title="拖动调整侧边栏宽度"/>}<aside className="sidebar"><div className="sidebar-top" data-tauri-drag-region><button className="brand" onClick={()=>setPage("agent")}><img className="brand-logo" src={(theme==="system"?(systemDark?"dark":"light"):theme)==="dark"?altasLight:altasDark} alt="QuantDesk" draggable={false}/></button></div><div className="sidebar-tools"><button className="icon-btn collapse-btn" title={collapsed?"展开侧边栏":"折叠侧边栏"} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<ChevronsRight size={15}/>:<Menu size={15}/>}</button><button className="new-research" onClick={()=>{setDraft("");selectChat(null)}}><Plus/><span>新建任务</span><kbd>Ctrl N</kbd></button></div><nav>{navGroups.map(group=><div className="nav-group" key={group.label}><small>{group.label}</small>{group.items.map(({id,label,icon:Icon})=>{
  const isBrowser=id==="browser";
  return <button key={id} className={isBrowser?(browserOpen?"active":""):(mainView.page===id?"active":"")} onClick={()=>{if(isBrowser){setBrowserOpen(v=>{if(!v)setDockCollapsed(false);return !v})}else{setPage(id)}}}><Icon/><span>{label}</span></button>
})}</div>)}</nav><div className="sidebar-bottom"><button className={page==="settings"?"active":""} onClick={()=>setPage("settings")}><Settings/><span>设置</span></button><div className="engine-mini"><span className="engine-dot"><i/></span><span><strong>本地引擎</strong><small>{providerReady(status,model)?`${providerLabel(model)} 已配置`:"等待模型 API Key"}</small></span></div><div className="profile"><span>{auth.user?auth.user.slice(0,2):"QD"}</span><span><strong>{auth.user||"本地工作区"}</strong><small>{auth.user?"已登录 · 点击右侧退出":status.market_rows?`${status.market_rows.toLocaleString()} 行数据`:"无市场数据"}</small></span>{auth.user?<button className="profile-logout" title="退出登录" onClick={()=>void handleLogout()}><LogOut size={13}/></button>:null}</div></div></aside><main className="main"><header className="topbar" data-tauri-drag-region><div className="page-title" data-tauri-drag-region><h2>{title.title}</h2><span>/</span><p>{title.subtitle}</p></div><div className="top-actions"><button className="command-trigger" onClick={()=>setPalette(true)}><Search/><span>搜索或运行命令</span><kbd>Ctrl K</kbd></button><div className="view-add-wrap"><button className={`icon-btn view-add-btn${addViewOpen?" active":""}`} title="添加上方视图" onClick={()=>setAddViewOpen(v=>!v)}><Plus size={15}/></button>{addViewOpen&&<><div className="view-add-backdrop" onClick={()=>setAddViewOpen(false)}/><div className="view-add-drop"><div className="view-add-head">添加上方视图<small>与主视图并排，最多 3 个</small></div>{VIEW_MODULES.map(m=><button key={m.page} onClick={()=>addView(m,"top")}><m.icon size={14}/><span>{m.label}</span>{views.some(v=>v.page===m.page&&m.page!=="browser")&&<Check size={12} className="vad-check"/>}</button>)}</div></>}</div><button className="icon-btn" onClick={()=>setTheme(theme==="light"?"dark":"light")}>{theme==="light"?<Moon/>:<Sun/>}</button><WindowControls/></div></header><div className="content-scroll" style={browserOpen&&!dockCollapsed?{marginRight:dockW+BROWSER_INSET}:undefined}><div className="multi-views" ref={multiRef} style={{gridTemplateColumns:"1fr",gridTemplateRows:bottomViews.length?viewRows(hSplit):"1fr"}}>
      <div className="mv-row mv-row-top" ref={topRowRef} style={{gridTemplateColumns:topPanels.length===1?"1fr":viewCols(renderSplits)}}>
        {topPanels.map((v,i)=><Fragment key={v.key}>{i>0&&<div className="view-splitter vs-v" onPointerDown={vsplitTopDrag(i-1)} title="拖动调整面板宽度"/>}{paneNode(v)}</Fragment>)}
      </div>
      {bottomViews.length>0&&<div className="view-splitter vs-h" style={{gridColumn:"1 / -1",gridRow:2}} onPointerDown={startHRowDrag} title="拖动调整上下高度"/>}
      {bottomViews.length>0&&<div className="mv-row mv-row-bottom" ref={bottomRowRef} style={{gridColumn:"1 / -1",gridRow:3,gridTemplateColumns:bottomViews.length===1?"1fr":viewCols(renderSplitsB)}}>
        {bottomViews.map((v,i)=><Fragment key={v.key}>{i>0&&<div className="view-splitter vs-v" onPointerDown={vsplitBottomDrag(i-1)} title="拖动调整面板宽度"/>}{paneNode(v)}</Fragment>)}
      </div>}
    </div></div><ViewNewsStrip view={{page:mainView.page,title:mainView.title,stock:mainView.stock??null}} onOpenExternal={openUrlInBrowser} onMore={()=>{setPage("news")}} onGainsMore={()=>{setPage("rankings")}} onOpenStock={openStock} actions={addBottomActions}/></main>{palette&&<CommandPalette onClose={()=>setPalette(false)} navigate={setPage} launchAgent={launchAgent} onOpenStock={openStock}/>}{keyModal&&<KeyModal provider={keyModal} onClose={()=>setKeyModal(null)} onSaved={provider=>{markProviderConfigured(provider);void refresh()}} notify={notify} onOpenExternal={openUrlInBrowser}/>} {toast&&<div className={`app-toast ${toast.tone}`}>{toast.tone==="ok"?<CheckCircle2/>:<AlertTriangle/>}{toast.message}</div>}<BrowserDock open={browserOpen} dockW={dockW} collapsed={dockCollapsed} sidebarW={sidebarW} externalUrl={externalUrl} onExternalConsumed={()=>setExternalUrl(null)} onResize={setDockW} onToggleCollapse={()=>setDockCollapsed(v=>!v)} onClose={()=>setBrowserOpen(false)} notify={notify}/></div>;
}
