(() => {
  const CHAR_POOLS = [
    { pattern: /[a-z]/, size: 26 },
    { pattern: /[A-Z]/, size: 26 },
    { pattern: /[0-9]/, size: 10 },
    { pattern: /[^A-Za-z0-9]/, size: 33 },
  ];

  const WEAK_PATTERNS = /^(.)\1+$|password|123456|qwerty|admin/i;

  const SCORE_THRESHOLDS = [
    { minLength: 14, minVariety: 4, score: 4 },
    { minLength: 12, minVariety: 3, score: 3 },
    { minLength: 10, minVariety: 3, score: 2 },
    { minLength:  8, minVariety: 2, score: 1 },
  ];

  const SCORE_MAX_GUESSES = [1e2, 1e4, 1e6, 1e8, Infinity];

  const TIME_UNITS = [
    { limit: 1,          label: () => 'less than a second' },
    { limit: 60,         label: s => `${Math.round(s)} seconds` },
    { limit: 3600,       label: s => `${Math.round(s / 60)} minutes` },
    { limit: 86400,      label: s => `${Math.round(s / 3600)} hours` },
    { limit: 2592000,    label: s => `${Math.round(s / 86400)} days` },
    { limit: 31536000,   label: s => `${Math.round(s / 2592000)} months` },
    { limit: 3153600000, label: s => `${Math.round(s / 31536000)} years` },
  ];

  const GUESSES_PER_SECOND = 10_000;

  function getPoolSize(password) {
    return Math.max(
      CHAR_POOLS.reduce((sum, { pattern, size }) =>
        pattern.test(password) ? sum + size : sum, 0),
      1
    );
  }

  function getVariety(password) {
    return CHAR_POOLS.filter(({ pattern }) => pattern.test(password)).length;
  }

  function formatSeconds(seconds) {
    const unit = TIME_UNITS.find(({ limit }) => seconds < limit);
    return unit ? unit.label(seconds) : 'centuries';
  }

  function calcScore(password, variety) {
    const base = SCORE_THRESHOLDS.find(
      ({ minLength, minVariety }) =>
        password.length >= minLength && variety >= minVariety
    )?.score ?? 0;

    return WEAK_PATTERNS.test(password) ? Math.min(base, 1) : base;
  }

  window.zxcvbn = (rawPassword) => {
    const password = String(rawPassword ?? '');
    const pool     = getPoolSize(password);
    const variety  = getVariety(password);
    const score    = calcScore(password, variety);

    const rawGuesses = Math.pow(pool, Math.max(password.length, 1));
    const guesses    = Math.min(rawGuesses, SCORE_MAX_GUESSES[score]);
    const seconds    = guesses / GUESSES_PER_SECOND;

    return {
      score,
      guesses,
      crack_times_display: {
        offline_slow_hashing_1e4_per_second: formatSeconds(seconds),
      },
      feedback: { warning: '', suggestions: [] },
    };
  };
})();