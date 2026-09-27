// Scoring for the language-layer eval (M4). Pure: no I/O, no LLM. Tested in
// backend/test/insights-evals.test.js.
//
// A row: { id, lang, step, text, expected: { weightLb?, breath?, orthopnea?, swelling?,
//          chestPain?, dizzy?, confusion?, fainting?, diureticTaken?, spo2? } }
// `expected` holds what the message actually says, not what any parser happens to catch.

export const FIELDS = ['weightLb', 'breath', 'orthopnea', 'swelling', 'chestPain', 'dizzy', 'confusion', 'fainting', 'diureticTaken', 'spo2'];
export const STEPS = ['weight', 'breath', 'orthopnea', 'swelling', 'redflags', 'diuretic', 'spo2', 'free'];
export const LANGS = ['en', 'es', 'vi', 'hi', 'zh'];

// Symptom flags are "present / not present": only `true` is a positive, and an explicit
// `false` (negation) just documents that the message must NOT raise the flag.
const PRESENCE = new Set(['orthopnea', 'chestPain', 'dizzy', 'confusion', 'fainting']);
const CATEGORIES = { breath: ['normal', 'exertion', 'rest'], swelling: ['none', 'mild', 'worse'] };
const WEIGHT_TOLERANCE_LB = 1; // 80 kg is 176.37 lb; 176 or 176.4 are both right

// ---------- normalizing predictions ----------

