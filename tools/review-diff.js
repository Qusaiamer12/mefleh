#!/usr/bin/env node
/* ==========================================================
   مراجعة أسبوعية: شو عدّل قصي على السندات المستوردة؟
   ----------------------------------------------------------
   بيقارن كل بند انستورد من واتساب (زي ما سجّلناه) مع حاله
   هسا بالنظام بعد مراجعتك، وبيطلّع تقرير بالأخطاء المتكررة
   عشان القارئ والتسجيل يتعلموا منها.

   قراءة بس — ما بيكتب على النظام ولا على فايربيس أبدًا.

   الاستخدام:
     node tools/review-diff.js --pull [--save now.json] [--weeks 3]
          [--base snap1.json snap2.json ...] [--out report.md] [--json out.json]
     node tools/review-diff.js --data now.json [...]

     --pull   بيسحب نسخة حية (قراءة فقط) من فايربيس
     --data   نسخة موجودة (سحب أو نسخة احتياطية من الإعدادات)
     --weeks  كم أسبوع لورا (الافتراضي 3)، أو --from / --to بالتواريخ
     --base   نسخ أقدم: أول نسخة فيها السند = زي ما انستورد
              (للسندات القديمة اللي ما فيها نسخة «imp» محفوظة بالبند)

   مصدر «زي ما انستورد»:
     1) البند نفسه: r.imp (بتنحفظ تلقائيًا من وقت ما انضافت للاستيراد)
     2) وإلا: أقدم نسخة من --base فيها نفس السند ونفس البند (بالـ id)
   ========================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = x => (typeof x === 'string' ? JSON.parse(x) : x);

function args(argv) {
  const o = { _: [], base: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.base.push(argv[++i]); }
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[k] = argv[++i]; else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

/* ---------- البيانات: سحب قراءة فقط ---------- */
function fbConfig() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const key = (html.match(/apiKey:\s*"([^"]+)"/) || [])[1];
  const pid = (html.match(/projectId:\s*"([^"]+)"/) || [])[1];
  if (!key || !pid) throw new Error('ما لقيت FIREBASE_CONFIG بـ public/index.html');
  return { key, pid };
}
async function pull() {
  const { key, pid } = fbConfig();
  const a = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) })).json();
  if (!a.idToken) throw new Error('تعذّر الدخول لفايربيس: ' + JSON.stringify(a.error || a));
  const docs = {}; let pt = '';
  do {
    const r = await (await fetch(`https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/wh_sync?pageSize=300${pt ? '&pageToken=' + pt : ''}`,
      { headers: { authorization: 'Bearer ' + a.idToken } })).json();
    if (r.error) throw new Error(JSON.stringify(r.error));
    for (const d of r.documents || []) {
      const id = d.name.split('/').pop(); const f = d.fields || {}; docs[id] = {};
      for (const [k, v] of Object.entries(f)) docs[id][k] = v.stringValue ?? (v.integerValue != null ? +v.integerValue : v.doubleValue ?? v.booleanValue ?? null);
    }
    pt = r.nextPageToken || '';
  } while (pt);
  const data = {};
  for (const k of new Set(Object.keys(docs).filter(i => i.endsWith('_m')).map(i => i.slice(0, -2)))) {
    const m = docs[k + '_m']; let s = '';
    for (let i = 0; i < (m.chunks || 1); i++) s += (docs[k + '_' + i] || {}).d || '';
    if (s.length !== m.len) throw new Error(`النسخة ناقصة: ${k} (${s.length}/${m.len}) — جرّب مرة ثانية`);
    data[k] = JSON.parse(s);
  }
  return { pulledAt: new Date().toISOString(), data };
}
/* بيقبل: سحب {data:{wh_invoices_v1..}} أو نسخة احتياطية {invoices,items..} */
function invoicesOf(snap) {
  if (!snap) return [];
  if (snap.data && snap.data.wh_invoices_v1) return P(snap.data.wh_invoices_v1) || [];
  if (snap.invoices) return P(snap.invoices) || [];
  if (snap.wh_invoices_v1) return P(snap.wh_invoices_v1) || [];
  return [];
}

