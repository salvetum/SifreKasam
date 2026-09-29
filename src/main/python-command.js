// ─── PYTHON ÇÖZÜMLEYİCİ ──────────────────────────────────────────────────────
// Python yorumlayıcısını tek noktadan seçer. Hem geliştirme sunucusu
// (src/main/backend-process.js) hem de paketleme (scripts/build-backend.js)
// bu çözümleyiciyi kullanır; böylece "python PATH'te yok" durumunda ikisi de
// aynı şekilde `py -3.12` gibi bir adaya düşer.
//
// Sıra: env PYTHON override (boşluklara göre ayrıştırılır) → `python` → Windows'ta
// `py -3.12` / `-3.11` / `-3.10` / `-3` / `py` → POSIX'te `python3`.
// Her aday `--version` ile doğrulanır; ilk çalışan döner. Hiçbiri çalışmazsa
// ilk aday döner (build/servis çağıranı anlaşılır bir hata mesajı üretsin).

const { spawnSync } = require('child_process');

function parsePythonOverride(value) {
  const parts = String(value).trim().split(/[ \t]+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

function pythonCandidates() {
  if (process.platform !== 'win32') {
    return [
      { cmd: 'python3', args: [] },
      { cmd: 'python', args: [] },
    ];
  }
  return [
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3.12'] },
    { cmd: 'py', args: ['-3.11'] },
    { cmd: 'py', args: ['-3.10'] },
    { cmd: 'py', args: ['-3'] },
    { cmd: 'py', args: [] },
  ];
}

function resolvePythonCommand({ log = true } = {}) {
  if (process.env.PYTHON) {
    return parsePythonOverride(process.env.PYTHON);
  }
  const candidates = pythonCandidates();
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.cmd, [...candidate.args, '--version'], {
        timeout: 4000,
        windowsHide: true,
      });
      if (probe.status === 0 && probe.error == null) {
        if (log) {
          const label = [candidate.cmd, ...candidate.args].join(' ').trim();
          console.log(`Python secildi: ${label}`);
        }
        return candidate;
      }
    } catch (_) {}
  }
  if (log) {
    console.warn('Calisan Python yorumlayicisi bulunamadi; ilk aday kullanilacak.');
  }
  return candidates[0];
}

module.exports = { parsePythonOverride, pythonCandidates, resolvePythonCommand };
