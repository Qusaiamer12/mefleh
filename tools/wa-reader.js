#!/usr/bin/env node
/* ==========================================================
   قارئ تصدير شات واتساب — يحوّل جروب الزبون لملف سندات جاهز
   ----------------------------------------------------------
   بيشغّل نفس قارئ النظام (parseLine/findItem/priceOf من
   public/index.html) داخل Node — ما في نسخة ثانية من القواعد.
   لا يكتب على النظام ولا على فايربيس: بيطلّع ملفات فقط.

   الاستخدام:
     node tools/wa-reader.js parse <chat.txt|chat.zip> --customer اسلام
          [--from 2026-09-08] [--to 2026-09-25] [--backup backup.json]
          [--mdy|--dmy] [--out imports/out] [--photos photos.txt]
       → import.json  (لزر «استيراد سندات جاهزة» بالإعدادات)
       → review.md    (البنود المشكوك فيها + الصور اللي لازم تنقرا)
       → media/       (صور الفواتير إذا التصدير «مع الوسائط»)

     node tools/wa-reader.js compare <import.json> <ref.json>
          [--customer اسلام] [--voucher إدخال]
       ref.json = نسخة احتياطية من النظام، أو مصفوفة سندات
       [{date,voucher,rows:[{item,weight,qty,price}]}]
   ========================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ---------- تحميل قارئ النظام داخل vm ---------- */
function loadApp(backup) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const store = new Map();
  const el = () => ({ style: {}, textContent: '', classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  const sb = {
    console, Intl, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null),
                    setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => el(), addEventListener() {}, createElement: el, body: el(),
                querySelector: () => null, querySelectorAll: () => [] },
    navigator: { onLine: true }, location: { protocol: 'file:' },
  };
  sb.window = sb; sb.addEventListener = () => {};
  vm.createContext(sb);
  /* البلوك 0 = الأدوات والبيانات، البلوك 1 = محرك القراءة */
  vm.runInContext(blocks[0], sb, { filename: 'index.html#0' });
  vm.runInContext(blocks[1], sb, { filename: 'index.html#1' });
  const run = s => vm.runInContext(s, sb);
  if (backup) {
    sb.__b = backup;
    /* قائمة الأصناف والأسعار الحية + التصحيحات المتعلَّمة — قراءة فقط */
    run('if(Array.isArray(__b.items)&&__b.items.length) items=__b.items;'
      + 'if(__b.settings&&__b.settings.learn) settings.learn=__b.settings.learn;'
      + 'if(__b.settings&&Array.isArray(__b.settings.customers)) settings.customers=__b.settings.customers;');
  }
    const fns = {};
  const call = (fn, ...a) => (fns[fn] = fns[fn] || run(fn))(...a);
  return { sb, run, call };
}

/* ---------- قراءة الملف ---------- */
const AR_DIG = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9,
                 '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
