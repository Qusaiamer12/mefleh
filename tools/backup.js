#!/usr/bin/env node
/* ==========================================================
   نسخة احتياطية مشفّرة للسحابة — قراءة فقط، ما بتكتب على فايرستور
   ----------------------------------------------------------
   المستودع عام، فالنسخة بتنشفّر بالمفتاح العام keys/backup_public.pem
   (AES-256-GCM للبيانات + RSA-OAEP للمفتاح). فكّها بس بالمفتاح الخاص
   اللي محفوظ بـ Google Drive تبع قصي (mefleh_backup_private.pem).

   سحب وتشفير:   node tools/backup.js pull  <out.enc>
   فك التشفير:   node tools/backup.js decrypt <in.enc> <private.pem> <out.json>
   ========================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pull } = require('./review-diff.js');

const PUB = path.join(__dirname, '..', 'keys', 'backup_public.pem');

function encrypt(buf, pubPem) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(buf, { level: 9 })), c.final()]);
  const ek = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return Buffer.from(JSON.stringify({
    v: 1, alg: 'RSA-OAEP-256+A256GCM+gzip',
    ek: ek.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }));
}
function decrypt(encBuf, privPem) {
  const o = JSON.parse(encBuf.toString());
  const key = crypto.privateDecrypt({ key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(o.ek, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]));
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'pull') {
    let snap, err;
    for (let i = 1; i <= 4; i++) {           /* السحب ممكن يلقط نص حفظ — منعيد */
      try { snap = await pull(); break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 5000 * i)); }
    }
    if (!snap) throw err;
    const inv = snap.data.wh_invoices_v1 || [];
    if (inv.length < 100) throw new Error('عدد السندات قليل بشكل مش طبيعي (' + inv.length + ') — ما رح نعتبرها نسخة سليمة');
    fs.writeFileSync(a, encrypt(Buffer.from(JSON.stringify(snap)), fs.readFileSync(PUB)));
    /* بالسجل بس أعداد — المستودع عام، فما بنطبع أسعار ولا مبالغ */
    console.log('backup ok:', Object.entries(snap.data).map(([k, v]) => `${k.replace(/^wh_|_v1$/g, '')}=${Array.isArray(v) ? v.length : 1}`).join(' '));
  } else if (cmd === 'decrypt') {
    fs.writeFileSync(c, decrypt(fs.readFileSync(a), fs.readFileSync(b)));
    const s = JSON.parse(fs.readFileSync(c, 'utf8'));
    console.log('decrypted', s.pulledAt, 'invoices', (s.data.wh_invoices_v1 || []).length, '→', c);
  } else {
    console.log('usage: backup.js pull <out.enc> | decrypt <in.enc> <private.pem> <out.json>');
    process.exit(2);
  }
}
if (require.main === module) main().catch(e => { console.error('❌', e.message); process.exit(1); });
module.exports = { encrypt, decrypt };
