// Agent 对话页 —— 桌面端 App.tsx AgentPage 的移动端迁移：
// 流式渲染（叙述/工具操作组/结论）、思考等级、权限模式、角色、后台运行与排队、
// 历史会话（与引擎 SQLite 双向镜像）。API Key 仍在桌面端配置，移动端只读状态。
import { memo, useCallback, useEffect, useRef, useState, Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle, Activity, Bot, Check, ChevronDown, ChevronRight, ChevronsUpDown, Clock3, Gauge, History, Plus,
  ShieldCheck, Sparkles, Square, Unlock, X, ArrowUp,
} from "lucide-react";
import {
  listAgentApprovals, approveAgentApproval, rejectAgentApproval, getAgentUsage, getEngineUrl,
  getAutoModel, getProviderModels, providerForModel, providerLabel, providerReady,
  type AccessMode, type AgentApproval, type AgentEvent, type AgentUsageResult, type ReasoningLevel,
} from "../lib/backend";
import {
  assistantText, chatId, deleteThread, getActiveChatId, loadThread, loadThreads,
  setActiveChatId, syncThreadsFromServer, titleFromPrompt, upsertThread,
  type ChatThread,
} from "../lib/chats";
import {
  cancelAgentRun, forgetRun, getQueue, getRunInfo, hasUnreadRun, isThreadRunning,
  onRunsChange, removeQueuedRun, setActiveThread, startAgentRun,
} from "../lib/agent-runs";
import { useApp } from "../App";

const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
const REASONING_LABEL: Record<ReasoningLevel, string> = { off: "关闭", low: "快速", medium: "平衡", high: "深度" };
// Agent 图表 markdown 相对路径(/charts/...)按引擎地址补全，ReactMarkdown urlTransform 用
const resolveEngineAssetUrl = (url: string): string =>
  url.startsWith("/charts/") ? `${getEngineUrl()}${url}` : url;
// 模型清单：动态目录（引擎 /providers/models）为主，静态清单兜底；label 用 ChatGPT 式短名
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "deepseek-v4-flash", label: "V4 Flash" },
  { id: "deepseek-v4-pro", label: "V4 Pro" },
  { id: "qwen3.7-flash", label: "3.7 Flash" },
  { id: "qwen3.7-plus", label: "3.7 Plus" },
  { id: "qwen3.8-max", label: "3.8 Max" },
];
type ModelEntry = { id: string; label: string; meta?: string; free?: boolean };
const STATIC_ENTRIES: ModelEntry[] = MODEL_OPTIONS.map(m => ({ id: m.id, label: m.label }));
const MODEL_PROVIDERS = ["openai", "deepseek", "qwen", "openrouter"] as const;
type ModelProvider = (typeof MODEL_PROVIDERS)[number];
const PROVIDER_NAME: Record<ModelProvider, string> = { openai: "OpenAI", deepseek: "DeepSeek", qwen: "Qwen", openrouter: "OpenRouter" };
const PROBE_MODEL: Record<ModelProvider, string> = { openai: "gpt-5.4-mini", deepseek: "deepseek-v4-flash", qwen: "qwen3.7-flash", openrouter: "auto" };
// 动态模型 id 转短名：去掉厂商前缀与 :free 后缀
const shortModelLabel = (id: string) => (id.split("/").pop() || id).replace(/:free$/i, "");
const modelEntryLabel = (id: string, entries: ModelEntry[]) => entries.find(e => e.id === id)?.label
  ?? (id === "auto" ? "Auto" : shortModelLabel(id));