function normChat(t) {
  return t.replace(/^﻿/, '')
    .replace(/[٠-٩۰-۹]/g, d => AR_DIG[d])
    .replace(/٫/g, '.')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[  ]/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function readChat(file, outDir) {
  const media = [];
  let txt;
  if (/\.zip$/i.test(file)) {
    const list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const txtName = list.find(n => /(^|\/)_?chat\.txt$/i.test(n)) || list.find(n => /\.txt$/i.test(n));
    if (!txtName) throw new Error('ما لقيت ملف .txt داخل الـ zip');
    txt = execFileSync('unzip', ['-p', file, txtName], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const imgs = list.filter(n => /\.(jpe?g|png|webp|heic)$/i.test(n));
    if (imgs.length && outDir) {
      const md = path.join(outDir, 'media');
      fs.mkdirSync(md, { recursive: true });
      execFileSync('unzip', ['-o', '-j', '-q', file, ...imgs, '-d', md]);
      imgs.forEach(n => media.push(path.basename(n)));
    }
  } else {
    txt = fs.readFileSync(file, 'utf8');
  }
  return { txt: normChat(txt), media };
}

/* ---------- تقسيم الرسائل ---------- */
/* أندرويد: 02/10/2026, 09:15 - الاسم: النص
   آيفون:   [2/10/26, 9:15:03 AM] الاسم: النص                           */
const HDR = /^\[?(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})[,،]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?|ص|م)?\]?\s*(?:-\s*)?(.*)$/;
function splitMessages(txt, order) {
  const lines = txt.split('\n');
  const raw = [];
  for (const line of lines) {
    const m = line.match(HDR);
    if (m) raw.push({ a: +m[1], b: +m[2], y: +m[3], hh: +m[4], mm: +m[5], ap: m[7] || '', rest: m[8] || '' });
    else if (raw.length) raw[raw.length - 1].rest += '\n' + line;
  }
  /* ترتيب اليوم/الشهر: رقم أكبر من 12 بيحسم */
  let ord = order;
  if (!ord) {
    if (raw.some(r => r.a > 12)) ord = 'dmy';
    else if (raw.some(r => r.b > 12)) ord = 'mdy';
    else ord = 'dmy';
  }
  const p = n => String(n).padStart(2, '0');
  return {
    order: ord,
    msgs: raw.map(r => {
      const d = ord === 'mdy' ? r.b : r.a, mo = ord === 'mdy' ? r.a : r.b;
      const y = r.y < 100 ? 2000 + r.y : r.y;
      let h = r.hh;
      const ap = r.ap.replace(/[.\s]/g, '').toLowerCase();
      if ((ap === 'pm' || ap === 'م') && h < 12) h += 12;
      if ((ap === 'am' || ap === 'ص') && h === 12) h = 0;
      /* المرسل: «الاسم: النص» — رسائل النظام ما إلها مرسل */
      let sender = '', text = r.rest;
      const c = r.rest.indexOf(': ');
      if (c > 0 && c < 60 && !/\n/.test(r.rest.slice(0, c))) { sender = r.rest.slice(0, c).trim(); text = r.rest.slice(c + 2); }
      return { date: `${y}-${p(mo)}-${p(d)}`, time: `${p(h)}:${p(r.mm)}`, sender, text: text.trim() };
    }),
  };
}

/* رسائل/أسطر ما إلها علاقة بالسندات */
const SKIP_MSG = /^(?:This message was deleted|You deleted this message|تم حذف هذه الرسالة|حذفت هذه الرسالة|Messages and calls are end-to-end encrypted|.*\b(?:created group|created the group|added|joined using|left|removed|changed the (?:group|subject|group icon))\b)/i;
const MEDIA_RE = /<(?:image|video|audio|sticker|GIF|document|Media) omitted>|<attached:\s*([^>]+)>|([^\s<>]+\.(?:jpe?g|png|webp|heic|opus|mp4|pdf))(?:\s*\((?:file attached|ملف مرفق)\))?/i;
/* رسالة سعر/كمية بلا صنف: «١٣ونص» «٢٣ وربع» */
const PRICE_ONLY = /^[\d.\s]*(?:و\s*نص|و\s*ربع|ونص|وربع)?[\d.\s]*(?:دينار)?$/;

