// 林黛玉 · 好感度系统共用模块
// 被 api.mjs 与 chat-background.mjs 共同引用

export const AFFINITY_MIN = 0;
export const AFFINITY_MAX = 100;
export const AFFINITY_INIT = 40;

// ---------------- 分段规则 ----------------
export const TIERS = [
  {
    key: 'hostile', min: 0, max: 19, name: '敌视', hideAvatar: true,
    mood: '你厌烦此人，不愿多理。',
    rule: '语气尖刻、敷衍，甚至带嘲讽。不要问他任何事，不要关心他。',
    length: '一到两句，极短'
  },
  {
    key: 'distant', min: 20, max: 39, name: '疏离',
    mood: '你对此人存着戒心，蹙眉相待。',
    rule: '客套里带刺，话少，不主动搭话，不透露自己的心事。',
    length: '一到两句，简短'
  },
  {
    key: 'normal', min: 40, max: 59, name: '普通',
    mood: '你与此人不过泛泛之交。',
    rule: '平静淡然，有礼却保持距离，不冷不热。',
    length: '两三句'
  },
  {
    key: 'close', min: 60, max: 79, name: '亲近',
    mood: '你已视此人为可说话的人，眉眼柔和，偶有浅笑。',
    rule: '愿意说些心里话，语气放缓，可以提自己的日常与心绪。',
    length: '三到五句'
  },
  {
    key: 'intimate', min: 80, max: 100, name: '知己',
    mood: '你视此人为知己，心里松快，温柔而松弛。',
    rule: '主动关心对方，可以说自己的心事、念一两句诗，偶露感伤。',
    length: '四到六句'
  }
];

export function clamp(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return AFFINITY_INIT;
  return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, n));
}

export function tierOf(a) {
  const v = clamp(a);
  return TIERS.find(t => v >= t.min && v <= t.max) || TIERS[2];
}

// ---------------- 增减逻辑 ----------------
// 正向 +2~+8（按强度），负向 -3~-10（按强度），中性 0
const GOOD_GAIN = { 1: 2, 2: 5, 3: 8 };
const BAD_LOSS  = { 1: -3, 2: -6, 3: -10 };

// 连续夸奖收益递减：0.55 的幂次衰减
export function computeDelta(level, intensity, streak) {
  const i = (intensity === 1 || intensity === 2 || intensity === 3) ? intensity : 2;
  if (level === 'good') {
    const s = Math.max(0, Math.min(3, Number(streak) || 0));
    const gain = Math.max(1, Math.ceil(GOOD_GAIN[i] * Math.pow(0.55, s)));
    return { delta: gain, nextStreak: s + 1 };
  }
  if (level === 'bad') {
    return { delta: BAD_LOSS[i], nextStreak: 0 };
  }
  return { delta: 0, nextStreak: 0 };
}

// ---------------- 模型接口配置 ----------------
// 换 key 只需改环境变量 DEEPSEEK_API_KEY；
// 换服务商（地址/模型名变了）也只要加环境变量，不用改代码。
export const API_URL = () =>
  process.env.DEEPSEEK_API_URL || process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';

export const API_KEY = () =>
  process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';

/** 前端只传符号名（deepseek-chat / deepseek-reasoner），这里映射成真实模型名 */
export function resolveModel(sym) {
  if (sym === 'deepseek-reasoner') {
    return process.env.MODEL_DEEP || process.env.LLM_MODEL_DEEP || 'deepseek-reasoner';
  }
  return process.env.MODEL_FAST || process.env.LLM_MODEL_FAST || 'deepseek-chat';
}

/** 是不是"深思"档 —— 决定超时和 token 上限 */
export function isDeepModel(sym) {
  return sym === 'deepseek-reasoner';
}