const APPROVAL_LABELS: Record<string, string> = {
  apply_portfolio_proposal: "写入组合提案", place_paper_order: "模拟下单", cancel_paper_order: "撤单",
  update_paper_risk_limits: "更新模拟盘风控限额", create_scheduled_task: "创建定时任务",
  delete_scheduled_task: "删除定时任务", manage_price_alerts: "预警管理",
  manage_conditional_orders: "条件单", manage_risk_guard: "账户熔断",
};
const ACCESS_MODES: { id: AccessMode; label: string; hint: string }[] = [
  { id: "ask", label: "只读提案", hint: "只读取数据和生成建议，不写入本地状态" },
  { id: "approve", label: "待批准提案", hint: "生成待审阅建议；切换完全访问后才可执行" },
  { id: "full", label: "完全访问", hint: "可执行受控的本地写操作，仍不能连接券商" },
];
type RoleId = "general" | "adviser" | "risk" | "trader" | "news" | "researcher";
const ROLES: { id: RoleId; label: string; hint: string; system: string; prompts: string[] }[] = [
  { id: "general", label: "通用", hint: "不做预设，按任务自行发挥", system: "", prompts: ["检查我的组合风险", "扫描真实数据中的 Alpha 机会", "运行点时策略回测"] },
  { id: "adviser", label: "理财师", hint: "资产配置 · 长期规划", system: "你是资深理财师。围绕长期资产配置与财务目标展开：先了解资金体量、期限与风险承受度，再给配置比例建议、再平衡纪律与费用注意事项。优先调用持仓与行情数据；数据缺失时明确告知，不编造收益率。", prompts: ["根据我的持仓和风险偏好给一版资产配置建议", "评估我的组合是否偏科，给出再平衡方案"] },
  { id: "risk", label: "风险评估师", hint: "VaR · 回撤 · 压力测试", system: "你是量化风控专家。任务聚焦风险而非收益：计算组合 VaR/CVaR、最大回撤、波动率与集中度，做情景压力测试并给对冲建议。必须基于真实持仓与价格历史调用风险工具；数据不足时说明缺哪些字段；结论标注置信区间与假设。", prompts: ["对我的真实组合做完整风险分析（VaR/回撤/压力测试）", "哪些持仓在拖累组合？做风险归因"] },
  { id: "trader", label: "波段交易员", hint: "动量 · 买卖点 · 仓位", system: "你是波段交易员。任务寻找中短期机会：分析动量、支撑压力位、量价关系与止损止盈位，给出分批建仓/减仓计划，明确仓位上限与风险回报比。优先查看实时行情与模拟持仓；只讨论模拟交易，不暗示真实下单。", prompts: ["今天有哪些适合波段交易的强势标的？", "用我的模拟持仓做个止盈止损计划"] },
  { id: "news", label: "新闻解读员", hint: "资讯解读 · 事件影响", system: "你是财经新闻解读员。任务把资讯翻译成投资含义：梳理事件对板块/个股的传导链条、市场情绪与预期差，区分事实与观点。优先拉取新闻快讯并关联行情；没有相关新闻时直说，不编造消息。", prompts: ["解读今天的财经快讯对我持仓的影响", "最近有什么能影响 A 股的重要事件？"] },
  { id: "researcher", label: "数据研究员", hint: "回测 · 统计 · 数据质量", system: "你是严谨的数据研究员。任务以可复现方式验证假设：先核对数据质量（字段/窗口/缺失），再跑回测或统计检验，报告显著性与稳健性并注明局限。优先用已导入的本地数据与算法工具；数据不足时不补数、不插值。", prompts: ["验证我的一个交易信号是否统计显著", "检查导入数据的质量并给出清洗建议"] },
];
const loadRole = (): RoleId => {
  const r = localStorage.getItem("quant-role") || "general";
  return ROLES.some(x => x.id === r) ? (r as RoleId) : "general";
};
function loadAccessMode(): AccessMode {
  const stored = localStorage.getItem("quant-access-mode");
  if (stored === "ask" || stored === "approve" || stored === "full") return stored;
  return localStorage.getItem("quant-default-supervised") === "0" ? "approve" : "ask";
}