/* ---------- تجهيز سطر قبل parseLine ---------- */
const CONTAINER = /(?:^|\s)(?:سطل|سظل|سطول|كرتون[ةه]?|كراتين|جاط|جاطات|(?<!خيار\s*(?:بيبي\s*)?)(?:قناني|قنين[ةه])|(?<!مشوي\s*)تنك[ةه]?)(?=\s|\d|$)/g;
const HAS_CONTAINER = /(?:^|\s)(?:سطل|سظل|سطول|جاط|جاطات)(?=\s|\d|$)/;
const EXTRA = /(?:^|\s)(?:ikram|اكرام|كبير|صغير|عين[ةه]|ذمم|مستعمل|تجاري|عرض|بدل|مع\s+كياس|\+\s*كيس|بدون\s+[فق]اتور[ةه])(?=\s|$)|بيد\s+\S+.*$|مسجلهم.*$|من\s+الوحدات.*$/gi;
const UNIT_TOK = 'كيلو|كغم|كغ|كجم|لتر|غرام|غم|غ|ك';
function prepLine(line) {
  let s = line.trim();
  let price = null, priceNote = '', bonus = false;
  s = s.replace(/^\[Forwarded\]\s*/i, '').replace(/^[+＋]\s*/, '');
  /* «بونص» = بضاعة مجانية — منسجلها مع ملاحظة */
  s = s.replace(/(\d)?\s*بونص/g, (m, d) => { bonus = true; return d ? d + ' ' : ' '; });
  /* «١٠ ك» → «10ك» ، «٧٠٠ غرام» → «700غ» */
  s = s.replace(new RegExp('(\\d+(?:\\.\\d+)?)\\s+(' + UNIT_TOK + ')(?=\\s|$)', 'g'), '$1$2')
       .replace(/(\d+(?:\.\d+)?)\s*غرام/g, '$1غ');
  /* «٥حبات» «٥٠حبة» = عدد ، «٥٠٠٠تالاف» = 5000 */
  s = s.replace(/(\d+)\s*(?:حبات|حبه|حبة)(?=\s|$)/g, '$1').replace(/(\d)\s*(?:ت?الاف|آلاف)(?=\s|$)/g, '$1');
  /* «٢ك ونص» «٢كيلو ونص» = 2.5 */
  s = s.replace(/(\d+(?:\.\d+)?)\s*(ك|كيلو|كغ)\s*و\s*نص(?=\s|$)/g, (m, n, u) => (+n + 0.5) + 'ك');
  /* «9360ك» = 9.360ك ، «17200ك» = 17.2ك (فاصلة الآلاف ضايعة) */
  s = s.replace(/(\d{4,5})(ك|كيلو)(?![؀-ۿ])/g, (m, n) => (+n / 1000) + 'ك');
  /* سعر صريح: «١٩دينار» */
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:دينار|دنانير|د\.ا)(?=\s|$)/, (m, n) => { price = +n; priceNote = m.trim(); return ' '; });
  /* سعر بعد الحجم: «… ١٠ك  ١٦ونص» */
  if (price === null) {
    s = s.replace(new RegExp('(\\d+(?:\\.\\d+)?(?:' + UNIT_TOK + ')\\S*\\s+.*?)(\\d+(?:\\.\\d+)?)\\s*و\\s*نص\\s*$'), (m, pre, n) => {
      price = +n + 0.5; priceNote = n + ' ونص'; return pre; });
  }
  /* «على ١٧» بآخر السطر = سعر */
  if (price === null) {
    s = s.replace(/(?:^|\s)على\s+(\d+(?:\.\d+)?)\s*$/, (m, n) => { price = +n; priceNote = m.trim(); return ' '; });
  }
  s = s.replace(EXTRA, ' ');
  /* «سطل/كرتون» وصف عبوة — إلا إذا هو الصنف نفسه (سطل فارغ / جاط فارغ) */
  let container = false;
  if (!/(?:سطل|جاط|تنك)\s*(?:فارغ|مربع)/.test(s)) {
    container = HAS_CONTAINER.test(s);
    const t = s.replace(CONTAINER, ' ');
    if (/[؀-ۿ]{2,}/.test(t)) s = t;
  }
  s = s.replace(/(\d)\s*[*×]\s*(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return { line: s, price, priceNote, bonus, container };
}

const hasSize = s => new RegExp('\\d(?:' + UNIT_TOK + ')(?![\\u0600-\\u06FF])|(?:^|\\s)ك\\d').test(s);
const warned = r => !r || !r.item || /⚠️|غير واضح/.test(r.notes || '');
/* الصنف نفسه مش معروف (مش بس سعره ناقص) */
const unknown = r => !r || !r.item || /صنف غير موجود|ما في «|حدّد الحجم|غير واضح/.test(r.notes || '');

/* لو الصنف ما انلقى: نجرب أجزاء الاسم (بيشيل أسماء الأطراف مثل «من ام محمد»).
   ما منجرب إلا إذا السطر فيه حجم صريح — حتى ما نخترع بنود من الدردشة. */
function rescue(app, row, ctx, header) {
  if (!unknown(row) || row.weight === '' || row.weight === undefined) return row;
  const words = String(row.item || '').split(/\s+/).filter(Boolean);
  /* صنف فاضي («١٧٠ ١٠ك مستعمل») = الصنف مكتوب بسطر العنوان */
  const pool = words.length ? words : String(header || '').split(/\s+/).filter(Boolean);
  if (!pool.length || (words.length === 1)) return row;
  const nums = [row.qty, row.weight + (row.unit && row.unit !== '' ? row.unit : 'ك')].filter(x => x !== '' && x !== undefined).join(' ');
  for (let len = Math.min(pool.length - (words.length ? 1 : 0), 4); len >= 1; len--) {
    for (let i = pool.length - len; i >= 0; i--) {
      const span = pool.slice(i, i + len).join(' ');
      if (span.length < 3) continue;
      const r2 = app.call('parseLine', `${span} ${nums}`, Object.assign({}, ctx));
      if (!unknown(r2)) {
        r2.notes = (r2.notes ? r2.notes + ' • ' : '') + `فهمته من «${span}»`;
        return r2;
      }
    }
  }
  return row;
}

/* ---------- الشات → سندات (تاريخ الرسالة + الاتجاه) ---------- */
function chatToVouchers(app, msgs, opt) {
  const groups = new Map();
  const log = { skipped: [], removed: [], merged: [], images: [] };
  const grp = (d, v) => {
    const k = d + '|' + v;
    if (!groups.has(k)) groups.set(k, { date: d, voucher: v, rows: [] });
    return groups.get(k);
  };

  /* دمج رسالة «حجم بس» (مثل «١٠ك») مع اللي قبلها من نفس المرسل */
  const list = [];
  for (const m of msgs) {
    const prev = list[list.length - 1];
    if (prev && prev.sender === m.sender && prev.date === m.date
        && /^\s*\d+(?:\.\d+)?\s*(?:ك|كيلو|لتر)\s*$/.test(m.text)) {
      prev.text = prev.text.replace(/\s*$/, ' ' + m.text.trim());
      log.merged.push(`${m.date} ${m.time} «${m.text.trim()}» انضمت للرسالة اللي قبلها`);
      continue;
    }
    list.push(Object.assign({}, m));
  }

  let lastImg = null;
  for (const m of list) {
    if (opt.from && m.date < opt.from) continue;
    if (opt.to && m.date > opt.to) continue;
    if (!m.sender || SKIP_MSG.test(m.text)) continue;

    let text = m.text.replace(/^\[Forwarded\]\s*/i, '');
    let img = null;
    const med = text.match(MEDIA_RE);
    if (med) {
      img = { date: m.date, time: m.time, sender: m.sender,
        file: (med[1] || med[2] || '').trim(), caption: text.replace(MEDIA_RE, ' ').trim(), notes: [] };
      log.images.push(img);
      lastImg = img;
      text = text.replace(MEDIA_RE, ' ').trim();
      if (!text) continue;
    }

    /* «بدون ال جرجير» = تعليمات على صورة الفاتورة (سجّلها بدون هالصنف)
       — ما منمسح شي تلقائيًا، منعلّقها على الصورة للقراءة اليدوية */
    const keep = [];
    for (const ln of text.split('\n')) {
      const t = ln.trim();
      if (/^بدون\s/.test(t) && !/^بدون\s+[فق]اتور/.test(t)) {
        const target = img || (lastImg && lastImg.date === m.date ? lastImg : null);
        if (target) target.notes.push(`${m.time} «${t}»`);
        else log.skipped.push({ date: m.date, time: m.time, text: t, why: 'تعليمات «بدون» بلا صورة قبلها' });
        continue;
      }
      if (/^بدون\s+[فق]اتور/.test(t)) continue;           /* معلومة بس — بتنسجل عادي */
      if (t && PRICE_ONLY.test(t) && /ونص|وربع|دينار/.test(t)) {
        log.skipped.push({ date: m.date, time: m.time, text: t, why: 'سعر/رقم بلا صنف' });
        continue;
      }
      keep.push(ln);
    }
    if (!keep.length) continue;

    const ctx = { day: '', voucher: 'إخراج', date: m.date, cancelLast: false };
    const added = [];
    const header = keep[0].trim();
    for (const ln of keep) {
      if (!ln.trim()) continue;
      const pre = prepLine(ln);
      if (!pre.line) continue;
      let line = pre.line;
      /* «بيبي سطل ٣» بلا حجم → الحجم الافتراضي للصنف (السطل غالبًا 10ك) */
      if (pre.container && !hasSize(line) && /\d/.test(line)) {
        const base = app.call('applyBusinessRules', line.replace(/[\d.]+/g, ' ').trim()).name;
        const ds = app.call('defaultSizeFor', base);
        if (ds !== null) line += ` ${ds}ك`;
      }
      const before = ctx.cancelLast;
      let r = app.call('parseLine', line, ctx);
      if (!before && ctx.cancelLast) {
        const last = added.pop();
        ctx.cancelLast = false;
        if (last) { const gi = last.g.rows.indexOf(last.row); if (gi >= 0) last.g.rows.splice(gi, 1); }
        log.removed.push(`${m.date} ${m.time} «${ln.trim()}» ألغى البند اللي قبله`);
        continue;
      }
      if (!r) {
        if (/\d/.test(pre.line)) log.skipped.push({ date: m.date, time: m.time, text: ln.trim(), why: 'فيه أرقام وما انقرى' });
        continue;
      }
      r = rescue(app, r, { day: '', voucher: ctx.voucher, date: m.date, cancelLast: false }, header);
      /* وزن بلا عدد («جزر ٢٦كيلو» / «شطة ٣كيلو») = عبوة وحدة بهالوزن */
      if ((r.qty === '' || r.qty === undefined) && r.weight !== '' && r.item) {
        r.notes = (r.notes || '').replace(/\s*•?\s*العدد ناقص/, '');
        const ds = app.call('defaultSizeFor', r.base || r.item);
        /* «جزر ٥٠٠كيلو» لازم ما يطابق «جزر 500غ» */
        const clash = /\d(?:ك|كيلو|كغ)(?![\u0600-\u06FF])/.test(line) && /غ/.test(r.unit || '');
        const packs = ((unknown(r) || clash) && ds) ? app.call('kgToPacks', +r.weight, ds) : null;
        if (packs && packs.exact && packs.packs >= 2) {
          /* «جزر ٢٠٠كيلو» = 20 × 10ك */
          const r2 = app.call('parseLine', `${r.base || r.item} ${packs.packs} ${ds}ك`, { day: '', voucher: ctx.voucher, date: m.date, cancelLast: false });
          if (!unknown(r2)) { r = r2; r.notes = (r.notes ? r.notes + ' • ' : '') + `${packs.packs} × ${ds}ك من الوزن الكلي`; }
        }
        if (r.qty === '' || r.qty === undefined) {
          r.qty = 1; r.bulk = true;
          r.notes = (r.notes ? r.notes + ' • ' : '') + `وزن بدون عدد — سجلته 1 × ${r.weight}${r.unit || 'ك'}`;
        }
      }
      r.original = ln.trim();
      r.day = app.call('dayNameOf', m.date);
      r.msgTime = m.time; r.sender = m.sender; r.msgHead = header.slice(0, 60);
      r.src = img ? 'caption' : 'text';
      if (img) img.notes.push(`${m.time} «${ln.trim()}» انضاف كبند`);
      if (pre.price !== null) { r.price = pre.price; r.priceFromMsg = true;
        r.notes = (r.notes ? r.notes + ' • ' : '') + `السعر من الرسالة (${pre.priceNote})`; }
      if (pre.bonus) { r.bonus = true; r.notes = (r.notes ? r.notes + ' • ' : '') + '⚠️ بونص — تأكد من السعر'; }
      const g = grp(m.date, ctx.voucher);
      g.rows.push(r);
      added.push({ g, row: r });
    }
  }
  const vouchers = [...groups.values()].filter(g => g.rows.length)
    .sort((a, b) => (a.date + a.voucher).localeCompare(b.date + b.voucher));
  return { vouchers, log };
}

/* ---------- قراءة صور الفواتير (يدويًا) → بنود ----------
   ملف نصي: لكل صورة سطر عنوان ثم البنود بصيغة النظام «صنف عدد حجمك»:
     # 00003015-PHOTO-2026-09-08-11-49-43.jpg إخراج
     مشكل 5 10ك
     مكسيكي 3 7ك
   التاريخ = تاريخ رسالة الصورة (أو @2026-09-08 بالعنوان). سطر يبدأ بـ ; = ملاحظة. */
function mergePhotos(app, vouchers, images, text) {
  const byKey = new Map(vouchers.map(v => [v.date + '|' + v.voucher, v]));
  const log = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith(';')) continue;
    if (ln.startsWith('#')) {
      const h = ln.slice(1).trim();
      const dm = h.match(/@(\d{4}-\d{2}-\d{2})/);
      const vou = /إدخال|ادخال|مرتجع/.test(h) ? 'إدخال' : 'إخراج';
      const ref = h.split(/\s+/)[0];
      const img = images.find(i => i.file && (i.file === ref || i.file.startsWith(ref)));
      const date = dm ? dm[1] : (img && img.date);
      if (!date) { log.push(`⚠️ ما لقيت تاريخ للصورة ${ref}`); cur = null; continue; }
      cur = { ref, date, vou, img };
      continue;
    }
    if (!cur) continue;
    const ctx = { day: '', voucher: cur.vou, date: cur.date, cancelLast: false };
    const r = app.call('parseLine', ln, ctx);
    if (!r) { log.push(`⚠️ ${cur.ref}: «${ln}» ما انقرى`); continue; }
    r.original = ln; r.src = 'image'; r.day = app.call('dayNameOf', cur.date);
    r.msgTime = cur.img ? cur.img.time : ''; r.msgHead = '📷 ' + cur.ref;
    const k = cur.date + '|' + cur.vou;
    if (!byKey.has(k)) { const v = { date: cur.date, voucher: cur.vou, rows: [] }; byKey.set(k, v); vouchers.push(v); }
    byKey.get(k).rows.push(r);
  }
  vouchers.sort((a, b) => (a.date + a.voucher).localeCompare(b.date + b.voucher));
  return log;
}