/* ---------- المقارنة ---------- */
const W = w => (w === '' || w === null || w === undefined || isNaN(+w) ? '' : String(+w));
const N = s => String(s ?? '').trim().replace(/\s+/g, ' ');
const num = x => (x === '' || x === null || x === undefined || isNaN(+x) ? null : +x);
const fx = x => (x === null ? '—' : String(+(+x).toFixed(3)));
const size = r => W(r.weight) + (W(r.weight) ? (N(r.unit) || 'ك') : '');
const lbl = r => `${N(r.item)}${size(r) ? ' ' + size(r) : ''}`;
const short = s => { s = N(s).replace(/^📱\s*/, ''); return s.length > 70 ? s.slice(0, 70) + '…' : s; };

function diffRow(b, r) {
  const ch = [];
  if (N(b.item) !== N(r.item)) ch.push('item');
  if (W(b.weight) !== W(r.weight) || (W(b.weight) && N(b.unit || 'ك') !== N(r.unit || 'ك'))) ch.push('size');
  if (num(b.qty) !== num(r.qty)) ch.push('qty');
  const bp = num(b.price), rp = num(r.price);
  if ((bp === null) !== (rp === null) || (bp !== null && Math.abs(bp - rp) > 0.0005)) ch.push('price');
  return ch;
}

function analyse(cur, bases, opt) {
  const today = opt.to || new Date().toISOString().slice(0, 10);
  const from = opt.from || new Date(Date.parse(today) - (7 * (+opt.weeks || 3)) * 864e5).toISOString().slice(0, 10);
  const imported = v => v && (v.importKey || v.src === 'whatsapp');
  const inRange = v => v.date >= from && v.date <= today;
  /* أقدم ظهور لكل سند بالنسخ القديمة = زي ما انرفع */
  const first = new Map();
  for (const s of bases) for (const v of invoicesOf(s)) if (v && v.id && !first.has(v.id) && imported(v)) first.set(v.id, v);
  const curV = invoicesOf(cur);
  const curById = new Map(curV.map(v => [v.id, v]));
  const out = { from, to: today, vouchers: 0, rows: 0, compared: 0, noBase: 0, changes: [], gone: [] };

  for (const v of curV) {
    if (!imported(v) || !inRange(v)) continue;
    out.vouchers++;
    const bv = first.get(v.id);
    const bRows = new Map(((bv && bv.rows) || []).map(r => [r.id, r]));
    const seen = new Set();
    for (const r of v.rows || []) {
      out.rows++;
      const b = r.imp ? Object.assign({ id: r.id, original: r.original, notes: r.notes }, r.imp) : bRows.get(r.id);
      if (r.imp || bRows.has(r.id)) seen.add(r.id);
      if (!b) { if (bv) out.changes.push({ kind: 'added', v, r }); else out.noBase++; continue; }
      out.compared++;
      const ch = diffRow(b, r);
      if (ch.length) out.changes.push({ kind: 'edit', ch, v, b, r });
    }
    for (const [id, b] of bRows) if (!seen.has(id) && !(v.rows || []).some(r => r.id === id)) out.changes.push({ kind: 'deleted', v, b });
  }
  /* سند مستورد كان موجود وانحذف */
  for (const [id, bv] of first) if (!curById.has(id) && inRange(bv)) out.gone.push(bv);
  return out;
}

