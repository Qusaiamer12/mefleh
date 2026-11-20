#!/usr/bin/env node
/* ==========================================================
   فحص المزامنة على محاكي فايرستور (بيانات وهمية — ولا شي حقيقي)
   ----------------------------------------------------------
   بيزرع المحاكي بنفس شكل السحابة القديمة (نص مقطّع)، وبيفتح ٣ «أجهزة»
   ويتأكد: النقل لمستند لكل سند، التعديل والحذف والإضافة بين جهازين،
   إعادة التحميل، وجهاز جديد — وإن العدد والمجموع ما بيضيعوا.
   التشغيل: المحاكي شغّال (firestore 8085 + auth 9099) والسيرفر على PORT
     node tools/ci/sync-test.js http://localhost:3111/
   ========================================================== */
const { chromium } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const URL = process.argv[2] || 'http://localhost:3111/';
const PID = 'mefleh-1efd3';
const FS = `http://127.0.0.1:8085/v1/projects/${PID}/databases/(default)/documents/wh_sync`;
const H = { authorization: 'Bearer owner', 'content-type': 'application/json' };
const N = 320;
let fail = 0;
const ok = (c, msg) => { console.log((c ? '✅ ' : '❌ ') + msg); if (!c) fail++; };

function synthetic() {
  const custs = ['اسلام', 'بلال', 'عمار', 'سعد'], inv = [];
  for (let i = 0; i < N; i++) {
    const rows = Array.from({ length: 3 + (i % 7) }, (_, j) => {
      const qty = 1 + ((i + j) % 9), price = +(1 + ((i * 7 + j) % 50) / 4).toFixed(3);
      return { id: `r${i}x${j}`, day: '', item: 'صنف تجربة ' + (j % 5), weight: 5, unit: 'ك', qty, price, total: +(qty * price).toFixed(3), notes: '' };
    });
    const d = new Date(Date.now() - 30 * 864e5 - (N - i) * 864e5 / 3);   /* كلها بالماضي */
    inv.push({ id: 'ci' + i.toString(36) + 'x', no: 'T-' + i, customer: custs[i % 4], voucher: i % 5 ? 'إخراج' : 'إدخال',
      date: d.toISOString().slice(0, 10), rows, total: +rows.reduce((a, r) => a + r.total, 0).toFixed(4), savedAt: d.toISOString() });
  }
  return inv;
}
function split(j) { const p = []; for (let i = 0; i < j.length;) { let e = Math.min(i + 200000, j.length);
  if (e < j.length) { const c = j.charCodeAt(e - 1); if (c >= 0xD800 && c <= 0xDBFF) e--; } p.push(j.slice(i, e)); i = e; } return p.length ? p : ['']; }
async function put(id, fields) { const r = await fetch(`${FS}/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(id + ' ' + r.status + ' ' + await r.text()); }
async function seed(inv) {
  await fetch(`http://127.0.0.1:8085/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
  const data = { wh_invoices_v1: inv, wh_dead_v1: [], wh_trash_v1: [], wh_log_v1: [] };
  for (const [k, v] of Object.entries(data)) {
    const j = JSON.stringify(v), ps = split(j);
    await put(k + '_m', { chunks: { integerValue: ps.length }, len: { integerValue: j.length }, t: { integerValue: Date.now() } });
    for (let i = 0; i < ps.length; i++) await put(k + '_' + i, { i: { integerValue: i }, d: { stringValue: ps[i] } });
  }
}
async function cloudDocs() { let n = 0, pt = '';
  do { const r = await (await fetch(`${FS}?pageSize=1000&mask.fieldPaths=i${pt ? '&pageToken=' + pt : ''}`, { headers: H })).json();
    for (const d of r.documents || []) if (/\/wh_v_/.test(d.name)) n++; pt = r.nextPageToken || ''; } while (pt);
  return n; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mefleh-ci-'));
async function open(name, minN) {
  const ctx = await chromium.launchPersistentContext(path.join(tmp, name), {});
  const p = ctx.pages()[0] || await ctx.newPage();
  p.on('pageerror', e => { console.log(`  [${name}] pageerror ${e.message}`); fail++; });
  await p.route(/^https:\/\/(firestore|identitytoolkit|securetoken)\.googleapis/, r => r.abort());   /* ولا طلب للسحابة الحقيقية */
  await p.addInitScript(() => { localStorage.setItem('wh_fb_emu', '8085'); sessionStorage.setItem('wh_session', JSON.stringify({ id: 'u_qusai', user: 'Qusai' })); });
  await p.goto(URL);
  await p.waitForFunction(m => { const d = document.getElementById('clDot'); return d && /متصل/.test(d.textContent) && invoices.length >= m; }, minN, { timeout: 120000 });
  await p.waitForTimeout(3000);
  return { ctx, p };
}
const stat = p => p.evaluate(() => ({ n: invoices.length, total: invoices.reduce((s, v) => s + (+v.total || 0), 0).toFixed(3) }));
const has = (p, id) => p.evaluate(i => invoices.some(v => v.id === i), id);
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 500)); } return false; }

(async () => {
  const inv = synthetic(), total0 = inv.reduce((s, v) => s + v.total, 0).toFixed(3);
  await seed(inv);
  let A = await open('A', N);
  let s = await stat(A.p);
  ok(s.n === N && s.total === total0, `جهاز A حمّل ${s.n} سند (المجموع ${s.total})`);
  ok(await until(async () => (await cloudDocs()) === N), 'النقل: كل سند صار مستند لحاله بالسحابة');
  const B = await open('B', N);
  s = await stat(B.p);
  ok(s.n === N && s.total === total0, `جهاز B حمّل ${s.n} سند من المستندات`);

  const eid = await A.p.evaluate(() => { const v = invoices[5]; v.rows[0].price = 99; calcTotal(v.rows[0]);
    v.total = +v.rows.reduce((a, r) => a + (+r.total || 0), 0).toFixed(4); v.savedAt = new Date().toISOString(); saveInv(); return v.id; });
  const eTot = await A.p.evaluate(i => invoices.find(v => v.id === i).total, eid);
  const eOk = await until(() => B.p.evaluate(([i, t]) => (invoices.find(v => v.id === i) || {}).total === t, [eid, eTot]));
  ok(eOk, 'تعديل على A وصل B');

  const did = await B.p.evaluate(() => { const v = invoices[invoices.length - 1]; toTrash('invoice', 't', v);
    invoices = invoices.filter(x => x.id !== v.id); saveInv(); return v.id; });
  ok(await until(async () => !(await has(A.p, did))), 'حذف على B وصل A');

  const nid = await A.p.evaluate(() => { const v = commitInvoice({ id: '', no: '', customer: 'عمار', voucher: 'إخراج', date: '2026-11-20',
    rows: [{ id: uid(), item: 'جديد', weight: 5, unit: 'ك', qty: 2, price: 3, total: 6 }] }); saveInv(); return v.id; });
  ok(await until(() => has(B.p, nid)), 'سند جديد على A وصل B');
  await B.ctx.close();

  await A.ctx.close();
  A = await open('A', N);
  ok(await has(A.p, nid) && !(await has(A.p, did)), 'بعد إعادة التحميل: الجديد موجود والمحذوف مش راجع');
  const C = await open('C', N);
  const [sa, sc] = [await stat(A.p), await stat(C.p)];
  ok(sa.n === N && sa.n === sc.n && sa.total === sc.total, `جهاز جديد C مطابق لـ A (${sc.n} سند، ${sc.total})`);
  await A.ctx.close(); await C.ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `\n❌ ${fail} فحص فشل` : '\n✅ كل فحوص المزامنة نجحت');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