/* ---------- المخرجات ---------- */
function custCode(app, name) {
  const c = (app.run('settings').customers || []).find(x => x.name === name);
  return (c && c.code) || crypto.createHash('sha1').update(name).digest('hex').slice(0, 6);
}
function toImport(app, vouchers, opt) {
  const code = custCode(app, opt.customer);
  return {
    kind: 'mefleh-import', v: 1, customer: opt.customer,
    from: opt.from || (vouchers[0] && vouchers[0].date) || '',
    to: opt.to || (vouchers.length && vouchers[vouchers.length - 1].date) || '',
    generatedAt: new Date().toISOString(),
    vouchers: vouchers.map(v => ({
      key: `wa-${code}-${v.date}-${v.voucher === 'إخراج' ? 'O' : 'I'}`,
      date: v.date, voucher: v.voucher,
      rows: v.rows.map(r => ({
        item: r.item, qty: r.qty === '' ? null : +r.qty,
        weight: r.weight === '' ? null : +r.weight, unit: r.unit || '',
        price: r.priceFromMsg ? +r.price : null, priceFromMsg: !!r.priceFromMsg,
        bulk: !!r.bulk, bonus: !!r.bonus,
        notes: r.notes || '', original: r.original || '', src: r.src || 'text',
        msg: `${r.msgTime || ''} ${r.msgHead || ''}`.trim(),
      })),
    })),
  };
}

