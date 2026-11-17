// Asking questions about a saved meeting (pure helpers; the route is POST /api/meeting-notes/:id/ask).
// The AI answers in words and may add ONE picture: a chart (numbers it counted from what was said) or a flow
// chart (steps and who hands what to whom). Whatever it returns is cut down to a safe, drawable shape here, so
// the app never has to trust the model's JSON.

const CHARTS = ['column', 'bar', 'line', 'pie', 'donut'];
const NODE_KINDS = ['start', 'step', 'decision', 'end'];
const MAX_TRANSCRIPT_CHARS = 280000; // about 70k tokens: fits the model with room for the answer

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A chart the app can draw: categories along the axis and up to 6 series of numbers, or null. */
function cleanChart(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).map((c) => text(typeof c === 'object' ? c?.label : c, 60)).filter(Boolean).slice(0, 24);
  if (!categories.length) return null;
  const series = (Array.isArray(raw.series) ? raw.series : []).slice(0, 6).map((s, i) => {
    const values = categories.map((_, k) => {
      const n = Number(Array.isArray(s?.values) ? s.values[k] : NaN);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    });
    return { key: `s${i}`, label: text(s?.label, 60) || `Series ${i + 1}`, values };
  }).filter((s) => s.values.some((v) => v !== 0));
  if (!series.length) return null;
  return {
    kind: 'chart',
    chart: CHARTS.includes(raw.chart) ? raw.chart : 'column',
    title: text(raw.title, 100),
    categories: categories.map((label, i) => ({ key: `c${i}`, label })),
    series,
  };
}

/** A flow chart the app can draw: up to 40 boxes and the arrows between boxes that exist, or null. */
function cleanFlow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set();
  const nodes = [];
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const id = text(n?.id, 24);
    const label = text(n?.label, 120);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label, kind: NODE_KINDS.includes(n?.kind) ? n.kind : 'step', who: text(n?.who, 60) || null });
    if (nodes.length === 40) break;
  }
  if (nodes.length < 2) return null;
  const pairs = new Set();
  const edges = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const from = text(e?.from, 24);
    const to = text(e?.to, 24);
    const key = `${from}>${to}`;
    if (!seen.has(from) || !seen.has(to) || from === to || pairs.has(key)) continue;
    pairs.add(key);
    edges.push({ from, to, label: text(e?.label, 60) || null });
    if (edges.length === 80) break;
  }
  return { kind: 'flow', title: text(raw.title, 100), nodes, edges };
}

/** A dashboard of the meeting: up to 8 headline numbers and up to 6 charts, or null when it has neither. */
function cleanDashboard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiles = (Array.isArray(raw.tiles) ? raw.tiles : []).map((t) => ({
    label: text(t?.label, 40), value: text(t?.value, 24), note: text(t?.note, 80) || null,
  })).filter((t) => t.label && t.value).slice(0, 8);
  const charts = (Array.isArray(raw.charts) ? raw.charts : []).map(cleanChart).filter(Boolean).slice(0, 6);
  if (!tiles.length && !charts.length) return null;
  return { kind: 'dashboard', title: text(raw.title, 100), tiles, charts };
}

/** The model's reply made safe: { answer, visual } where visual is a chart, a flow chart, a dashboard or null. */
function cleanReply(raw) {
  const answer = String(raw?.answer ?? '').trim().slice(0, 6000);
  const v = raw?.visual;
  const visual = v?.kind === 'flow' ? cleanFlow(v) : v?.kind === 'chart' ? cleanChart(v) : v?.kind === 'dashboard' ? cleanDashboard(v) : null;
  return { answer: answer || (visual ? 'Here it is.' : 'I could not find that in this meeting.'), visual };
}

/** Earlier questions and answers kept short enough to send along (the newest 8 turns, words only). */
function cleanHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-8).map((m) => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    text: String(m?.text ?? '').slice(0, 2000),
  })).filter((m) => m.text);
}

/** A transcript too long for one call keeps its beginning and its end; the cut is marked. */
function fitTranscript(transcript, max = MAX_TRANSCRIPT_CHARS) {
  const t = String(transcript || '');
  if (t.length <= max) return { text: t, cut: false };
  const head = Math.floor(max * 0.6);
  return { text: `${t.slice(0, head)}\n[... the middle of the meeting is left out here ...]\n${t.slice(t.length - (max - head))}`, cut: true };
}

function askPrompt({ title, date, transcript, summary, question, history }) {
  const past = history.map((m) => `${m.role === 'assistant' ? 'You' : 'They'}: ${m.text}`).join('\n');
  return {
    system: 'You answer questions about one recorded meeting, using only what was said in it. '
      + 'The speech may be in English, Telugu or both mixed (Telugu is often written in English letters); always answer in clear, plain English. '
      + 'If the meeting does not say, answer that it was not discussed; never guess. Keep answers short and direct, and name people as they were named. '
      + 'When they ask for a dashboard (or an overview of the whole meeting in numbers), add "visual" of kind "dashboard": 4 to 8 "tiles" of headline numbers counted from the meeting (tasks agreed, decisions made, people given work, open questions, dates or amounts mentioned) and 2 to 5 "charts". '
      + 'When they ask for one chart or graph, add "visual" of kind "chart" with numbers you counted from the meeting (for example tasks per person, topics by how often they came up). '
      + 'When they ask for a flow chart, a process or steps, add "visual" of kind "flow": boxes in order with arrows. Otherwise set "visual" to null. '
      + 'Reply as JSON: {"answer":"...","visual":null | '
      + '{"kind":"chart","chart":"column|bar|line|pie|donut","title":"...","categories":["..."],"series":[{"label":"...","values":[1,2]}]} | '
      + '{"kind":"dashboard","title":"...","tiles":[{"label":"...","value":"12","note":"short or null"}],"charts":[{"chart":"column|bar|line|pie|donut","title":"...","categories":["..."],"series":[{"label":"...","values":[1,2]}]}]} | '
      + '{"kind":"flow","title":"...","nodes":[{"id":"a","label":"...","kind":"start|step|decision|end","who":"name or null"}],"edges":[{"from":"a","to":"b","label":"optional"}]}}',
    user: `Meeting: "${title}" on ${date}.\n`
      + (summary ? `Summary already written: ${summary}\n` : '')
      + `\nTranscript:\n${transcript}\n`
      + (past ? `\nEarlier in this chat:\n${past}\n` : '')
      + `\nQuestion: ${question}`,
  };
}

module.exports = { cleanChart, cleanFlow, cleanDashboard, cleanReply, cleanHistory, fitTranscript, askPrompt, MAX_TRANSCRIPT_CHARS };