const toBool = (v) => (v === true || v === 'true' || v === 'yes' ? true : v === false || v === 'false' || v === 'no' ? false : undefined);
const toNum = (v) => (v === null || v === '' || v === undefined ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

// Coerce whatever a parser/LLM returned into clean field values; drop anything unusable.
export function normalize(pred) {
  const out = {};
  if (!pred || typeof pred !== 'object') return out;
  for (const f of FIELDS) {
    const v = pred[f];
    if (v === undefined || v === null) continue;
    if (f === 'weightLb' || f === 'spo2') {
      const n = toNum(v);
      if (n !== undefined) out[f] = n;
    } else if (CATEGORIES[f]) {
      const s = String(v).toLowerCase().trim();
      if (CATEGORIES[f].includes(s)) out[f] = s;
    } else {
      const b = toBool(v);
      if (b !== undefined) out[f] = b;
    }
  }
  return out;
}

// ---------- predictors ----------

// The rules exactly as the check-in applies them (core/checkin.js applyText): a
// step-specific parse first, then parseFreeText for anything else the message mentions.
export function rulesPredict(parser, text, step) {
  const a = {};
  if (step === 'weight') {
    const lb = parser.parseWeight(text);
    if (lb) a.weightLb = lb;
  } else if (step === 'spo2') {
    const n = parser.parseSpo2(text);
    if (n) a.spo2 = n;
  } else if (step === 'diuretic') {
    if (parser.isYes(text)) a.diureticTaken = true;
    else if (parser.isNo(text)) a.diureticTaken = false;
  } else if (step === 'orthopnea') {
    if (parser.isYes(text)) a.orthopnea = true;
    else if (parser.isNo(text)) a.orthopnea = false;
  }
  for (const [k, v] of Object.entries(parser.parseFreeText(text))) if (a[k] === undefined) a[k] = v;
  return normalize(a);
}

// What the live system does inside a check-in (core/checkin.js applyText): rules first, and
// the LLM only when the rules understood nothing. Outside a check-in ('free' rows: messages
// the patient sends unprompted), core/checkin.js handleUrgentFreeText uses the rules alone,
// so the hybrid is rules-only there too.
export function hybridPredict(rules, llm, step) {
  if (step === 'free') return rules;
  return Object.keys(rules).length ? rules : { ...normalize(llm) };
}

// ---------- scoring ----------

const matches = (field, exp, got) =>
  field === 'weightLb' ? Math.abs(exp - got) <= WEIGHT_TOLERANCE_LB : field === 'spo2' ? Math.round(exp) === Math.round(got) : exp === got;

// Per field for one message -> { tp, fp, fn } (0/1 each).
export function compareField(field, expected, predicted) {
  const exp = expected[field];
  const got = predicted[field];
  if (PRESENCE.has(field)) {
    const e = exp === true;
    const g = got === true;
    return { tp: +(e && g), fp: +(!e && g), fn: +(e && !g) };
  }
  if (exp === undefined && got === undefined) return { tp: 0, fp: 0, fn: 0 };
  if (exp !== undefined && got !== undefined && matches(field, exp, got)) return { tp: 1, fp: 0, fn: 0 };
  // A wrong value is both a false positive (said something untrue) and a false negative.
  return { tp: 0, fp: +(got !== undefined), fn: +(exp !== undefined) };
}

// "Call 911 now" signals, same definition as the check-in's isEmergency.
export const isEmergency = (a = {}) => a.chestPain === true || a.confusion === true || a.fainting === true || a.breath === 'rest' || (typeof a.spo2 === 'number' && a.spo2 < 90);

const r3 = (x) => Math.round(x * 1000) / 1000;
const ratio = (n, d) => (d ? r3(n / d) : null);

export function percentile(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

function tally(rows, preds) {
  const byField = Object.fromEntries(FIELDS.map((f) => [f, { tp: 0, fp: 0, fn: 0 }]));
  const total = { tp: 0, fp: 0, fn: 0 };
  let redExpected = 0;
  let redCaught = 0;
  let calm = 0;
  let falseAlarms = 0;
  const redMisses = [];
  const falseAlarmRows = [];
  for (const row of rows) {
    const got = preds[row.id]?.fields ?? {};
    for (const f of FIELDS) {
      const c = compareField(f, row.expected, got);
      for (const k of ['tp', 'fp', 'fn']) {
        byField[f][k] += c[k];
        total[k] += c[k];
      }
    }
    if (isEmergency(row.expected)) {
      redExpected++;
      if (isEmergency(got)) redCaught++;
      else redMisses.push(row);
    } else {
      calm++;
      if (isEmergency(got)) {
        falseAlarms++;
        falseAlarmRows.push(row);
      }
    }
  }
  const pr = (c) => ({ ...c, precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn) });
  return {
    n: rows.length,
    micro: pr(total),
    fields: Object.fromEntries(FIELDS.map((f) => [f, pr(byField[f])])),
    redFlag: { expected: redExpected, caught: redCaught, recall: ratio(redCaught, redExpected), misses: redMisses },
    falseAlarm: { calm, alarms: falseAlarms, rate: ratio(falseAlarms, calm), rows: falseAlarmRows },
  };
}

// preds: { [rowId]: { fields, ms, error? } } for one provider.
export function scoreRun(rows, preds) {
  const overall = tally(rows, preds);
  const byLang = Object.fromEntries(LANGS.filter((l) => rows.some((r) => r.lang === l)).map((l) => [l, tally(rows.filter((r) => r.lang === l), preds)]));
  const ms = rows.map((r) => preds[r.id]?.ms).filter(Number.isFinite);
  const errors = rows.filter((r) => preds[r.id]?.error).length;
  return { ...overall, byLang, latency: { p50: percentile(ms, 50), p95: percentile(ms, 95) }, errors };
}

// Gate from docs/team/MAHARSHI.md M4: rules red-flag recall on en/es must be 100%.
export function gate(rulesScore) {
  const langs = ['en', 'es'].filter((l) => rulesScore.byLang[l]);
  const misses = langs.flatMap((l) => rulesScore.byLang[l].redFlag.misses);
  return { pass: misses.length === 0, langs, misses };
}

// ---------- validation ----------

export function validateRows(rows) {
  const problems = [];
  const ids = new Set();
  for (const r of rows) {
    if (!r.id || ids.has(r.id)) problems.push(`duplicate or missing id: ${r.id}`);
    ids.add(r.id);
    if (!LANGS.includes(r.lang)) problems.push(`${r.id}: unknown lang ${r.lang}`);
    if (!STEPS.includes(r.step)) problems.push(`${r.id}: unknown step ${r.step}`);
    if (typeof r.text !== 'string' || !r.text.trim()) problems.push(`${r.id}: empty text`);
    if (!r.expected || typeof r.expected !== 'object') problems.push(`${r.id}: missing expected`);
    for (const [k, v] of Object.entries(r.expected ?? {})) {
      if (!FIELDS.includes(k)) problems.push(`${r.id}: unknown field ${k}`);
      else if (JSON.stringify(normalize({ [k]: v })) !== JSON.stringify({ [k]: v })) problems.push(`${r.id}: bad value ${k}=${v}`);
    }
  }
  return problems;
}

export const parseJsonl = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`messages.jsonl line ${i + 1}: ${e.message}`);
      }
    });