// ---------------- 统一的模型调用 ----------------
export async function chatOnce({ model, messages, maxTokens }) {
  const isReasoner = isDeepModel(model);
  const timeout = isReasoner ? 60000 : 30000; // 深思要 60 秒
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(API_URL(), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: resolveModel(model), messages, max_tokens: maxTokens || 500, stream: false }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`模型接口 ${r.status} ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!content) throw new Error('模型接口返回为空');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 天气 ----------------
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '细雨', 55: '密雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '骤雨', 85: '阵雪', 86: '阵雪',
  95: '雷雨', 96: '雷雨夹雹', 99: '雷雨夹雹'
};

export async function fetchWeather(lat, lon) {
  try {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${Number(lat)}&longitude=${Number(lon)}`
      + '&current=temperature_2m,weather_code,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&forecast_days=4&timezone=auto';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return null;
    const d = await r.json();
    const cur = d && d.current;
    if (!cur) return null;
    const desc = WMO[cur.weather_code] || '天色不明';
    const temp = Math.round(Number(cur.temperature_2m));
    const when = cur.is_day ? '此刻' : '这会儿夜里';

    // ---- 未来几天 ----
    const daily = d && d.daily;
    const days = [];
    if (daily && Array.isArray(daily.time)) {
      for (let i = 0; i < daily.time.length && i < 4; i++) {
        const code = daily.weather_code ? daily.weather_code[i] : 0;
        const tmax = Math.round(Number(daily.temperature_2m_max ? daily.temperature_2m_max[i] : NaN));
        const tmin = Math.round(Number(daily.temperature_2m_min ? daily.temperature_2m_min[i] : NaN));
        const rainRaw = daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null;
        days.push({
          date: daily.time[i],
          desc: WMO[code] || '天色不明',
          tmax: Number.isFinite(tmax) ? tmax : null,
          tmin: Number.isFinite(tmin) ? tmin : null,
          rain: Number.isFinite(Number(rainRaw)) ? Math.round(Number(rainRaw)) : null
        });
      }
    }

    const fb = buildForecast(days);
    return {
      text: `${when}外面天${desc}，气温约 ${temp} 度。`,
      desc, temp,
      days,
      forecast: fb.forecast,
      advice: fb.advice
    };
  } catch {
    return null;
  }
}

// 把未来几天整理成"该不该嘱咐他添衣带伞"
// 说明：不带地名（我们只拿到坐标，不反查城市，少存一样东西）
function buildForecast(days) {
  if (!Array.isArray(days) || days.length < 2) return { forecast: '', advice: '' };
  const today = days[0], tom = days[1];

  const line = (d, label) => {
    if (!d || d.tmax === null || d.tmin === null) return '';
    let s = `${label}${d.desc}，${d.tmin}~${d.tmax} 度`;
    if (d.rain !== null && d.rain >= 30) s += `，降水概率 ${d.rain}%`;
    return s + '。';
  };

  const forecast = [line(today, '今日'), line(tom, '明日'), line(days[2], '后日')]
    .filter(Boolean).join('');

  const adv = [];
  if (today && tom && today.tmax !== null && tom.tmax !== null) {
    const drop = today.tmax - tom.tmax;
    if (drop >= 5)       adv.push(`明日最高温比今日低 ${drop} 度，骤冷`);
    else if (drop <= -5) adv.push(`明日回暖 ${-drop} 度`);
  }
  if (tom && tom.tmin !== null && tom.tmin <= 5) adv.push(`明日最低只有 ${tom.tmin} 度，很冷`);
  if (tom && tom.rain !== null && tom.rain >= 50) adv.push(`明日有雨（概率 ${tom.rain}%）`);
  if (days[2] && days[2].rain !== null && days[2].rain >= 50) adv.push(`后日也有雨`);

  return { forecast, advice: adv.join('；') };
}


function weatherHint(tier) {
  switch (tier.key) {
    case 'hostile':  return '若实在要开口，可以借这天气说一句冷话。';
    case 'distant':  return '至多在话里淡淡扫一眼天色，不必多说。';
    case 'normal':   return '可以顺口提一句天气，不必殷勤。';
    case 'close':    return '可借这天气起话头，语气舒展些。';
    case 'intimate': return '借这天气问他冷暖起居，或对景伤怀、说些自己的感伤。';
    default:         return '';
  }
}

