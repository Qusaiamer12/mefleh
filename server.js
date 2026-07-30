/* ==========================================================
   نظام كشوفات المستودع — باك إند Node/Express
   ----------------------------------------------------------
   وظيفته شغلتين:
   1) بروكسي آمن للذكاء الاصطناعي: مفاتيح Groq/Qwen/Kimi بتعيش
      بالسيرفر (متغيرات بيئة برندر) مش بمتصفحات المستخدمين
   2) تقديم الواجهة من public/ (خيار النشر كخدمة وحدة)

   التشغيل محليًا:   node server.js   (بيقرا .env تلقائيًا لو موجود)
   ========================================================== */
const fs = require('fs');
const path = require('path');

/* تحميل .env يدويًا — بدون حزم وبدون Node 20.6 (متغيرات البيئة
   الحقيقية، مثل رندر، بتكسب دايمًا على قيم الملف)            */
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env))
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* ما في .env — عادي */ }

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_TOKEN = process.env.AI_PROXY_TOKEN || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

/* المزوّدون المعتمدون — المفاتيح من البيئة فقط، لا شي بالكود */
const PROVIDERS = {
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions',
          key: process.env.AI_NVIDIA_KEY || '' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions',
          key: process.env.AI_GROQ_KEY || '' },
  qwen: { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
          key: process.env.AI_QWEN_KEY || '' },
  kimi: { url: 'https://api.moonshot.ai/v1/chat/completions',
          key: process.env.AI_KIMI_KEY || '' },
};

/* ---------- CORS + ترويسات أمان ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const o = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', o || '*');
  else if (o && ORIGINS.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-ai-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- حد معدل بسيط: 40 طلب / 5 دقايق لكل IP ----------
   مع تنظيف دوري حتى ما تكبر الذاكرة بلا سقف              */
const RATE_WIN = 5 * 60 * 1000, RATE_MAX = 40;
const buckets = new Map();
function rateOk(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.t > RATE_WIN) { b = { t: now, n: 0 }; buckets.set(ip, b); }
  b.n++;
  return b.n <= RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.t > RATE_WIN * 4) buckets.delete(ip);
  if (buckets.size > 5000) buckets.clear();
}, 10 * 60 * 1000).unref();

app.use(express.json({ limit: '20mb' }));   /* صور السندات base64 بتكون كبيرة */

/* ردود JSON نظيفة لأخطاء الجسم (بدل صفحات HTML الافتراضية) */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large')
    return res.status(413).json({ error: { message: 'الطلب أكبر من المسموح — صغّر الصورة' } });
  if (err && (err.status === 400 || err.type === 'entity.parse.failed'))
    return res.status(400).json({ error: { message: 'جسم الطلب مش JSON صالح' } });
  next(err);
});

/* ---------- صحة وحالة ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* أي مزوّد متوفر بالسيرفر — بدون كشف ولا حرف من المفاتيح */
app.get('/api/ai/status', (req, res) => {
  const configured = {};
  for (const [k, p] of Object.entries(PROVIDERS)) configured[k] = !!p.key;
  res.json({ configured, tokenRequired: !!PROXY_TOKEN });
});

/* ---------- البروكسي: الواجهة بتبعت body صيغة OpenAI جاهزة ---------- */
app.post('/api/ai/:provider', async (req, res) => {
  try {
    const pv = PROVIDERS[req.params.provider];
    if (!pv) return res.status(404).json({ error: { message: 'مزوّد غير معروف' } });
    if (!pv.key) return res.status(501).json({ error: { message: 'المزوّد غير مُعدّ بالسيرفر' } });
    if (PROXY_TOKEN && req.headers['x-ai-token'] !== PROXY_TOKEN)
      return res.status(401).json({ error: { message: 'توكن البروكسي غير صحيح' } });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || req.socket.remoteAddress || '';
    if (!rateOk(ip))
      return res.status(429).json({ error: { message: 'طلبات كثيرة — جرّب بعد شوية' } });

    const body = req.body || {};
    const payload = {
      model: String(body.model || '').slice(0, 120),
      messages: body.messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0,
      max_tokens: Math.min(parseInt(body.max_tokens, 10) || 4000, 8000),
    };
    if (body.response_format && body.response_format.type === 'json_object')
      payload.response_format = { type: 'json_object' };
    if (!payload.model || !Array.isArray(payload.messages))
      return res.status(400).json({ error: { message: 'طلب ناقص (model/messages)' } });

    /* تحليل الصور بيطوّل — نعطي المزوّد 110 ثواني قبل ما نستسلم */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 110000);
    const up = await fetch(pv.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + pv.key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const text = await up.text();
    res.status(up.status).type('application/json').send(text);
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: { message: aborted
        ? 'المزوّد تأخر كثير — جرّب مرة ثانية'
        : 'خطأ داخلي بالسيرفر' } });
  }
});

/* ---------- تقديم الواجهة (خيار: خدمة وحدة تستضيف الكل) ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

const srv = app.listen(PORT, () =>
  console.log(`✅ mefleh-warehouse API listens on :${PORT}`));
srv.setTimeout(120000);