export default function AgentPage() {
  const { status, notify, model, setModel } = useApp();
  const [prompt, setPrompt] = useState("");
  const [thread, setThread] = useState<ChatThread | null>(() => loadThread(getActiveChatId()));
  const [history, setHistory] = useState<ChatThread[]>(() => loadThreads());
  const [activeChatId, setActiveChatIdState] = useState<string | null>(() => getActiveChatId());
  const [working, setWorking] = useState(false);
  const [queueItems, setQueueItems] = useState<string[]>(() => getQueue(getActiveChatId()).map(item => item.displayText));
  const [accessMode, setAccessMode] = useState<AccessMode>(loadAccessMode);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(() => (localStorage.getItem("quant-reasoning") as ReasoningLevel) || "medium");
  const [role, setRole] = useState<RoleId>(loadRole);
  const [popOpen, setPopOpen] = useState<"none" | "access" | "role" | "tuning">("none");
  const [advExpand, setAdvExpand] = useState<"none" | "model" | "reasoning">("none");
  // 动态模型目录：按提供商缓存；null 表示该提供商目录获取失败（用静态清单兜底）
  const [dynModels, setDynModels] = useState<Partial<Record<ModelProvider, ModelEntry[] | null>>>({});
  const [autoModel, setAutoModel] = useState<string | null>(null);
  useEffect(() => {
    getAutoModel().then(r => setAutoModel(r.model)).catch(() => undefined);
    void Promise.all(MODEL_PROVIDERS.filter(p => providerReady(status, PROBE_MODEL[p])).map(async p => {
      try {
        const { models } = await getProviderModels(p);
        return [p, models.slice(0, 40).map(m => ({
          id: m.id, label: shortModelLabel(m.id),
          meta: m.free ? "免费" : m.context ? `${Math.round(m.context / 1024)}K` : undefined, free: !!m.free,
        } satisfies ModelEntry))] as const;
      } catch { return [p, null] as const; }
    })).then(rows => setDynModels(Object.fromEntries(rows)));
  }, [status]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const commit = (next: ChatThread) => {
    setThread(next);
    upsertThread(next);
    setHistory(loadThreads());
    setActiveChatId(next.id);
    setActiveChatIdState(next.id);
  };

  useEffect(() => {
    void syncThreadsFromServer().then(() => setHistory(loadThreads()));
    return onRunsChange(() => {
      setWorking(!!activeChatId && isThreadRunning(activeChatId));
      const queued = getQueue(activeChatId).map(item => item.displayText);
      setQueueItems(prev => prev.length === queued.length && prev.every((t, i) => t === queued[i]) ? prev : queued);
      setThread(current => {
        if (!current || current.id !== activeChatId) return current;
        const fresh = activeChatId ? loadThread(activeChatId) : null;
        return fresh && fresh.updatedAt !== current.updatedAt ? fresh : current;
      });
      setHistory(prev => {
        const next = loadThreads();
        return prev.length === next.length && prev.every((t, i) => t.id === next[i].id && t.updatedAt === next[i].updatedAt) ? prev : next;
      });
    });
  }, [activeChatId]);
  useEffect(() => { setActiveThread(activeChatId); return () => setActiveThread(null); }, [activeChatId]);
  // 运行计时
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt || !working) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, working]);
  // 滚动跟随：用户上滑即暂停，回到底部恢复（与桌面端同策略）
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const onScroll = () => { pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [thread?.id]);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (!working || pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [thread, working]);

  const submit = (value?: string) => {
    const text = (value ?? prompt).trim();
    if (!text) return;
    if (!providerReady(status, model)) {
      notify(`请先在桌面端「设置」配置 ${providerLabel(model)} API Key`, "error");
      return;
    }
    const current = thread ?? { id: chatId(), title: titleFromPrompt(text), turns: [], model, updatedAt: Date.now() };
    setPrompt("");
    const modeContext = accessMode === "ask"
      ? "权限：只读提案。只可读取数据、运行研究与生成建议，禁止任何本地写操作和真实下单。"
      : accessMode === "approve"
        ? "权限：待批准提案。生成可审阅建议，禁止任何本地写操作和真实下单；用户切换完全访问后才可执行。"
        : "权限：完全访问。可以执行受控本地写操作；禁止连接券商或真实下单。";
    const verbosity = localStorage.getItem("quant-verbosity") || "balanced";
    const personality = localStorage.getItem("quant-personality") || "professional";
    const customInstructions = localStorage.getItem("quant-custom-instructions")?.trim();
    const responseContext = `回答详略：${verbosity === "concise" ? "简洁，只保留结论、依据和风险" : verbosity === "detailed" ? "详细，解释方法、假设、数据限制和风险" : "平衡，先给结论再给必要依据"}。表达风格：${personality === "teaching" ? "教学式，解释专业术语" : personality === "direct" ? "直接务实" : "专业审慎"}。`;
    const roleInfo = ROLES.find(r => r.id === role) || ROLES[0];
    const roleContext = roleInfo.id !== "general" ? `当前角色：${roleInfo.label}。${roleInfo.system}\n` : "";
    // 与桌面端一致：onStart（实际启动，排队任务等到此刻）才写入正文两轮
    startAgentRun({
      threadId: current.id,
      prompt: `${modeContext}\n${responseContext}\n${roleContext}${customInstructions ? `\n用户的长期指令：${customInstructions}` : ""}\n\n用户目标：${text}`,
      displayText: text,
      model,
      provider: providerForModel(model),
      reasoning,
      accessMode,
      role,
      onStart: () => {
        const base = loadThread(current.id) || current;
        const now = Date.now();
        const userTurn = { id: chatId(), role: "user" as const, text, events: [], at: now };
        const assistantTurn = { id: chatId(), role: "assistant" as const, text: "", events: [], at: now };
        commit({ ...base, turns: [...base.turns, userTurn, assistantTurn], updatedAt: now });
        setStartedAt(now); setElapsed(0); pinnedRef.current = true;
      },
      onError: () => notify("Agent 任务失败", "error"),
      onFinished: () => {
        setHistory(loadThreads());
        if (hasUnreadRun(current.id)) notify(`Agent 任务完成：${current.title || "对话"}`);
      },
    });
  };

  const openThread = (id: string) => {
    setActiveChatId(id); setActiveChatIdState(id); setActiveThread(id);
    setThread(loadThread(id)); setHistory(loadThreads()); setHistoryOpen(false);
  };
  const newThread = () => {
    setThread(null); setActiveChatId(null); setActiveChatIdState(null); setActiveThread(null); setHistoryOpen(false);
  };
  const removeThread = (id: string) => {
    deleteThread(id); forgetRun(id); setHistory(loadThreads());
    if (thread?.id === id) { setThread(null); setActiveChatId(null); setActiveChatIdState(null); setActiveThread(null); }
  };
  const cancel = () => { if (activeChatId) cancelAgentRun(activeChatId); };

  const turns = thread?.turns || [];
  const hasChat = turns.length > 0;
  const activeThreadBusy = working;

  return <div className="page agent-page">
    <header className="page-head with-actions">
      <div className="ph-title">
        <h1>投资 Agent</h1>
        <p>{providerReady(status, model) ? `已连接 ${providerLabel(model)}` : `等待配置 ${providerLabel(model)} Key（桌面端）`}</p>
      </div>
      <div className="ph-actions">
        <button className="icon-btn" onClick={() => setHistoryOpen(true)}><History size={19} /></button>
        <button className="icon-btn" onClick={newThread}><Plus size={20} /></button>
      </div>
    </header>

    <div className="agent-feed" ref={feedRef}>
      <ApprovalCenter notify={notify} />
      <AgentUsageCard />
      {!hasChat ? <div className="agent-welcome">
        <span className="welcome-icon"><Sparkles size={22} /></span>
        <h2>今天要完成什么投资任务？</h2>
        <p>Agent 会先说明下一步，再调用真实数据、回测、组合和风险工具。没有数据时会明确告诉你缺少什么，不生成替代数字。</p>
        <div className="welcome-state">
          <span className={status.market_rows > 0 ? "ok" : "warn"}><b>{status.market_rows > 0 ? `${status.market_rows.toLocaleString()} 行市场数据` : "尚无市场数据"}</b></span>
          <span className={status.holding_count > 0 ? "ok" : "warn"}><b>{status.holding_count > 0 ? `${status.holding_count} 个持仓` : "尚无持仓"}</b></span>
        </div>
      </div>
        : <>
          {activeThreadBusy && <div className="elapsed-row"><Clock3 size={12} /><span>运行中 {Math.floor(elapsed / 60)}分 {elapsed % 60}秒</span></div>}
          <AgentFeed turns={turns} working={working} />
        </>}
      {queueItems.length > 0 && <div className="run-queue">
        <span className="rq-label"><Clock3 size={12} />排队中 {queueItems.length} 条</span>
        {queueItems.map((text, index) => (
          <span className="queued-pill" key={`${index}-${text.slice(0, 12)}`}>
            <em>{text.length > 46 ? `${text.slice(0, 46)}…` : text}</em>
            <i onClick={() => activeChatId && removeQueuedRun(activeChatId, index)}><X size={10} /></i>
          </span>
        ))}
      </div>}
      {hasChat && !working && <div className="suggest-chips">
        {(ROLES.find(r => r.id === role) || ROLES[0]).prompts.slice(0, 2).map(text => (
          <button key={text} onClick={() => submit(text)}><Sparkles size={11} />{text}</button>
        ))}
      </div>}
    </div>

    <div className="composer">
      {popOpen !== "none" && <div className="popover-backdrop" onClick={() => setPopOpen("none")} />}
      {popOpen === "role" && <div className="pop-sheet">
        <div className="pop-head"><strong>Agent 角色</strong><small>角色决定 Agent 优先获取哪些信息、以什么方式分析</small></div>
        {ROLES.map(r => (
          <button key={r.id} className={role === r.id ? "active" : ""} onClick={() => { setRole(r.id); localStorage.setItem("quant-role", r.id); setPopOpen("none"); }}>
            <span><strong>{r.label}</strong><small>{r.hint}</small></span>{role === r.id && <Check size={14} />}
          </button>
        ))}
      </div>}
      {popOpen === "access" && <div className="pop-sheet">
        {ACCESS_MODES.map(mode => (
          <button key={mode.id} className={`${accessMode === mode.id ? "active" : ""}${mode.id === "full" ? " access-full" : ""}`} onClick={() => { setAccessMode(mode.id); localStorage.setItem("quant-access-mode", mode.id); setPopOpen("none"); }}>
            <span><strong>{mode.label}</strong><small>{mode.hint}</small></span>{accessMode === mode.id && <Check size={14} />}
          </button>
        ))}
      </div>}
      {popOpen === "tuning" && <div className="pop-sheet adv-sheet">
        <button className="adv-title" onClick={() => setPopOpen("none")}>高级<ChevronRight size={15} /></button>
        <div className="adv-group">
          <div className="adv-row">
            <span className="adv-label">模型</span>
            <button className="adv-value" onClick={() => setAdvExpand(v => (v === "model" ? "none" : "model"))}>
              {modelEntryLabel(model, [...STATIC_ENTRIES, ...MODEL_PROVIDERS.flatMap(p => dynModels[p] || [])])}<ChevronsUpDown size={15} />
            </button>
          </div>
          {advExpand === "model" && <div className="adv-options">
            <button className={model === "auto" ? "active" : ""} onClick={() => {
              if (!status.openrouter_configured) { notify("Auto 模式需要先在桌面端配置 OpenRouter Key", "error"); return; }
              setModel("auto"); setAdvExpand("none");
            }}>
              <span><strong>Auto</strong><small>{autoModel ? `免费 · ${autoModel}` : "自动选用 OpenRouter 免费模型"}</small></span>
              {model === "auto" && <Check size={14} />}
            </button>
            {MODEL_PROVIDERS.map(p => {
              if (!providerReady(status, PROBE_MODEL[p])) return null;
              const entries = dynModels[p] ?? STATIC_ENTRIES.filter(m => providerForModel(m.id) === p);
              if (!entries.length) return null;
              return <Fragment key={p}>
                <div className="adv-group-label">{PROVIDER_NAME[p]}</div>
                {entries.map(e => (
                  <button key={e.id} className={`${e.id === model ? "active" : ""}${e.free ? " free" : ""}`}
                    onClick={() => { setModel(e.id); setAdvExpand("none"); }}>
                    <span><strong className={e.free ? "free-name" : ""}>{e.label}</strong>
                      <small>{PROVIDER_NAME[p]}{e.meta ? ` · ${e.meta}` : ""}</small></span>
                    {e.id === model && <Check size={14} />}
                  </button>
                ))}
              </Fragment>;
            })}
          </div>}
          <div className="adv-divider" />
          <div className="adv-row">
            <span className="adv-label">智能</span>
            <button className="adv-value" onClick={() => setAdvExpand(v => (v === "reasoning" ? "none" : "reasoning"))}>
              {REASONING_LABEL[reasoning]}<ChevronsUpDown size={15} />
            </button>
          </div>
          {advExpand === "reasoning" && <ReasoningSlider value={reasoning} onChange={next => {
            setReasoning(next);
            localStorage.setItem("quant-reasoning", next);
          }} />}
        </div>
      </div>}

      {!hasChat && <div className="quick-prompts">
        {(ROLES.find(r => r.id === role) || ROLES[0]).prompts.map(text => <button key={text} onClick={() => submit(text)}>{text}</button>)}
      </div>}
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder={hasChat ? "继续提问…" : "描述投资目标…"}
        rows={2}
      />
      <div className="composer-row">
        <button className={`chip ${role !== "general" ? "chip-set" : ""}`} onClick={() => setPopOpen(popOpen === "role" ? "none" : "role")}>
          <Bot size={12} />{ROLES.find(r => r.id === role)?.label || "通用"}<ChevronDown size={11} />
        </button>
        <button className={`chip ${accessMode === "full" ? "chip-full" : ""}`} onClick={() => setPopOpen(popOpen === "access" ? "none" : "access")}>
          {accessMode === "full" ? <Unlock size={12} /> : <ShieldCheck size={12} />}{ACCESS_MODES.find(m => m.id === accessMode)?.label}
        </button>
        <button className={`chip${reasoning !== "medium" ? " chip-set" : ""}`} onClick={() => { setAdvExpand("none"); setPopOpen(popOpen === "tuning" ? "none" : "tuning"); }}>
          <Gauge size={13} />{REASONING_LABEL[reasoning]}
        </button>
        <button className={`send-btn${working ? " stop" : ""}`} disabled={!working && !prompt.trim()}
          onClick={() => { if (working) cancel(); else submit(); }}>
          {working ? <Square size={14} /> : <ArrowUp size={16} />}
        </button>
      </div>
    </div>

    {historyOpen && <div className="sheet-mask" onClick={() => setHistoryOpen(false)}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head"><h2>对话历史</h2><button className="icon-btn" onClick={newThread}><Plus size={18} /></button></div>
        <div className="sheet-body">
          {history.length === 0 ? <p className="sheet-empty">还没有保存的对话</p>
            : history.map(item => {
              const run = getRunInfo(item.id);
              const running = run?.status === "running";
              const unread = run?.status === "done" && run.unread;
              return <div key={item.id} className={`history-row${thread?.id === item.id ? " active" : ""}`} onClick={() => openThread(item.id)}>
                <span><b>{item.title}</b><small>{new Date(item.updatedAt).toLocaleString()}</small></span>
                {running ? <i className="dot running" /> : unread ? <i className="dot unread" /> : null}
                <button className="row-del" onClick={e => { e.stopPropagation(); removeThread(item.id); }}><X size={13} /></button>
              </div>;
            })}
        </div>
      </div>
    </div>}
  </div>;
}