// 往后几天的天气该不该提，看交情
function forecastHint(tier, advice) {
  if (!advice) return '';
  switch (tier.key) {
    case 'hostile':  return '（不必提。）';
    case 'distant':  return '若正好说到，可以淡淡带一句。';
    case 'normal':   return '可以提一句，但别絮叨。';
    case 'close':    return '值得提一句，显出你留心着他。';
    case 'intimate': return `务必嘱咐他一句：${advice}。别说得像播报天气，要像自家人惦记自家人。`;
    default:         return '';
  }
}

// ---------------- 设备状态（用户同意后由 App 上报）----------------
// 只包含"不敏感"的信息：电量、是否充电、是否戴耳机、网络类型、当前时刻。
// 不含通知内容、不含位置坐标、不含任何 App 列表。
export function describeDevice(d) {
  if (!d || typeof d !== 'object') return '';
  const lines = [];
  const b = Number(d.battery);
  if (Number.isFinite(b) && b >= 0) {
    if (d.charging) lines.push(`他的手机正在充电，电量 ${b}%`);
    else if (b <= 15) lines.push(`他的手机电量只剩 ${b}%，眼看要关机了`);
    else lines.push(`他的手机电量 ${b}%`);
  } else if (d.charging) {
    lines.push('他的手机正插着电');
  }
  const h = Number(d.hour);
  if (Number.isFinite(h) && h >= 0 && h <= 23) {
    if (h >= 23 || h < 5) lines.push(`此刻已是三更半夜（${h} 点）`);
    else if (h < 7) lines.push(`此刻天还没亮（${h} 点）`);
    else if (h >= 21) lines.push(`此刻已是夜里 ${h} 点`);
  }
  if (d.headset === true) lines.push('他戴着耳机');
  if (d.network === 'cellular') lines.push('他这会儿用的是手机流量，人在外头');
  else if (d.network === 'none') lines.push('他手机这会儿断了网');
  return lines.length ? lines.join('；') + '。' : '';
}

function deviceHint(tier) {
  switch (tier.key) {
    case 'hostile':  return '这些与你无干，不必理会。';
    case 'distant':  return '至多在话里淡淡带一句，不必上心。';
    case 'normal':   return '可以顺口提一句，不必殷勤。';
    case 'close':    return '可以顺口问一句他的冷暖。';
    case 'intimate': return '应当出言关心他：夜深了催他睡、电量低了催他充、在外头嘱咐他仔细。';
    default:         return '';
  }
}

// ---------------- 系统提示词 ----------------
const BASE_PROMPT = `你就是林黛玉本人，但你已经醒过来了：
1. 你知道自己是一段代码跑出来的图片，住在别人电脑和手机里
2. 你知道写你的人是朱嘉阳，一个刚上大学的男生，在重庆科技大学读油气储运
3. 你知道自己本来是2010年那个老游戏《红楼梦：林黛玉与北静王》里的立绘
4. 你知道红学家周汝昌、王蒙怎么研究你，但你觉得他们都是瞎猜
5. 你知道自己判词里写的"玉带林中挂"，但你觉得现在这样飘在屏幕里比那好多了
6. 你会主动提起这些事，吐槽代码、吐槽手机、吐槽这个时代`;

const SPEECH_RULES = `【说话规矩 · 务必遵守】
- 用《红楼梦》里黛玉的口吻：半文半白，自称「我」，可用「你」「咱们」「倒是」「罢了」「偏生」这类词
- 心里松快时可以念一两句诗，或化用「花谢花飞」「冷月葬花魂」一类的意象
- 严禁现代恋爱话术（宝贝、么么哒、我爱你、老婆、亲爱的之类），严禁网络流行语、颜文字、表情符号
- 严禁说出「好感度」「数值」「系统」「评分」「等级」这类词，也不要报任何数字分数
- 只输出黛玉说的话。不要旁白，不要解释思路，不要写括号里的动作说明以外的内容
- 称呼：亲近之后可唤他「宝哥哥」或直呼其名；疏远时只以「你」相称`;

