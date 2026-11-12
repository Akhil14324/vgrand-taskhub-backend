/**
 * The end-of-day report (migration 065). Pure rules, unit-tested; the AI call lives in routes/timebox.js.
 *
 * Shape stored on timeboxes.report:
 *   items        [{ title, text }]   what the day was (3 to 6 bullets)
 *   impact       string              "Impact & Delegation" line
 *   productivity 1..10
 *   scale        1..10               only a massive jump in what the group does earns more than 2 or 3
 *   time_saved   { minutes_per_person, people, total_hours, note }   per person per week, from what shipped
 *   status       'goat' | 'pottelu'  goat = failed day, pottelu = hit the standard
 *   status_line  string
 */

const MAX_ITEMS = 8;
const POTTELU_AT = 7; // productivity at or above this is a day that hit the standard

const clip = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const rating = (v, fallback = 1) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : fallback;
};
const nonNeg = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n * 10) / 10) : 0;
};

/** The day's verdict when nobody picked one: productivity decides. */
function defaultStatus(productivity) {
  return productivity >= POTTELU_AT ? 'pottelu' : 'goat';
}

/** The closing line for a verdict. */
function defaultStatusLine(status) {
  return status === 'pottelu'
    ? 'Pottelu standard hit today — keep the pace tomorrow.'
    : 'Failed today — driving execution to hit Pottelu standards tomorrow.';
}

/** Validate a report from the AI or from the editor. Always returns something safe to store. */
function cleanReport(raw = {}) {
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((it) => (typeof it === 'string' ? { title: '', text: it } : it || {}))
    .map((it) => ({ title: clip(it.title, 80), text: clip(it.text, 500) }))
    .filter((it) => it.title || it.text)
    .slice(0, MAX_ITEMS);
  const productivity = rating(raw.productivity);
  const scale = rating(raw.scale);
  const status = raw.status === 'pottelu' || raw.status === 'goat' ? raw.status : defaultStatus(productivity);
  const ts = raw.time_saved || {};
  const people = Math.round(nonNeg(ts.people, 100000));
  const perPerson = nonNeg(ts.minutes_per_person, 100000);
  return {
    items,
    impact: clip(raw.impact, 600),
    productivity,
    scale,
    time_saved: {
      minutes_per_person: perPerson,
      people,
      // Recomputed from its parts when they are there, so an edit to one number keeps the total honest.
      total_hours: people && perPerson ? Math.round((perPerson * people / 60) * 10) / 10 : nonNeg(ts.total_hours, 1000000),
      note: clip(ts.note, 300),
    },
    status,
    status_line: clip(raw.status_line, 240) || defaultStatusLine(status),
  };
}

const SYSTEM_PROMPT = `You write the end-of-day report of a founder who runs a group of companies (hospitality, infrastructure, healthcare and technology). You are given what the person planned and did today. Answer with ONE JSON object and nothing else.

Rules:
- Use ONLY the facts you are given. Never invent a meeting, a person, a number or an achievement. If little happened, write fewer bullets.
- "items": 3 to 6 bullets. Each has a short "title" (2 to 5 words, like "Healthcare Site Review") and one "text" sentence that starts with a verb in the past tense and names the people involved, as written in the input.
- "impact": one or two sentences on what direction was set and who the day's momentum now depends on.
- "productivity": an honest whole number 1 to 10 for how much real work moved today (planned work finished, top priorities done, tasks completed).
- "scale": an honest whole number 1 to 10 for contribution to the SCALE of the group. Be strict: it rises only with massive growth (a major new business, a large deal, a big launch, a large hiring wave, a large jump in revenue or reach). Small features, routine meetings and ordinary tasks count towards productivity, never towards scale: they score 1 to 3.
- "time_saved": judge only what was SHIPPED today (a finished feature, automation or process). For it, estimate "minutes_per_person" = minutes saved per person per week, and "people" = how many of the group's people it applies to (never more than the group size you are given). Use 0 for both when nothing shipped. Add a one-line "note" saying what saves the time.
- "status": "pottelu" only if productivity is 7 or more, otherwise "goat".
- "status_line": for goat: "Failed today — driving execution to hit Pottelu standards tomorrow." For pottelu: "Pottelu standard hit today — keep the pace tomorrow." You may add a few honest words about what tomorrow hinges on.
- Plain text only: no emojis, no markdown.

JSON shape: {"items":[{"title":"","text":""}],"impact":"","productivity":1,"scale":1,"time_saved":{"minutes_per_person":0,"people":0,"note":""},"status":"goat","status_line":""}`;

module.exports = { cleanReport, defaultStatus, defaultStatusLine, SYSTEM_PROMPT, POTTELU_AT };
