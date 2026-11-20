# النسخ الاحتياطية اليومية

- كل يوم الساعة 00:17 (توقيت الأردن)، GitHub Actions بيشغّل `daily-backup`. بيسحب كل بيانات السحابة **قراءة بس**، بيشفّرها، وبيحفظها 90 يوم.
- المستودع عام، عشان هيك الملف مشفّر:
  - البيانات مشفّرة بـ AES-256-GCM؛
  - مفتاح التشفير نفسه مشفّر بـ RSA-OAEP بالمفتاح العام `keys/backup_public.pem`.
- **المفتاح الخاص** (`mefleh_backup_private.pem`) مش بالمستودع، وموجود عند قصي بس. بدونه ما في طريقة تنفتح فيها أي نسخة.

## وين النسخ
GitHub ← المستودع ← **Actions** ← daily-backup ← افتح أي تشغيلة ← **Artifacts**.

## فتح نسخة
```
node tools/backup.js decrypt mefleh-backup-2026-11-21.enc mefleh_backup_private.pem backup.json
```
الملف `backup.json` بيطلع بنفس شكل `tools/review-diff.js pull`، يعني `{pulledAt, data:{wh_invoices_v1, …}}`.
