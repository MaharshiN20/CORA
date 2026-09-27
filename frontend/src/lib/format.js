// Display helpers. null/undefined always renders as an em dash: "no data", never 0.
const NONE = '—';
const has = (x) => typeof x === 'number' && Number.isFinite(x);

export const money = (n) => (has(n) ? `$${Math.round(n).toLocaleString('en-US')}` : NONE);
export const compactMoney = (n) =>
  !has(n) ? NONE : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}k` : money(n);
export const pct = (x, digits = 0) => (has(x) ? `${(x * 100).toFixed(digits)}%` : NONE);
export const num = (x, digits = 1) => (has(x) ? String(Math.round(x * 10 ** digits) / 10 ** digits) : NONE);
export const minutes = (m) => (!has(m) ? NONE : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

export const LANGUAGE_NAMES = { en: 'English', es: 'Español', vi: 'Tiếng Việt', hi: 'हिन्दी', zh: '中文', ar: 'العربية', fr: 'Français', pt: 'Português', ko: '한국어', ru: 'Русский', tl: 'Tagalog' };
export const languageName = (code) => LANGUAGE_NAMES[code] ?? code?.toUpperCase() ?? NONE;

export const daysSince = (iso, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000)) : null);
export const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : NONE);
export const timeOf = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : NONE);
