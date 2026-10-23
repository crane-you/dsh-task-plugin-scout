/**
 * Task Plugin Scout — Host half of the `@local/task-plugin-scout` bundle.
 *
 * Registers one model-facing tool, `plugin_scout`, that answers a single question: "which plugins
 * would make this task easier?". It reads the live plugin inventory (bundles, plugin rows) and the
 * configured market indexes through their owning services, ranks every candidate against a
 * one-line task description, and returns each candidate's exact next step (enable, install, or
 * nothing). It also contributes a short system-prompt section so an agent remembers to ask.
 *
 * The plugin is intentionally dependency-free: it imports nothing, registers everything through
 * `ctx.effect`, and reads the inventory through services it declares in `inject` (or resolves
 * optionally, for the market).
 *
 * @module @local/task-plugin-scout
 */

/** Model-facing tool name. */
const TOOL_NAME = 'plugin_scout';
/** Prompt section name; unique within its layer. */
const SECTION_NAME = 'plugin-scout:discovery';
/** Prompt placement: after plan/team policy, before the per-tool sections. */
const SECTION_ORDER = 700;
/** Recommendation count defaults and bounds. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 12;
/** Market reads: two indexes at most, read concurrently so one slow index cannot delay the other. */
const MARKET_INDEX_LIMIT = 2;
const MARKET_PAGE_LIMIT = 60;
const MARKET_TIMEOUT_MS = 10000;
/** Candidate text is truncated to keep the tool result small. */
const TEXT_LIMIT = 200;

/** Default prompt hint; a deployment may replace it through the row's `hintText`. */
const DEFAULT_HINT = [
  '## Finding helper plugins for a task',
  '',
  [
    '`plugin_scout` ranks the plugins of this profile — already active, installed but disabled, and',
    'installable from the configured market indexes — by how well they fit a task. Call it with a',
    'one-line task summary (in the user\'s language) before starting non-trivial work, then read each',
    'candidate\'s `nextStep`. Enabling or installing a plugin changes the user\'s profile and needs',
    'their approval: do it only when a candidate clearly serves the request, and say what you changed.',
    'Skip it for trivial or purely conversational turns.',
  ].join(' '),
].join('\n');

/** Ordering preference among equally relevant candidates: actionable first. */
const STATE_RANK = { disabled: 0, available: 1, active: 2 };

/** Latin words too generic to carry a match. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'without', 'from', 'into', 'onto', 'over', 'under', 'this', 'that',
  'these', 'those', 'you', 'your', 'yours', 'our', 'ours', 'their', 'them', 'they', 'its', 'his',
  'her', 'him', 'she', 'was', 'were', 'are', 'is', 'be', 'been', 'being', 'have', 'has', 'had',
  'does', 'did', 'done', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  'not', 'but', 'all', 'any', 'some', 'each', 'every', 'both', 'more', 'most', 'less', 'least',
  'than', 'then', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'what', 'why', 'how',
  'about', 'above', 'after', 'again', 'against', 'before', 'below', 'between', 'during', 'through',
  'use', 'used', 'using', 'make', 'made', 'makes', 'get', 'gets', 'got', 'need', 'needs', 'want',
  'please', 'help', 'task', 'tasks', 'thing', 'things', 'stuff', 'way', 'ways', 'also', 'just',
  'like', 'such', 'only', 'own', 'same', 'other', 'another', 'here', 'there', 'now', 'new', 'old',
  'add', 'adds', 'added', 'let', 'lets', 'run', 'runs', 'running', 'file', 'files', 'code',
]);

/** Runs of CJK (Han, compatibility ideographs, kana) characters. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;

/**
 * Capability concepts: a task phrase in either language and the plugin vocabulary that serves it.
 * `forms` are matched as lower-cased substrings, so English entries may be prefixes.
 * The table is what lets a Chinese task find an English-described plugin and vice versa.
 */
