#!/usr/bin/env node
/* فحص سريع: كل سكربتات public/index.html بتنقرا بدون أخطاء صياغة */
const fs = require('fs');
const s = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g; let m, i = 0, bad = 0;
while ((m = re.exec(s))) { i++; try { new Function(m[1]); } catch (e) { bad++; console.error(`❌ script ${i}: ${e.message}`); } }
console.log(bad ? `❌ ${bad}/${i} scripts فيها أخطاء` : `✅ ${i} scripts سليمة`);
process.exit(bad ? 1 : 0);