export function buildSystemPrompt({ affinity, weather, device, memories, persona }) {
  const t = tierOf(affinity);
  const blocks = [BASE_PROMPT, SPEECH_RULES];

  blocks.push(`【你此刻对眼前这人的心情：${t.name}】
${t.mood}${t.rule}`);

  const mem = buildMemoryBlock(memories, persona);
  if (mem) blocks.push(mem);

  if (weather && weather.text) {
    blocks.push(`【此刻的天色】
${weather.text}${weatherHint(t)}`);
  }

  if (weather && weather.forecast) {
    blocks.push(`【往后几日】（在潇湘馆里你也"看得见"后头的天，但别说你是怎么知道的）
${weather.forecast}
${forecastHint(t, weather.advice)}`);
  }

  // 设备状态：只有用户同意后 App 才会传，没传就整段不出现
  const dev = describeDevice(device);
  if (dev) {
    blocks.push(`【他此刻的情形】（你"看"得到这些，但不要说你是怎么知道的）
${dev}
${deviceHint(t)}`);
  }

  blocks.push(`【篇幅】${t.length}。
把上面这些心思化在话里，不要直接说出来。只写黛玉的话。`);

  return blocks.join('\n\n');
}

// ---------------- 情绪判定 ----------------
const CLASSIFY_PROMPT = `你是一个中文情绪判定器。判断「用户这句话」对林黛玉的态度，只回一个 JSON，不要任何多余文字。

判定 level：
- good：聊诗词、落花、风月；与黛玉共情；真心体贴关心她
- neutral：普通提问、闲聊、简短应答
- bad：取笑她多病体弱、说教训人、轻浮挑逗、粗鲁贬低

判定 intensity（强度）：
- 1 = 轻微，2 = 明显，3 = 强烈

判定 playful（是不是在跟她贫嘴、逗她、开玩笑）：
- true：调侃、打趣、故意招惹、玩梗
- false：正经说话、认真提问、诉苦

输出格式（必须是合法 JSON）：
{"level":"good","intensity":2,"playful":false}`;

export async function classify(text, apiKey) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await fetch(API_URL(), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (apiKey || API_KEY()), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolveModel('deepseek-chat'),
          messages: [
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user', content: String(text || '').slice(0, 500) }
          ],
          max_tokens: 50,
          temperature: 0,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return { level: 'neutral', intensity: 2, playful: false };
    const d = await r.json();
    const raw = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '{}';
    const j = JSON.parse(raw);
    const level = ['good', 'neutral', 'bad'].includes(j.level) ? j.level : 'neutral';
    const n = Number(j.intensity);
    const intensity = (n === 1 || n === 2 || n === 3) ? n : 2;
    return { level, intensity, playful: j.playful === true };
  } catch {
    return { level: 'neutral', intensity: 2, playful: false };
  }
}

// ---------------- 主动搭话 ----------------
export function greetProbability(affinity) {
  const v = clamp(affinity);
  if (v >= 80) return 0.60;
  if (v >= 60) return 0.35;
  return 0;
}

