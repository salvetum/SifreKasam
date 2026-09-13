// ─── BAŞLANGIÇ ZAMANLAMA (BENCH) ──────────────────────────────────────────────
// SIFREKASAM_BENCH=1 veya --bench ile etkinleşir; ana süreç akışındaki kilometre
// taşlarını işaretler ve sonuçları userData/startup-bench.json dosyasına yazar.
// Normal çalışmada sıfır yük bindirir (yalnızca bir ms() çağrısı).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const t0 = process.hrtime.bigint();
const marks = [];
const enabled = process.env.SIFREKASAM_BENCH === '1' || process.argv.includes('--bench');

function nowMs() {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function mark(name) {
  const m = nowMs();
  marks.push([name, m]);
  if (enabled) console.log(`[bench] ${name} ${m.toFixed(0)}ms`);
}

function dump(label) {
  if (!enabled) return;
  try {
    const file = path.join(app.getPath('userData'), 'startup-bench.json');
    fs.writeFileSync(file, JSON.stringify({ label, marks, t: Date.now() }, null, 2));
    console.log(`[bench] dumped ${file}`);
  } catch (err) {
    console.warn('[bench] dump hatasi:', err.message);
  }
}

module.exports = {
  enabled,
  mark,
  dump,
};