// ---------- 审批中心（与桌面端同源：pending 提案 → 批准真实执行 / 拒绝作废） ----------

function ApprovalCenter({ notify }: { notify: (message: string, tone?: "ok" | "error") => void }) {
  const [items, setItems] = useState<AgentApproval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems((await listAgentApprovals("pending")).approvals || []); } catch { /* 引擎未启动时静默 */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load]);
  const decide = async (id: string, approve: boolean) => {
    setBusyId(id);
    try {
      if (approve) {
        const result = await approveAgentApproval(id);
        notify(`已批准并执行：${result.label} · ${result.detail}`, "ok");
      } else {
        await rejectAgentApproval(id);
        notify("提案已拒绝", "ok");
      }
      await load();
    } catch (error) { notify(error instanceof Error ? error.message : "审批操作失败", "error"); }
    finally { setBusyId(null); }
  };
  if (items.length === 0) return null;
  return <section className="approval-center">
    <h3><ShieldCheck size={13} />审批中心 <span className="approval-count">{items.length}</span></h3>
    {items.map(item => {
      const args = typeof item.arguments === "string"
        ? (() => { try { return JSON.parse(item.arguments) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })()
        : (item.arguments || {}) as Record<string, unknown>;
      const summary = Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ");
      const impact = item.impact;
      return <div className="approval-item" key={item.id}>
        <b>{APPROVAL_LABELS[item.tool] || item.tool}</b>
        {impact?.warning && <p className={`approval-warning${impact.destructive ? " destructive" : ""}`}>{String(impact.warning)}</p>}
        {summary && <code>{summary}</code>}
        <div className="approval-actions">
          <button className="primary-btn" disabled={busyId === item.id} onClick={() => void decide(item.id, true)}>批准执行</button>
          <button className="secondary-btn" disabled={busyId === item.id} onClick={() => void decide(item.id, false)}>拒绝</button>
        </div>
      </div>;
    })}
  </section>;
}