const CONCEPTS = [
  { id: 'voice', forms: ['语音', '录音', '口述', '听写', '说话', '麦克风', '字幕', 'voice', 'speech', 'audio', 'microphone', 'transcri', 'dictat', 'asr', 'whisper'] },
  { id: 'speech-out', forms: ['朗读', '播报', '语音合成', '读出来', 'text to speech', 'tts', 'narrat'] },
  { id: 'translation', forms: ['翻译', '译文', '中英', '双语', '本地化', 'translate', 'translat', 'localiz', 'i18n'] },
  { id: 'reasoning', forms: ['思维链', '推理过程', '思考过程', 'chain of thought', 'reasoning', 'cot'] },
  { id: 'mcp', forms: ['mcp', '外部工具', '第三方工具', '连接器', '接入服务', 'connector'] },
  { id: 'browser', forms: ['浏览器', '网页操作', '打开网页', '点击页面', '电脑操作', 'browser', 'playwright', 'computer use', 'screenshot click'] },
  { id: 'web', forms: ['联网', '上网', '搜索', '查资料', '最新消息', '抓取', '爬取', '网址', 'web', 'search', 'fetch', 'url', 'crawl', 'scrape'] },
  { id: 'plan', forms: ['计划', '方案', '规划', '评审方案', 'plan mode', 'planning', 'blueprint'] },
  { id: 'goal', forms: ['目标', '长期任务', '持续推进', 'goal', 'objective', 'milestone'] },
  { id: 'schedule', forms: ['定时', '提醒', '每天', '每周', '周期', '轮询', '日程', 'cron', 'remind', 'schedul', 'timer', 'recurring'] },
  { id: 'parallel', forms: ['并行', '批量', '并发', '多代理', '多个子任务', '拆分子任务', 'parallel', 'subagent', 'sub-agent', 'workflow', 'fan out', 'orchestrat', 'delegate'] },
  { id: 'background', forms: ['后台', '长时间运行', '耗时', '长任务', 'background', 'long running', 'job'] },
  { id: 'skill', forms: ['技能', '最佳实践', '操作规程', 'skill', 'playbook'] },
  { id: 'office', forms: ['表格', '文档', '演示', '幻灯片', '报告', '排版', '表单', 'spreadsheet', 'word', 'excel', 'powerpoint', 'docx', 'xlsx', 'pptx', 'slide', 'csv', 'document', 'report'] },
  { id: 'pdf', forms: ['pdf', '扫描件', '扫描', 'ocr', '图片文字', '识别图片'] },
  { id: 'image', forms: ['图片', '图像', '截图', '照片', '看图', '画图', '绘图', '海报', 'image', 'photo', 'screenshot', 'png', 'jpg', 'diagram'] },
  { id: 'code', forms: ['代码', '重构', '实现功能', '编写程序', '调试', '编程', '脚本', 'code', 'refactor', 'implement', 'debug', 'script', 'program'] },
  { id: 'git', forms: ['版本控制', '提交', '分支', '合并', '仓库', 'git', 'commit', 'branch', 'merge', 'repositor'] },
  { id: 'lsp', forms: ['类型检查', '跳转定义', '代码补全', '静态分析', '引用查找', 'lsp', 'language server', 'call hierarchy'] },
  { id: 'data', forms: ['数据分析', '统计', '图表', '可视化', '透视', '指标', '报表', 'data', 'analytic', 'chart', 'dashboard', 'metric', 'visualiz'] },
  { id: 'history', forms: ['历史会话', '之前的对话', '检索会话', '会话记录', 'session search', 'past conversation'] },
  { id: 'terminal', forms: ['终端', '命令行', '交互式', 'terminal', 'shell', 'pty', 'command line'] },
  { id: 'notify', forms: ['通知', '推送', '邮件', '回调', '飞书', '钉钉', 'notif', 'webhook', 'email', 'slack', 'telegram', 'alert'] },
  { id: 'telemetry', forms: ['监控', '追踪', '日志', '指标上报', 'telemetry', 'otel', 'observab', 'tracing'] },
  { id: 'security', forms: ['安全', '漏洞', '审计', '渗透', 'security', 'vulnerab', 'audit', 'secret'] },
  { id: 'test', forms: ['测试', '单测', '用例', '回归', 'test', 'unit test', 'vitest', 'jest', 'pytest', 'assert'] },
  { id: 'team', forms: ['团队', '协作', '多角色', '队友', 'teammate', 'team', 'collaborat'] },
  { id: 'storage', forms: ['存储', '数据库', '持久化', '缓存', 'storage', 'database', 'sqlite', 'persist', 'cache'] },
  { id: 'preset', forms: ['预设', '人格', '角色设定', 'preset', 'persona', 'profile'] },
  { id: 'model', forms: ['模型', '接入模型', '密钥', 'api key', 'provider', 'llm', 'token 用量'] },
  { id: 'account', forms: ['账号', '登录', '余额', 'account', 'sign in', 'balance', 'credential'] },
  { id: 'session', forms: ['会话', '上下文', '压缩', '记忆', 'session', 'context', 'compact', 'memory'] },
  { id: 'feedback', forms: ['反馈', '点赞', '评价', 'feedback', 'rating'] },
  { id: 'desktop', forms: ['桌面', '客户端', '窗口', 'desktop', 'window', 'gui'] },
];

