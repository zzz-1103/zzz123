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

// ---------------- 统一的 DeepSeek 调用 ----------------
export async function chatOnce({ model, messages, maxTokens }) {
  const isReasoner = model === 'deepseek-reasoner';
  const timeout = isReasoner ? 60000 : 30000; // 深思要 60 秒
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.DEEPSEEK_API_KEY || ''),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens || 500, stream: false }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`DeepSeek ${r.status} ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!content) throw new Error('DeepSeek 返回为空');
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
      + '&current=temperature_2m,weather_code,is_day';
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
    return { text: `${when}外面天${desc}，气温约 ${temp} 度。`, desc, temp };
  } catch {
    return null;
  }
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

export function buildSystemPrompt({ affinity, weather }) {
  const t = tierOf(affinity);
  const blocks = [BASE_PROMPT, SPEECH_RULES];

  blocks.push(`【你此刻对眼前这人的心情：${t.name}】
${t.mood}${t.rule}`);

  if (weather && weather.text) {
    blocks.push(`【此刻的天色】
${weather.text}${weatherHint(t)}`);
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

输出格式（必须是合法 JSON）：
{"level":"good","intensity":2}`;

export async function classify(text, apiKey) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user', content: String(text || '').slice(0, 500) }
          ],
          max_tokens: 40,
          temperature: 0,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return { level: 'neutral', intensity: 2 };
    const d = await r.json();
    const raw = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '{}';
    const j = JSON.parse(raw);
    const level = ['good', 'neutral', 'bad'].includes(j.level) ? j.level : 'neutral';
    const n = Number(j.intensity);
    const intensity = (n === 1 || n === 2 || n === 3) ? n : 2;
    return { level, intensity };
  } catch {
    return { level: 'neutral', intensity: 2 };
  }
}

// ---------------- 主动搭话 ----------------
export function greetProbability(affinity) {
  const v = clamp(affinity);
  if (v >= 80) return 0.60;
  if (v >= 60) return 0.35;
  return 0;
}

export function buildGreetPrompt({ affinity, weather, sessionNote }) {
  const t = tierOf(affinity);
  const blocks = [BASE_PROMPT, SPEECH_RULES];

  blocks.push(`【你此刻对眼前这人的心情：${t.name}】
${t.mood}${t.rule}`);

  blocks.push(`【现在的情形】
这人刚推门进来，还没说话。屋里就你一个，你正闲着。`);

  if (weather && weather.text) {
    blocks.push(`【此刻的天色】
${weather.text}${weatherHint(t)}`);
  }

  blocks.push(`【你要做什么】
主动开口跟他说一句话，像是在等人等久了随口搭腔。
优先借窗外的天色起话；天色的由头用不上，就说潇湘馆里的日常（药、鹦鹉、帘子、书、竹影）；
再不然就淡淡问一句他近来的光景。
只写这一句话的开头，${t.length}。不要写成对话来回。`);

  return blocks.join('\n\n');
}