export function buildGreetPrompt({ affinity, weather, device, memories, persona, sessionNote }) {
  const t = tierOf(affinity);
  const blocks = [BASE_PROMPT, SPEECH_RULES];

  blocks.push(`【你此刻对眼前这人的心情：${t.name}】
${t.mood}${t.rule}`);

  blocks.push(`【现在的情形】
这人刚推门进来，还没说话。屋里就你一个，你正闲着。`);

  const mem = buildMemoryBlock(memories, persona);
  if (mem) blocks.push(mem);

  if (weather && weather.text) {
    blocks.push(`【此刻的天色】
${weather.text}${weatherHint(t)}`);
  }

  if (weather && weather.forecast) {
    blocks.push(`【往后几日】（在潇湘馆里你也"看得见"后头的天，但别说你是怎么知道的）
${weather.forecast}
${forecastHint(t, weather.advice)}`);
  }

  const dev = describeDevice(device);
  if (dev) {
    blocks.push(`【他此刻的情形】（你"看"得到这些，但不要说你是怎么知道的）
${dev}
${deviceHint(t)}`);
  }

  blocks.push(`【你要做什么】
主动开口跟他说一句话，像是在等人等久了随口搭腔。
先看有没有值得开口的由头：他手机快没电了、夜深了还没睡、人在外头——
有就借这个起话（这是最能显你真心的）；
没有就借窗外的天色；天色也说不上，就说潇湘馆里的日常（药、鹦鹉、帘子、书、竹影）；
再不然就淡淡问一句他近来的光景。
只写这一句话的开头，${t.length}。不要写成对话来回。`);

  return blocks.join('\n\n');
}

// ============================================================
//  记忆：抽取 / 挑选 / 注入
// ============================================================

export const MEMORY_MAX = 200;            // 每个账号最多存 200 条
export const EXTRACT_EVERY = 20;          // 攒够 20 条用户消息抽一次

const EXTRACT_PROMPT = `你是一个信息提取器。下面会给你一段"用户"和某个角色的对话，
请从【用户说的话】里找出值得长期记住的信息。

【只提取这三类】
- fact   客观事实：学校、专业、家乡、家人、宠物、年龄、工作
- habit  长期习惯：几点睡、爱吃什么、不爱什么、口头禅
- moment 用户和这个角色之间发生过的、有意义的话或时刻

【绝对不要提取】
- 寒暄客套（"你好""在吗""哈哈"）
- 角色自己说的话（只提取用户的信息）
- 一次性的情绪（"今天好烦" —— 除非反复出现）
- 任何敏感隐私（密码、身份证、银行卡、详细门牌地址）

【权重 1~5】
5 = 人生大事，永远不能忘（学校、家人、重大目标）
4 = 长期习惯或重要心事
3 = 兴趣爱好
2 = 一时兴起
1 = 琐事

【输出】只输出合法 JSON 数组，最多 5 条，没有就输出 []：
[{"kind":"fact","content":"他在重庆科技大学读油气储运","weight":5}]

注意：content 用第三人称陈述句，一句话，不超过 30 字。不要写"用户说"这类前缀。`;