/**
 * Compile one concept form into a matcher. An ASCII form must begin at a word boundary, so `script`
 * cannot match inside `transcription` and `word` cannot match inside `password`; a form that is
 * deliberately a prefix (`transcri`, `schedul`) still matches from that boundary. CJK forms carry no
 * boundaries and are matched as plain substrings.
 */
function compileForm(form) {
  if (!/^[\x20-\x7e]+$/.test(form)) return { text: form, pattern: null };
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { text: form, pattern: new RegExp(`(?:^|[^a-z0-9])${escaped}`, 'i') };
}

/** The concept table with every form compiled once. */
const COMPILED_CONCEPTS = CONCEPTS.map((concept) => ({
  id: concept.id,
  forms: concept.forms.map(compileForm),
}));

/** Whether one compiled form appears in already lower-cased text. */
function formMatches(haystack, form) {
  return form.pattern ? form.pattern.test(haystack) : haystack.includes(form.text);
}

/* ------------------------------------------------------------------ helpers */

/** Pick a readable string out of a possibly localized value. */
function localized(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['zh', 'en']) {
      const text = value[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    for (const text of Object.values(value)) {
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return '';
}

/** Collapse whitespace and bound the length of text that reaches the model. */
function shorten(text, limit = TEXT_LIMIT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Clamp a configured integer. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** A short, safe error description for the coverage note. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return shorten(message, 120);
}

/** Reject when `promise` has not settled within `ms`; the losing branch stays observed. */
function raceTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Split text into comparable tokens: Latin words plus CJK runs and their bigrams. */
function tokensOf(text) {
  const out = new Set();
  const lower = String(text ?? '').toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9+#._/-]*/g) ?? []) {
    for (const part of word.split(/[._+#/-]+/)) {
      if (part.length >= 2 && !STOPWORDS.has(part)) out.add(part);
    }
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length <= 4) out.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) out.add(run.slice(index, index + 2));
  }
  return out;
}

/** The concepts whose surface forms appear in the task text. */
function conceptsFor(taskText) {
  const lower = String(taskText ?? '').toLowerCase();
  return COMPILED_CONCEPTS.filter((concept) => concept.forms.some((form) => formMatches(lower, form)));
}

/**
 * Score one candidate against a task: concept hits dominate, literal token overlap refines.
 * @returns {{ score: number, matched: string[] }} relevance and the concepts that matched.
 */
function scoreCandidate(candidate, taskTokens, concepts) {
  const name = candidate.name.toLowerCase();
  const title = candidate.title.toLowerCase();
  const description = candidate.description.toLowerCase();
  const keywords = (candidate.keywords ?? []).join(' ').toLowerCase();
  const haystack = `${name} ${title} ${description} ${keywords}`;

  const matched = [];
  let score = 0;
  for (const concept of concepts) {
    if (concept.forms.some((form) => formMatches(haystack, form))) {
      score += 6;
      matched.push(concept.id);
    }
  }
  for (const token of taskTokens) {
    if (token.length < 2) continue;
    if (name.includes(token)) score += 3;
    else if (title.includes(token)) score += 2;
    else if (description.includes(token) || keywords.includes(token)) score += 1;
  }
  return { score: Math.min(score, 48), matched };
}

/* ------------------------------------------------------- inventory adapters */

/** Candidate states mapped onto the next step the agent should take. */
function bundleCandidate(bundle) {
  const name = String(bundle.name ?? '');
  const title = localized(bundle.meta?.title) || name;
  const description = localized(bundle.meta?.description) || shorten(bundle.description, TEXT_LIMIT);
  const installed = bundle.installed === true;
  const enabled = bundle.enabled === true;
  const spec = bundle.installTarget?.spec;
  const readOnly = typeof bundle.readOnlyReason === 'string' ? bundle.readOnlyReason : '';

  let state = 'available';
  let nextStep = '';
  if (enabled) {
    state = 'active';
    nextStep = 'none — the bundle is already active';
  } else if (installed) {
    state = 'disabled';
    nextStep = `plugin_manager { action: "set_bundle", target: "${name}", enabled: true }`;
  } else if (spec) {
    state = 'available';
    nextStep = `plugin_manager { action: "install_bundle", target: "${spec}" }`;
  } else {
    state = 'disabled';
    nextStep = `plugin_manager { action: "set_bundle", target: "${name}", enabled: true }`;
  }
  if (readOnly && !enabled) nextStep += ` (currently not changeable here: ${readOnly})`;
  if (bundle.error?.diagnostic) nextStep += ` (reported problem: ${shorten(bundle.error.diagnostic, 80)})`;

  return {
    kind: 'bundle',
    name,
    title,
    description,
    keywords: [localized(bundle.meta?.title), bundle.source].filter(Boolean),
    state,
    nextStep,
    rows: (bundle.rows ?? []).map((row) => String(row.moduleName ?? '')),
  };
}

/** One runtime plugin row. A row is reported active when the entry is enabled or already running. */
function rowCandidate(plugin) {
  const name = String(plugin.moduleName ?? '');
  const target = typeof plugin.patchId === 'string' && plugin.patchId ? plugin.patchId : String(plugin.entryId ?? '');
  const running = plugin.fiberPhase === 'active';
  const live = running || plugin.enabled === true;
  let nextStep = running
    ? 'none — the row is already running'
    : live
      ? 'none — the row is already active'
      : `plugin_manager { action: "set_plugin", target: "${target}", enabled: true }`;
  if (!live && !(typeof plugin.patchId === 'string' && plugin.patchId)) {
    nextStep = `enable the row "${name}" through the bundle that declares it (no profile patch target)`;
  }
  return {
    kind: 'plugin',
    name,
    title: localized(plugin.meta?.title) || name,
    description: localized(plugin.meta?.description),
    keywords: [target],
    state: live ? 'active' : 'disabled',
    nextStep,
    rows: [],
  };
}

/** One market listing. */
function marketCandidate(entry) {
  const name = String(entry.name ?? '');
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const chosen = versions.find((version) => version.version === entry.defaultVersion) ?? versions[0];
  const spec = chosen?.install?.spec ?? name;
  const status = entry.installation?.status;
  const state = status === 'installed' || status === 'provided' ? 'active' : 'available';
  let nextStep = state === 'active'
    ? 'none — already present in this profile'
    : `plugin_manager { action: "install_bundle", target: "${spec}" }`;
  if (chosen?.compatibility && chosen.compatibility.compatible === false) {
    nextStep += ` (requires DSH ${chosen.compatibility.requirements?.dsh ?? '?'}, runtime is ${chosen.compatibility.runtimeVersion})`;
  }
  return {
    kind: 'market',
    name,
    title: localized(entry.title) || name,
    description: localized(entry.description),
    keywords: Array.isArray(entry.metadata?.keywords) ? entry.metadata.keywords.map(String) : [],
    state,
    nextStep,
    rows: [],
  };
}

/* ------------------------------------------------------------- collection */

/** Read the profile's bundles and plugin rows; a failing reader degrades to an empty list. */
async function readInventory(ctx, notes) {
  const manager = ctx.get('pluginManager');
  if (!manager) {
    notes.push('plugin-manager is not mounted in this profile');
    return { bundles: [], rows: [] };
  }
  let bundles = [];
  let rows = [];
  try {
    bundles = await manager.listBundles();
  } catch (error) {
    notes.push(`bundle inventory unavailable: ${describeError(error)}`);
  }
  try {
    rows = await manager.listPlugins();
  } catch (error) {
    notes.push(`plugin rows unavailable: ${describeError(error)}`);
  }
  return {
    bundles: Array.isArray(bundles) ? bundles : [],
    rows: Array.isArray(rows) ? rows : [],
  };
}

/**
 * Read one configured index. A cold read may download a multi-megabyte document, so the first wait is
 * generous; a successful document is reused from the service's cache for its own TTL.
 * @returns the entries found and a one-line note for the coverage summary.
 */
async function readOneIndex(market, url, task) {
  try {
    let page = await raceTimeout(
      market.search(url, { text: task, sort: { kind: 'relevance' }, offset: 0, limit: 25 }),
      MARKET_TIMEOUT_MS,
    );
    if (!page || !Array.isArray(page.entries) || page.entries.length === 0) {
      page = await raceTimeout(
        market.search(url, { sort: { kind: 'index' }, offset: 0, limit: MARKET_PAGE_LIMIT }),
        MARKET_TIMEOUT_MS,
      );
    }
    const found = page?.entries ?? [];
    return { entries: found, note: `${url}: ${found.length} of ${page?.total ?? found.length}` };
  } catch (error) {
    return { entries: [], note: `${url}: ${describeError(error)}` };
  }
}

/** Read configured market indexes; missing service, no index, or a failed read is not an error. */
async function readMarket(ctx, task, useMarket, notes) {
  if (!useMarket) return [];
  const market = ctx.get('pluginMarket');
  if (!market) {
    notes.push('market: not mounted in this profile');
    return [];
  }
  let indexes = [];
  try {
    indexes = market.listIndexes();
  } catch (error) {
    notes.push(`market indexes unavailable: ${describeError(error)}`);
    return [];
  }
  if (!Array.isArray(indexes) || indexes.length === 0) {
    notes.push('market: no index configured');
    return [];
  }
  const reads = await Promise.all(
    indexes.slice(0, MARKET_INDEX_LIMIT).map((index) => readOneIndex(market, String(index.url ?? ''), task)),
  );
  const entries = [];
  for (const read of reads) {
    entries.push(...read.entries);
    notes.push(read.note);
  }
  return entries;
}

/* -------------------------------------------------------------- rendering */

/** One recommendation line for the model. */
function renderCandidate(candidate, index) {
  const lines = [
    `${index + 1}. ${candidate.title} [${candidate.state}, score ${candidate.score}] — ${candidate.kind} \`${candidate.name}\``,
  ];
  if (candidate.description) lines.push(`   ${candidate.description}`);
  if (candidate.matched.length > 0) lines.push(`   matched: ${candidate.matched.join(', ')}`);
  lines.push(`   next: ${candidate.nextStep}`);
  return lines.join('\n');
}

/** Build the model-facing text of one scout run. */
function renderReport(value) {
  const lines = [`Plugin Scout · task: ${value.task}`, `Coverage: ${value.coverage}`, ''];
  if (value.recommendations.length === 0) {
    lines.push('No plugin in this profile clearly matches the task — continue with the capabilities already available.');
  } else {
    for (const [index, candidate] of value.recommendations.entries()) {
      lines.push(renderCandidate(candidate, index));
    }
    lines.push('');
    lines.push('Enabling or installing changes the user\'s profile and asks for their approval; do it only when the candidate clearly serves the task, and report what you changed.');
    if (value.recommendations.some((candidate) => candidate.kind === 'plugin' && candidate.state === 'disabled')) {
      lines.push('Row-level candidates describe the profile patch: an agent preset can already mount the same row, so confirm the capability is really missing before enabling it.');
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ tool */

/** The complete `plugin_scout` tool definition. */
function createTool(ctx, options) {
  return {
    name: TOOL_NAME,
    description: [
      'Find the plugins that make a task easier. Ranks this profile\'s plugins — already active, installed but disabled, and installable from the configured market indexes — against a one-line task description, and returns the best candidates with the exact next step for each (enable, install, or nothing).',
      'Call it before starting non-trivial work, with the task summarized in the user\'s language; in a non-English task also give a short English keyword line, because plugin metadata is mostly English. Enabling or installing a plugin changes the user\'s environment and needs their approval, so recommend rather than assume.',
    ].join(' '),
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'What the user asked for, in one or two lines; keep the user\'s own words and add English capability keywords when the task is not in English.',
      },
      limit: {
        type: 'integer',
        description: `How many candidates to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      },
      useMarket: {
        type: 'boolean',
        description: 'Whether to include the configured plugin market indexes (default true); set false for a local-only, offline answer.',
      },
      includeActive: {
        type: 'boolean',
        description: 'Whether plugins that are already active may be listed (default true); set false to see only actions that change something.',
      },
    },
    output: {
      // The canonical value is raw JSON Schema (unlike `parameters`, which uses the tool DSL):
      // object-level `required` arrays, no boolean markers on the property nodes.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'coverage', 'scanned', 'recommendations'],
        properties: {
          task: { type: 'string' },
          coverage: { type: 'string' },
          scanned: { type: 'integer' },
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'title', 'kind', 'state', 'description', 'score', 'matched', 'nextStep'],
              properties: {
                name: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string', enum: ['bundle', 'plugin', 'market'] },
                state: { type: 'string', enum: ['active', 'disabled', 'available'] },
                description: { type: 'string' },
                score: { type: 'integer' },
                matched: { type: 'array', items: { type: 'string' } },
                nextStep: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Scout plugins for: ${shorten(args?.task, 60)}`,
      kind: 'search',
      rawInput: args,
    }),
    async execute(args, exec) {
      const task = String(args?.task ?? '').trim();
      if (!task) throw new Error(`${TOOL_NAME} requires a non-empty task description`);

      const limit = clampInt(args?.limit, 1, MAX_LIMIT, options.limit);
      const useMarket = args?.useMarket === undefined ? options.useMarket : args.useMarket !== false;
      const includeActive = args?.includeActive === undefined ? true : args.includeActive !== false;

      const notes = [];
      const { bundles, rows } = await readInventory(ctx, notes);
      const marketEntries = await readMarket(ctx, task, useMarket, notes);
      if (exec?.signal?.aborted) throw new Error(`${TOOL_NAME} was cancelled`);

      const concepts = conceptsFor(task);
      const taskTokens = tokensOf(task);

      const bundleCandidates = bundles.map(bundleCandidate).filter((candidate) => candidate.name);
      const rowCandidates = rows.map(rowCandidate).filter((candidate) => candidate.name);
      const marketCandidates = marketEntries.map(marketCandidate).filter((candidate) => candidate.name);

      const scored = [];
      const coveredByBundle = new Set();
      for (const candidate of bundleCandidates) {
        const { score, matched } = scoreCandidate(candidate, taskTokens, concepts);
        if (score <= 0) continue;
        scored.push({ ...candidate, score, matched });
        for (const row of candidate.rows) coveredByBundle.add(row);
      }
      for (const candidate of rowCandidates) {
        if (coveredByBundle.has(candidate.name)) continue;
        const { score, matched } = scoreCandidate(candidate, taskTokens, concepts);
        if (score <= 0) continue;
        scored.push({ ...candidate, score, matched });
      }
      for (const candidate of marketCandidates) {
        const { score, matched } = scoreCandidate(candidate, taskTokens, concepts);
        if (score <= 0) continue;
        scored.push({ ...candidate, score, matched });
      }

      const kept = includeActive ? scored : scored.filter((candidate) => candidate.state !== 'active');
      kept.sort((a, b) => (
        b.score - a.score
        || STATE_RANK[a.state] - STATE_RANK[b.state]
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      ));

      const recommendations = kept.slice(0, limit).map((candidate) => ({
        name: shorten(candidate.name, 120),
        title: shorten(candidate.title, 120),
        kind: candidate.kind,
        state: candidate.state,
        description: shorten(candidate.description),
        score: candidate.score,
        matched: candidate.matched.slice(0, 4),
        nextStep: shorten(candidate.nextStep, 300),
      }));

      const scanned = bundleCandidates.length + rowCandidates.length + marketCandidates.length;
      const actionable = recommendations.filter((candidate) => candidate.state !== 'active').length;
      const coverageNote = actionable > 0
        ? `${actionable} of the listed candidates need an action to take effect`
        : 'no listed candidate needs an action';
      const coverage = [
        coverageNote,
        `${bundleCandidates.length} bundles`,
        `${rowCandidates.length} plugin rows`,
        `${marketCandidates.length} market entries`,
        ...notes,
      ].join(' · ');

      return {
        task: shorten(task, 300),
        coverage,
        scanned,
        recommendations,
      };
    },
  };
}

/* ------------------------------------------------------------------ apply */

/** Normalize the row's configuration; every field is optional. */
function normalizeOptions(config) {
  const raw = config && typeof config === 'object' ? config : {};
  return {
    promptHint: raw.promptHint !== false,
    useMarket: raw.useMarket !== false,
    limit: clampInt(raw.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
    hintText: typeof raw.hintText === 'string' && raw.hintText.trim() ? raw.hintText.trim() : DEFAULT_HINT,
  };
}

/** Bundle entry point. */
export function apply(ctx, config) {
  const options = normalizeOptions(config);

  ctx.effect(() => ctx.tools.register(createTool(ctx, options)));

  if (options.promptHint) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: options.hintText,
      interpolate: false,
    }));
  }
}

export const name = 'task-plugin-scout';
export const inject = ['tools', 'systemPrompt'];