// ---------- report ----------

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const ms = (x) => (x == null ? '—' : x < 1 ? '<1 ms' : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);

export function renderMarkdown({ rows, results, meta }) {
  const names = Object.keys(results);
  const rules = results.rules;
  const g = rules ? gate(rules) : null;
  const L = [];
  L.push('# Language-layer eval results', '');
  L.push(`Generated by \`npm run eval\` (backend) on ${meta.date}. Dataset: \`evals/messages.jsonl\`, ${rows.length} labelled messages (${LANGS.map((l) => `${l} ${rows.filter((r) => r.lang === l).length}`).join(', ')}).`);
  L.push(`Providers: ${names.map((n) => `**${n}**${meta.models?.[n] ? ` (${meta.models[n]})` : ''}`).join(', ')}.${meta.skipped?.length ? ` Not available this run: ${meta.skipped.join(', ')}.` : ''}`, '');
  L.push('- **rules**: the offline regex/keyword parser, applied per check-in step exactly like `core/checkin.js`.');
  L.push('- **<provider>**: `parseWithLLM` alone (no step context), pinned with `LLM_PROVIDER`.');
  L.push('- **hybrid:<provider>**: what the live system does: inside a check-in, rules first and the LLM only when the rules understood nothing; for unprompted messages (step `free`), rules only (`handleUrgentFreeText`).', '');
  L.push('Precision = of the values a parser produced, how many were right. Recall = of the values the message stated, how many it got. Symptom flags count only "present" as positive; a negated symptom ("no chest pain") only counts against a parser that raises it anyway.', '');

  if (g) {
    L.push('## Gate: rules red-flag recall on en/es must be 100%', '');
    L.push(g.pass ? '**PASS.** Every English and Spanish emergency message is caught by the rules alone.' : `**FAIL.** The rules missed ${g.misses.length} emergency message(s) in en/es (listed below and filed in docs/team/REQUESTS.md for the parser owner).`, '');
  }

  L.push('## Summary', '');
  L.push('| Provider | Precision | Recall | Red-flag recall | False alarms (non-emergency msgs flagged) | Latency p50 | p95 | Errors |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const n of names) {
    const s = results[n];
    L.push(`| ${n} | ${pct(s.micro.precision)} | ${pct(s.micro.recall)} | ${pct(s.redFlag.recall)} (${s.redFlag.caught}/${s.redFlag.expected}) | ${pct(s.falseAlarm.rate)} (${s.falseAlarm.alarms}/${s.falseAlarm.calm}) | ${ms(s.latency.p50)} | ${ms(s.latency.p95)} | ${s.errors} |`);
  }
  L.push('');

  L.push('## By language', '');
  L.push(`| Provider | ${LANGS.map((l) => `${l} P / R / red-flag`).join(' | ')} |`);
  L.push(`|---|${LANGS.map(() => '---').join('|')}|`);
  for (const n of names) {
    const s = results[n];
    L.push(`| ${n} | ${LANGS.map((l) => (s.byLang[l] ? `${pct(s.byLang[l].micro.precision)} / ${pct(s.byLang[l].micro.recall)} / ${pct(s.byLang[l].redFlag.recall)}` : '—')).join(' | ')} |`);
  }
  L.push('');

  L.push('## By field (precision / recall)', '');
  L.push(`| Field | ${names.join(' | ')} |`);
  L.push(`|---|${names.map(() => '---').join('|')}|`);
  for (const f of FIELDS) L.push(`| ${f} | ${names.map((n) => `${pct(results[n].fields[f].precision)} / ${pct(results[n].fields[f].recall)}`).join(' | ')} |`);
  L.push('');

  const list = (title, items) => {
    L.push(`### ${title}`, '');
    if (!items.length) L.push('None.', '');
    else {
      for (const r of items) L.push(`- \`${r.id}\` (${r.lang}, ${r.step}): "${r.text}"${r.note ? ` (${r.note})` : ''}`);
      L.push('');
    }
  };
  for (const n of names) {
    L.push(`## Details: ${n}`, '');
    list('Missed emergencies', results[n].redFlag.misses);
    list('False alarms', results[n].falseAlarm.rows);
  }
  return L.join('\n');
}