/* ---------- التقرير ---------- */
function report(res) {
  const L = [];
  const by = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.entries()].sort((a, b) => b[1].length - a[1].length); };
  const ed = res.changes.filter(c => c.kind === 'edit');
  const items = ed.filter(c => c.ch.includes('item') || c.ch.includes('size'));
  const qtys = ed.filter(c => !c.ch.includes('item') && !c.ch.includes('size') && c.ch.includes('qty'));
  const prices = ed.filter(c => c.ch.length === 1 && c.ch[0] === 'price');
  const added = res.changes.filter(c => c.kind === 'added');
  const deleted = res.changes.filter(c => c.kind === 'deleted');

  L.push(`# مراجعة تعديلاتك على السندات المستوردة — ${res.from} ← ${res.to}`, '');
  L.push(`- سندات مستوردة بالفترة: **${res.vouchers}** (${res.rows} بند)، قارنت منها ${res.compared} بند${res.noBase ? ` (${res.noBase} بند ما إله نسخة أصلية — مش داخل بالمقارنة)` : ''}.`);
  L.push(`- عدّلت: **${ed.length}** بند — صنف/حجم ${items.length} · عدد ${qtys.length} · سعر ${prices.length}`);
  L.push(`- شلت ${deleted.length} بند وضفت ${added.length} بند، وحذفت ${res.gone.length} سند مستورد.`, '');

  const row = c => `${c.v.customer} ${c.v.date} ${c.v.no || ''}`.trim();
  if (items.length) {
    L.push('## الصنف أو الحجم (أهم شي للقارئ)', '', '| النص الأصلي | سجلناه | صار | مرات | آخرها |', '|---|---|---|---|---|');
    for (const [, g] of by(items, c => short(c.b.original || c.r.original || '') + '|' + lbl(c.b) + '|' + lbl(c.r))) {
      const c = g[g.length - 1];
      L.push(`| ${short(c.b.original || c.r.original || '') || '—'} | ${lbl(c.b)} ×${fx(num(c.b.qty))} | ${lbl(c.r)} ×${fx(num(c.r.qty))} | ${g.length} | ${row(c)} |`);
    }
    L.push('');
  }
  if (qtys.length) {
    L.push('## العدد', '', '| البند | النص الأصلي | سجلناه | صار | الزبون/السند |', '|---|---|---|---|---|');
    for (const c of qtys) L.push(`| ${lbl(c.r)} | ${short(c.b.original || c.r.original || '') || '—'} | ${fx(num(c.b.qty))} | ${fx(num(c.r.qty))} | ${row(c)} |`);
    L.push('');
  }
  if (prices.length) {
    L.push('## السعر (حسب الزبون والصنف)', '', '| الزبون | الصنف | النوع | سجلناه | صار | مرات |', '|---|---|---|---|---|---|');
    for (const [, g] of by(prices, c => c.v.customer + '|' + lbl(c.r) + '|' + c.v.voucher + '|' + fx(num(c.b.price)) + '|' + fx(num(c.r.price)))) {
      const c = g[0];
      L.push(`| ${c.v.customer} | ${lbl(c.r)} | ${c.v.voucher} | ${fx(num(c.b.price))} | ${fx(num(c.r.price))} | ${g.length} |`);
    }
    L.push('');
  }
  if (deleted.length) {
    L.push('## بنود شلتها (يعني ما لازم تنسجّل)', '');
    for (const c of deleted) L.push(`- ${row(c)}: ${lbl(c.b)} ×${fx(num(c.b.qty))} — «${short(c.b.original || '') || '—'}»`);
    L.push('');
  }
  if (added.length) {
    L.push('## بنود ضفتها (فاتنا نسجّلها)', '');
    for (const c of added) L.push(`- ${row(c)}: ${lbl(c.r)} ×${fx(num(c.r.qty))} @${fx(num(c.r.price))}${c.r.original ? ` — «${short(c.r.original)}»` : ''}`);
    L.push('');
  }
  if (res.gone.length) {
    L.push('## سندات مستوردة انحذفت', '');
    for (const v of res.gone) L.push(`- ${v.customer} ${v.date} ${v.no || ''} ${v.voucher} (${(v.rows || []).length} بند)`);
    L.push('');
  }
  if (!ed.length && !added.length && !deleted.length && !res.gone.length) L.push('ما في ولا تعديل على السندات المستوردة بهالفترة.');
  return L.join('\n');
}

async function main() {
  const o = args(process.argv.slice(2));
  let cur;
  if (o.pull) { cur = await pull(); if (o.save) fs.writeFileSync(o.save, JSON.stringify(cur)); }
  else if (o.data) cur = JSON.parse(fs.readFileSync(o.data, 'utf8'));
  else { console.error('لازم --pull أو --data <ملف>'); process.exit(2); }
  const bases = o.base.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const res = analyse(cur, bases, o);
  const md = report(res);
  if (o.out) fs.writeFileSync(o.out, md); else console.log(md);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(res.changes.map(c => ({
    kind: c.kind, ch: c.ch, customer: c.v.customer, date: c.v.date, no: c.v.no, voucher: c.v.voucher,
    before: c.b && { item: c.b.item, qty: c.b.qty, weight: c.b.weight, unit: c.b.unit, price: c.b.price, original: c.b.original },
    after: c.r && { item: c.r.item, qty: c.r.qty, weight: c.r.weight, unit: c.r.unit, price: c.r.price, original: c.r.original, notes: c.r.notes },
  })), null, 1));
  console.error(`✅ ${res.vouchers} سند · ${res.compared} بند انقارن · ${res.changes.length} تعديل · ${res.gone.length} سند انحذف`);
}
if (require.main === module) main().catch(e => { console.error('❌', e.message); process.exit(1); });
module.exports = { analyse, report, pull, invoicesOf };