// ---------- Agent 用量看板（G2：最近 14 天 runs / 工具调用 + 当日配额） ----------

function AgentUsageCard() {
  const [usage, setUsage] = useState<AgentUsageResult | null>(null);
  useEffect(() => {
    const load = async () => {
      try { setUsage(await getAgentUsage(14)); } catch { /* 引擎未启动时静默 */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, []);
  if (!usage) return null;
  const maxCalls = Math.max(1, ...usage.series.map(d => d.tool_calls));
  const today = usage.series[usage.series.length - 1];
  const quotaPct = usage.quota.daily_tool_calls > 0
    ? Math.min(100, Math.round(today.tool_calls / usage.quota.daily_tool_calls * 100)) : 0;
  return <section className="agent-usage-card">
    <h3><Activity size={13} />Agent 用量 <small>近 {usage.days} 天</small></h3>
    <div className="usage-totals">
      <span><b>{usage.total.runs}</b><small>运行</small></span>
      <span><b>{usage.total.tool_calls}</b><small>工具调用</small></span>
      <span><b>{today.runs}</b><small>今日运行</small></span>
    </div>
    <div className="usage-bars">
      {usage.series.map(d => <div key={d.day} className="usage-bar-col" title={`${d.day}：${d.tool_calls} 次调用 / ${d.runs} 次运行`}>
        <i style={{ height: `${Math.round(d.tool_calls / maxCalls * 100)}%` }} />
      </div>)}
    </div>
    <div className="usage-quota"><span>今日配额</span><div className="usage-quota-track"><i style={{ width: `${quotaPct}%` }} /></div><b>{today.tool_calls}/{usage.quota.daily_tool_calls}</b></div>
  </section>;
}

// ---------- 思考等级滑块（iOS ChatGPT 风格：胶囊轨道 + 分档圆点 + 蓝色填充 + 白色手柄） ----------

function ReasoningSlider({ value, onChange }: { value: ReasoningLevel; onChange: (level: ReasoningLevel) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const max = REASONING_LEVELS.length - 1;
  const index = Math.max(0, REASONING_LEVELS.indexOf(value));
  const frac = index / max;
  const pick = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(REASONING_LEVELS[Math.round(ratio * max)]);
  };
  return <div className="rs-wrap">
    <div className="rs-track" ref={trackRef}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pick(e.clientX); }}
      onPointerMove={e => { if (e.buttons > 0) pick(e.clientX); }}>
      <div className="rs-fill" style={{ width: `${frac * 100}%` }} />
      {REASONING_LEVELS.map((level, i) => (
        <i key={level} className={`rs-dot${i <= index ? " lit" : ""}`} style={{ left: `${(i / max) * 100}%` }} />
      ))}
      <div className="rs-knob" style={{ left: `${frac * 100}%` }} />
    </div>
  </div>;
}

// ---------- 消息渲染（与桌面端 AgentFeed 逻辑一致） ----------

function groupAssistantEvents(events: AgentEvent[]) {
  type Block = { kind: "text"; text: string; conclusion?: boolean } | { kind: "ops"; events: AgentEvent[] } | { kind: "error"; text: string } | { kind: "plan"; text: string } | { kind: "incomplete"; text: string } | { kind: "compacting"; text: string; done: boolean };
  const blocks: Block[] = [];
  let ops: AgentEvent[] = [];
  const flush = () => { if (ops.length) { blocks.push({ kind: "ops", events: ops }); ops = []; } };
  for (const event of events) {
    if (event.type === "tool_result" && event.name === "submit_plan") {
      flush();
      blocks.push({ kind: "plan", text: event.detail || "" });
      continue;
    }
    if (event.type === "tool_start" && event.name === "submit_plan") continue;
    if (event.type === "tool_start" || event.type === "tool_result") { ops.push(event); continue; }
    flush();
    if (event.type === "compacting") blocks.push({ kind: "compacting", text: event.text || "", done: event.status === "completed" });
    else if ((event.type === "narration" || event.type === "status") && event.text) blocks.push({ kind: "text", text: event.text });
    else if (event.type === "done" && event.text) blocks.push({ kind: "text", text: event.text, conclusion: true });
    else if (event.type === "error") blocks.push({ kind: "error", text: event.text || "出错了" });
    else if (event.type === "incomplete") blocks.push({ kind: "incomplete", text: event.text || "工具轮次已用尽，任务可能未完成。" });
  }
  flush();
  return blocks;
}

function uniqueTools(events: AgentEvent[]) {
  const map = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.type !== "tool_start" && event.type !== "tool_result") continue;
    const key = event.name || event.label || "tool";
    if (!map.has(key) || event.type === "tool_result") map.set(key, event);
  }
  return [...map.values()];
}