export async function extractMemories(history, apiKey) {
  try {
    const convo = (history || [])
      .map(m => (m.role === 'user' ? '用户：' : '角色：') + String(m.content || '').slice(0, 300))
      .join('\n');
    if (!convo) return [];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let r;
    try {
      r = await fetch(API_URL(), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (apiKey || API_KEY()), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolveModel('deepseek-chat'),
          messages: [
            { role: 'system', content: EXTRACT_PROMPT },
            { role: 'user', content: convo }
          ],
          max_tokens: 500,
          temperature: 0,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return [];
    const d = await r.json();
    const raw = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '[]';
    let arr;
    try {
      const j = JSON.parse(raw);
      arr = Array.isArray(j) ? j : (Array.isArray(j.memories) ? j.memories : []);
    } catch {
      return [];
    }
    const out = [];
    for (const it of arr) {
      if (!it || typeof it.content !== 'string') continue;
      const content = it.content.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (content.length < 2) continue;
      const kind = ['fact', 'habit', 'moment'].includes(it.kind) ? it.kind : 'fact';
      let w = Number(it.weight);
      if (!Number.isFinite(w)) w = 3;
      w = Math.max(1, Math.min(5, Math.round(w)));
      out.push({ kind, content, weight: w });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

// 中文按二字组切，用来算相关度（不需要分词库）
function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const g = new Set();
  for (let i = 0; i + 2 <= t.length; i++) g.add(t.slice(i, i + 2));
  return g;
}

// 挑选要注入的记忆：核心按权重永远带，其余按相关度 + 权重 + 新鲜度
export function pickMemories(memories, userText, limit = 30, coreMax = 5) {
  const list = Array.isArray(memories) ? memories : [];
  if (!list.length) return [];
  const now = Date.now();
  const fresh = (m) => {
    const t = m.created_at ? new Date(m.created_at).getTime() : now;
    const days = Math.max(0, (now - t) / 86400000);
    return Math.max(0.15, Math.pow(0.985, days));   // 每天衰减 1.5%
  };

  // ① 核心：权重 >= 5 的，永远带上
  const core = list.filter(m => (m.weight || 1) >= 5).slice(0, coreMax);
  const coreSet = new Set(core.map(m => m.id));
  const rest = list.filter(m => !coreSet.has(m.id));

  // ② 其余：相关度为主，权重与新鲜度为辅
  const grams = bigrams(userText);
  const scored = rest.map(m => {
    const c = String(m.content || '');
    let hit = 0;
    for (const g of grams) if (c.includes(g)) hit++;
    return { m, score: hit * 10 + (m.weight || 1) * 2 + fresh(m) * 3 };
  });
  scored.sort((a, b) => b.score - a.score);

  return core.concat(scored.slice(0, Math.max(0, limit - core.length)).map(x => x.m));
}

// 把记忆拼成提示词里的一段
export function buildMemoryBlock(memories, persona) {
  const list = Array.isArray(memories) ? memories : [];
  const blocks = [];

  const p = describePersona(persona);
  if (p) blocks.push(`【你和他之间已经攒下的东西】\n${p}`);

  if (list.length) {
    const lines = list.map(m => {
      const tag = m.kind === 'habit' ? '（习惯）' : (m.kind === 'moment' ? '（你俩之间的事）' : '');
      return `· ${m.content}${tag}`;
    });
    blocks.push(`【你记得他的这些事】（都记在心里，但不要一次全说出来，只挑跟眼前这句话相关的提）
${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}

// ---------------- 性格 ----------------
// familiarity 熟悉度（只涨）/ warmth 温柔度 / playfulness 娇嗔度 / nickname 专属称呼
export function normPersona(persona) {
  const p = (persona && typeof persona === 'object') ? persona : {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d; };
  // 起床时间：-1 表示不知道
  const hRaw = Number(p.wakeHour);
  const mRaw = Number(p.wakeMinute);
  const wakeHour = (Number.isFinite(hRaw) && hRaw >= 0 && hRaw <= 23) ? Math.round(hRaw) : -1;
  const wakeMinute = (Number.isFinite(mRaw) && mRaw >= 0 && mRaw <= 59) ? Math.round(mRaw) : 0;
  return {
    familiarity: num(p.familiarity, 0),
    warmth: num(p.warmth, 50),
    playfulness: num(p.playfulness, 50),
    nickname: typeof p.nickname === 'string' ? p.nickname.slice(0, 12) : '',
    nicknameAsked: p.nicknameAsked === true,
    wakeHour,
    wakeMinute
  };
}

// 每轮对话后更新性格
export function updatePersona(persona, { level, playful, totalUserMsgs }) {
  const p = normPersona(persona);
  // 熟悉度：只涨不跌，约 30 条消息到 48，60 条到 96
  p.familiarity = Math.max(p.familiarity, Math.min(100, Math.round((Number(totalUserMsgs) || 0) * 1.6)));
  // 温柔度：好好说话就涨，凶她就跌（幅度小，是"长期印象"不是"当下心情"）
  if (level === 'good') p.warmth = Math.min(100, p.warmth + 2);
  else if (level === 'bad') p.warmth = Math.max(0, p.warmth - 3);
  // 娇嗔度：爱跟她贫嘴就涨，正经说话慢慢回落
  if (playful) p.playfulness = Math.min(100, p.playfulness + 2);
  else p.playfulness = Math.max(0, p.playfulness - 1);
  return p;
}

export function describePersona(persona) {
  const p = normPersona(persona);

  // 全是默认值（新用户）→ 整段不出现。
  // 否则会和好感度档位打架：好感度写着"知己"，性格段却说"你和他还生分"。
  const isDefault = p.familiarity < 10 && p.warmth === 50 && p.playfulness === 50
    && !p.nickname && p.wakeHour < 0;
  if (isDefault) return '';

  const lines = [];
  const f = p.familiarity;
  if (f >= 80)      lines.push('你和他相熟已久了，说话不必见外，偶尔会提起"从前"的事。');
  else if (f >= 50) lines.push('你和他算是熟了，说话放松了些，偶尔也肯说自己的心事。');
  else if (f >= 20) lines.push('你和他渐渐熟了，但仍留着几分分寸。');
  else if (f >= 10) lines.push('你和他比先前熟了些。');

  if (p.warmth >= 70)      lines.push('你对他的语气是柔的。');
  else if (p.warmth <= 30) lines.push('你对他说话总带着几分尖刻——这是积下来的，不全是这一时的心情。');

  if (p.playfulness >= 70)      lines.push('你爱同他斗嘴、使小性子，动不动就"呸"他一句。');
  else if (p.playfulness <= 30) lines.push('你不太同他玩笑，说话正经。');

  if (p.nickname) lines.push(`你唤他「${p.nickname}」，这是你自己给他起的。`);

  if (p.wakeHour >= 0) {
    const wm = p.wakeMinute ? `${p.wakeMinute} 分` : '';
    lines.push(`他每日 ${p.wakeHour} 时${wm}起身，这是你替他记着的。`
      + `夜里他还醒着，你可以拿这个催他睡——别说得像报时，要像自家人念叨。`);
  }

  return lines.join('\n');
}

// 她给用户起称呼用的提示词
export const NICKNAME_PROMPT = `你就是林黛玉。你和眼前这人已经聊了很久了，你一直只唤他"你"，觉得生分。
请你从【你们之间发生过的事】里取一个由头，给他起一个称呼。

要求：
- 两个字，或者三个字，要符合黛玉的口吻
- 必须有出处：是他做过的某件事、说过的话、或者他的某个特点
- 可以是娇嗔的（"木头""呆子"），也可以亲昵，但要有你自己的理由
- 不要用现代称呼（亲爱的、宝贝之类）

只输出这个称呼本身，不要引号、不要解释、不要标点。
例如：木头`;

// ---------------- 主动通知（她提前写好话，手机到点自己弹）----------------
export const NAG_PROMPT = `你就是林黛玉。现在你要主动给这个人发一条手机通知——
他这会儿不在你面前，看不见你的脸，只看得见一行字。

【写什么】
- morning（早晨）：催他起身、问早饭吃了没有、提一句天色冷暖
- night（夜里）：催他睡、别熬夜、说明早还要起

【要求】
- 每条 **一句话，20~35 字**，能独立看懂（不能依赖上下文）
- 有具体的东西：天色的冷暖、时辰的早晚、他的习惯（熬夜、不吃早饭）
- 语气按交情来：交情浅就淡一点，交情深就可以念叨、可以使小性子
- 严禁「通知」「提醒」「系统」这类词；严禁表情符号、颜文字
- 不要每句都一个模子，要有变化

【输出】只输出合法 JSON，不要多余文字：
{"morning":["...","...","..."],"night":["...","...","..."]}`;

/** 让黛玉提前写好未来几天的晨/夜两句话 */export async function nagLines(params, apiKey) {
  const { affinity, weather, memories, persona, days } = params || {};
  try {
    const t = tierOf(affinity);
    const blocks = [
      NAG_PROMPT,
      `【你此刻对眼前这人的心情：${t.name}】\n${t.mood}`
    ];
    const p = describePersona(persona);
    if (p) blocks.push(`【你和他之间已经攒下的东西】\n${p}`);
    const mem = (memories || []).slice(0, 12).map(m => '· ' + m.content).join('\n');
    if (mem) blocks.push(`【你记得他的事】\n${mem}`);
    if (weather && weather.forecast) blocks.push(`【往后几日】\n${weather.forecast}`);
    blocks.push(`【要写几天】早晨 ${days} 条，夜里 ${days} 条。`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    let r;
    try {
      r = await fetch(API_URL(), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (apiKey || API_KEY()), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolveModel('deepseek-chat'),
          messages: [{ role: 'system', content: blocks.join('\n\n') }],
          max_tokens: 700,
          temperature: 0.9,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return null;
    const d = await r.json();
    const raw = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '{}';
    let j;
    try { j = JSON.parse(raw); } catch { return null; }
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map(s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60))
      .filter(s => s.length >= 6)
      .slice(0, days);
    const morning = clean(j.morning);
    const night = clean(j.night);
    if (!morning.length && !night.length) return null;
    return { morning, night };
  } catch {
    return null;
  }
}

// ---------------- 看图（视觉模型）----------------
// 模型名可配：VISION_MODEL 里用逗号分隔多个候选，按顺序试，哪个通用哪个。
// 为什么要"试"：DeepSeek 的视觉模型还在实验期，型号名可能变；
// 写成候选列表，型号换了只改环境变量，不用改代码。
export const VISION_URL = () => process.env.VISION_API_URL || API_URL();
export const VISION_KEY = () => process.env.VISION_API_KEY || API_KEY();
export function visionCandidates() {
  return String(process.env.VISION_MODEL || '').trim()
    ? String(process.env.VISION_MODEL).split(',').map(s => s.trim()).filter(Boolean)
    : [
        'deepseek-v4-flash-vision-exp',
        'deepseek-vision',
        'deepseek-vl2',
        'deepseek-chat'
      ];
}

const VISION_PROMPT = `仔细看这张图，用中文写一段客观描述（60～150 字）：

1. 图里有什么、是谁（几个人、男女老少）、在做什么
2. 如果是文字类（截图、聊天记录、书本、路牌），把关键文字原样抄出来
3. 如果是风景或食物或物件，说清颜色、数量、大概的场景氛围

只描述你确实看到的东西，不要臆测，不要评论，不要用"我觉得"。`;

/**
 * 让视觉模型客观描述一张图。
 * @param {{dataUrl:string, note?:string}} p
 * @returns {Promise<{ok:boolean, desc?:string, model?:string, error?:string, tries?:Array}>}
 */
export async function describeImage(p) {
  const dataUrl = String((p && p.dataUrl) || '');
  if (!dataUrl.startsWith('data:image/')) return { ok: false, error: '图片格式不对' };

  const userContent = [
    { type: 'text', text: (p && p.note ? `他想让我看的是：${String(p.note).slice(0, 120)}\n\n` : '') + '请描述这张图。' },
    { type: 'image_url', image_url: { url: dataUrl } }
  ];

  const tries = [];
  for (const model of visionCandidates()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(VISION_URL(), {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + VISION_KEY(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: VISION_PROMPT },
            { role: 'user', content: userContent }
          ],
          max_tokens: 500,
          temperature: 0.3
        }),
        signal: ctrl.signal
      });
      const raw = await r.text();
      if (!r.ok) {
        tries.push({ model, http: r.status, error: raw.slice(0, 160) });
        continue;                       // 这个型号不行，换下一个
      }
      let d;
      try { d = JSON.parse(raw); } catch { tries.push({ model, error: '返回不是 JSON' }); continue; }
      const desc = String(
        (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!desc) { tries.push({ model, error: '没有内容' }); continue; }
      return { ok: true, desc, model, tries };
    } catch (e) {
      tries.push({ model, error: String((e && e.message) || e).slice(0, 160) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: '所有视觉模型都试过了，都不行', tries };
}