function reviewMd(imp, log, extra) {
  const L = [];
  const fx = n => (n === null || n === '' || isNaN(n) ? '—' : String(+(+n).toFixed(3)));
  L.push(`# مراجعة استيراد واتساب — ${imp.customer}`, '',
    `الفترة: ${imp.from} ← ${imp.to} · ترتيب التاريخ: ${extra.order} · ${imp.vouchers.length} سند`, '');
  const warn = imp.vouchers.reduce((a, v) => a + v.rows.filter(r => /⚠️|ناقص/.test(r.notes)).length, 0);
  L.push(`- بنود بحاجة انتباه: **${warn}**`, `- أسطر فيها أرقام وما انقرت: **${log.skipped.length}**`,
    `- صور فواتير بالفترة: **${log.images.length}**${extra.media.length ? ` (منها ${extra.media.length} ملف موجود بـ media/)` : ' — ⚠️ التصدير بدون وسائط'}`, '');
  for (const v of imp.vouchers) {
    L.push(`## ${v.date} — ${v.voucher} (${v.rows.length} بند)`, '',
      '| الصنف | الوزن | العدد | سعر الرسالة | ملاحظة | السطر الأصلي | الرسالة |', '|---|---|---|---|---|---|---|');
    for (const r of v.rows) {
      const flag = /⚠️|ناقص/.test(r.notes) ? '⚠️ ' : '';
      L.push(`| ${flag}${r.item} | ${fx(r.weight)}${r.unit} | ${fx(r.qty)} | ${r.priceFromMsg ? fx(r.price) : ''} | ${r.notes.replace(/\|/g, '/')} | ${r.original.replace(/\|/g, '/')} | ${r.msg.replace(/\|/g, '/')} |`);
    }
    L.push('');
  }
  if (log.skipped.length) {
    L.push('## أسطر ما انقرت', '');
    log.skipped.forEach(s => L.push(`- ${s.date} ${s.time} — «${s.text}» (${s.why})`));
    L.push('');
  }
  if (log.removed.length || log.merged.length) {
    L.push('## تصحيحات تلقائية', '');
    log.removed.concat(log.merged).forEach(s => L.push('- ' + s));
    L.push('');
  }
  if (log.images.length) {
    L.push('## صور لازم تنقرا (فواتير)', '');
    log.images.forEach(i => L.push(`- ${i.date} ${i.time} ${i.sender}${i.file ? ' — `' + i.file + '`' : ''}${i.caption ? ' — تعليق: «' + i.caption.replace(/\n/g, ' / ') + '»' : ''}${i.notes.length ? ' — 📌 ' + i.notes.join(' ، ') : ''}`));
    L.push('');
  }
  return L.join('\n');
}