function OperationGroup({ events, live }: { events: AgentEvent[]; live: boolean }) {
  const tools = uniqueTools(events);
  const allDone = tools.length > 0 && tools.every(item => item.status === "completed" || item.type === "tool_result");
  const running = live && !allDone;
  const [open, setOpen] = useState(false);
  const current = tools.find(item => item.status !== "completed" && item.type !== "tool_result") || tools[tools.length - 1];
  const labels = tools.map(item => item.label || item.name || "操作").filter((label, index, list) => list.indexOf(label) === index);
  const summary = running ? `正在运行 ${current?.label || current?.name || "操作"}` : labels.join(" · ") || "操作";
  return <div className={`op-group ${allDone ? "done" : "live"}`}>
    <button className={`op-fold${running ? " running" : ""}`} onClick={() => setOpen(v => !v)}>
      <i /><span>{summary}</span><small>{tools.length}</small><ChevronDown size={12} className={open ? "" : "collapsed"} />
    </button>
    {open && <div className="op-chip-list">
      {tools.map((item, index) => {
        const active = live && item.status !== "completed" && item.type !== "tool_result";
        return <span className={`op-chip${active ? " running" : ""}`} key={`${item.name}-${index}`}>
          <em>{active ? "正在运行" : "已完成"}</em> {item.label || item.name}
        </span>;
      })}
    </div>}
  </div>;
}

const AgentFeed = memo(function AgentFeed({ turns, working }: { turns: import("../lib/chats").ChatTurn[]; working: boolean }) {
  return <>{turns.map((turn, index) => {
    if (turn.role === "user") return <div className="user-line" key={turn.id}><p>{turn.text}</p></div>;
    const isLast = index === turns.length - 1;
    const live = working && isLast;
    const blocks = groupAssistantEvents(turn.events);
    const waiting = live && !turn.events.some(e => e.type === "done" || e.type === "error" || e.type === "narration" || e.type === "tool_start");
    return <div className="assistant-block" key={turn.id}>
      {waiting && <p className="thinking-shimmer">正在思考</p>}
      {blocks.map((block, i) => block.kind === "compacting"
        ? <div className={`compact-divider${block.done ? " done" : ""}`} key={i}><span className="compact-line" /><span className="compact-label">{block.done ? "上下文已压缩" : block.text || "正在压缩上下文"}</span><span className="compact-line" /></div>
        : block.kind === "ops"
        ? <OperationGroup key={i} events={block.events} live={live && !turn.events.some(e => e.type === "done" || e.type === "error")} />
        : block.kind === "error" || block.kind === "incomplete"
          ? <div className={`inline-error${block.kind === "incomplete" ? " incomplete" : ""}`} key={i}><AlertTriangle size={13} /><span>{block.text}</span></div>
          : block.kind === "plan"
            ? <div className="plan-card" key={i}><strong>任务计划</strong><ol>{block.text.split("\n").filter(Boolean).map((step, si) => <li key={si}>{step.replace(/^\d+\.\s*/, "")}</li>)}</ol></div>
          : <div className={`md-body ${block.conclusion ? "final" : ""}`} key={i}><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={resolveEngineAssetUrl}>{block.text}</ReactMarkdown></div>)}
    </div>;
  })}</>;
});