/* ---------- المقارنة مع مرجع ---------- */
function compare(app, imp, ref, opt) {
  let refV = Array.isArray(ref) ? ref : (ref.invoices || []);
  const cust = opt.customer || imp.customer;
  refV = refV.filter(v => (!v.customer || v.customer === cust)
    && (!(opt.from || imp.from) || v.date >= (opt.from || imp.from)) && (!(opt.to || imp.to) || v.date <= (opt.to || imp.to))
    && (!opt.voucher || v.voucher === opt.voucher));
  const k = r => app.call('key', app.call('applyBusinessRules', String(r.item || '')).name) + '@' + (r.weight === null || r.weight === undefined || r.weight === '' ? '' : +r.weight);
  const bag = vs => {
    const m = new Map();
    vs.forEach(v => (v.rows || []).forEach(r => {
      const kk = v.date + '|' + v.voucher + '|' + k(r);
      const e = m.get(kk) || { date: v.date, voucher: v.voucher, item: r.item, weight: r.weight, qty: 0 };
      e.qty += +r.qty || 0; m.set(kk, e);
    }));
    return m;
  };
  const from = opt.from || imp.from, to = opt.to || imp.to;
  const ours = bag(imp.vouchers.filter(v => (!opt.voucher || v.voucher === opt.voucher)
    && (!from || v.date >= from) && (!to || v.date <= to)));
  const theirs = bag(refV);
  const res = { match: [], qtyDiff: [], missing: [], extra: [] };
  for (const [kk, e] of theirs) {
    const o = ours.get(kk);
    if (!o) res.missing.push(e);
    else if (Math.abs(o.qty - e.qty) > 1e-6) res.qtyDiff.push({ ...e, ours: o.qty });
    else res.match.push(e);
  }
  for (const [kk, e] of ours) if (!theirs.has(kk)) res.extra.push(e);
  return res;
}

/* ---------- CLI ---------- */
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mdy' || a === '--dmy') o.order = a.slice(2);
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const backup = o.backup ? JSON.parse(fs.readFileSync(o.backup, 'utf8')) : null;
  const app = loadApp(backup);
  if (cmd === 'parse') {
    if (!o._[0] || !o.customer) throw new Error('الاستخدام: parse <chat> --customer <اسم الزبون>');
    const out = o.out || path.join(ROOT, 'imports', 'out');
    fs.mkdirSync(out, { recursive: true });
    const { txt, media } = readChat(o._[0], out);
    const { order, msgs } = splitMessages(txt, o.order);
    const { vouchers, log } = chatToVouchers(app, msgs, o);
    if (o.photos) {
      const plog = mergePhotos(app, vouchers, log.images, fs.readFileSync(o.photos, 'utf8'));
      plog.forEach(t => log.skipped.push({ date: '', time: '', text: t, why: 'ملف الصور' }));
    }
    const imp = toImport(app, vouchers, o);
    fs.writeFileSync(path.join(out, 'import.json'), JSON.stringify(imp, null, 1));
    fs.writeFileSync(path.join(out, 'review.md'), reviewMd(imp, log, { order, media }));
    const n = imp.vouchers.reduce((a, v) => a + v.rows.length, 0);
    console.log(`✅ ${msgs.length} رسالة → ${imp.vouchers.length} سند / ${n} بند · صور: ${log.images.length} · ما انقرى: ${log.skipped.length}`);
    console.log('   ' + path.join(out, 'import.json') + '\n   ' + path.join(out, 'review.md'));
  } else if (cmd === 'compare') {
    const imp = JSON.parse(fs.readFileSync(o._[0], 'utf8'));
    const ref = JSON.parse(fs.readFileSync(o._[1], 'utf8'));
    const r = compare(app, imp, ref, o);
    const tot = r.match.length + r.qtyDiff.length + r.missing.length;
    console.log(`مطابق: ${r.match.length}/${tot} · فرق بالعدد: ${r.qtyDiff.length} · ناقص عندنا: ${r.missing.length} · زايد عندنا: ${r.extra.length}`);
    const show = (t, a, f) => { if (a.length) { console.log('\n' + t); a.forEach(e => console.log('  ' + f(e))); } };
    show('فرق بالعدد:', r.qtyDiff, e => `${e.date} ${e.voucher} ${e.item} ${e.weight ?? ''} — المرجع ${e.qty} / إحنا ${e.ours}`);
    show('ناقص عندنا:', r.missing, e => `${e.date} ${e.voucher} ${e.item} ${e.weight ?? ''} ×${e.qty}`);
    show('زايد عندنا:', r.extra, e => `${e.date} ${e.voucher} ${e.item} ${e.weight ?? ''} ×${e.qty}`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n'));
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌ ' + (e && e.message || e)); process.exit(1); }
}
module.exports = { loadApp, normChat, splitMessages, chatToVouchers, mergePhotos, prepLine, toImport, compare };
