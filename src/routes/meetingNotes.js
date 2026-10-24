const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { chatJSON, transcribe } = require('../utils/openai');
const { createTodoCore } = require('./todos');
const { helpers } = require('./ai');
const { splitText } = require('../utils/transcript');

// /api/meeting-notes: meetings recorded or pasted on their own, not attached to a to-do. Only the person who
// recorded one can see it. A recording arrives in 5 minute pieces, so an hour-long meeting is 12 uploads.
const router = express.Router();
const audio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single('file');
const { peopleForPrompt, cleanTasks, datePrompt, TASK_SHAPE, clean } = helpers;

// One AI call handles about this much speech; a longer meeting is read part by part and the parts are merged.
const CHUNK_CHARS = 12000;
const MAX_TRANSCRIPT = 400000;

function fail(res, err, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

/** The meeting row if it belongs to this person, otherwise null (the caller answers 404). */
async function mine(req) {
  const row = (await db.query('SELECT * FROM meeting_notes WHERE id = $1 AND owner_id = $2', [parseInt(req.params.id, 10) || 0, req.user.id])).rows[0];
  return row || null;
}

const SHAPE = (s) => s.slice(9, -1);

// GET /api/meeting-notes — the newest first.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT id, title, pieces, length(transcript) AS chars, extracted IS NOT NULL AS has_notes, created_at, updated_at
       FROM meeting_notes WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    )).rows;
    res.json({ meetings: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/meeting-notes — { title? } starts an empty one.
router.post('/', authenticate, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 200) || 'Meeting';
    const row = (await db.query(
      'INSERT INTO meeting_notes (owner_id, title) VALUES ($1, $2) RETURNING *',
      [req.user.id, title]
    )).rows[0];
    res.status(201).json({ meeting: row });
  } catch (err) {
    next(err);
  }
});

// GET /api/meeting-notes/:id
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const row = await mine(req);
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
    res.json({ meeting: row });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/meeting-notes/:id — { title }
router.patch('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    if (!(await mine(req))) return res.status(404).json({ error: 'Meeting not found' });
    const title = clean(req.body.title, 200) || 'Meeting';
    const row = (await db.query('UPDATE meeting_notes SET title = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [req.params.id, title])).rows[0];
    res.json({ meeting: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/meeting-notes/:id
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    if (!(await mine(req))) return res.status(404).json({ error: 'Meeting not found' });
    await db.query('DELETE FROM meeting_notes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/meeting-notes/:id/audio — one recorded piece (field "file"). Its text is added after the earlier pieces.
router.post('/:id(\\d+)/audio', authenticate, (req, res, next) => {
  audio(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message });
      if (!(await mine(req))) return res.status(404).json({ error: 'Meeting not found' });
      if (!req.file) return res.status(400).json({ error: 'No recording was sent' });
      const text = await transcribe(req.file.buffer, req.file.originalname || 'part.webm', req.file.mimetype || 'audio/webm');
      const row = (await db.query(
        `UPDATE meeting_notes
         SET transcript = CASE WHEN transcript = '' THEN $2 ELSE transcript || E'\\n' || $2 END,
             pieces = pieces + 1, updated_at = NOW()
         WHERE id = $1 RETURNING length(transcript) AS chars, pieces`,
        [req.params.id, text]
      )).rows[0];
      res.json({ ok: true, added: text.length, chars: row.chars, pieces: row.pieces });
    } catch (err) {
      fail(res, err, next);
    }
  });
});

// POST /api/meeting-notes/:id/transcript — { text, replace? } pasted from any other tool.
router.post('/:id(\\d+)/transcript', authenticate, async (req, res, next) => {
  try {
    if (!(await mine(req))) return res.status(404).json({ error: 'Meeting not found' });
    const text = clean(req.body.text, MAX_TRANSCRIPT);
    if (!text) return res.status(400).json({ error: 'Paste the transcript first' });
    const row = (await db.query(
      `UPDATE meeting_notes
       SET transcript = CASE WHEN $3 OR transcript = '' THEN $2 ELSE transcript || E'\\n' || $2 END, updated_at = NOW()
       WHERE id = $1 RETURNING length(transcript) AS chars`,
      [req.params.id, text, !!req.body.replace]
    )).rows[0];
    res.json({ ok: true, chars: row.chars });
  } catch (err) {
    next(err);
  }
});

/** Summary, decisions and tasks from one part of a meeting. */
function readPart(part, { index, total, people, ownerId, title }) {
  const where = total > 1 ? `This is part ${index} of ${total} of one longer meeting. ` : '';
  return chatJSON({
    system: `You read part of a meeting transcript and pull out what was decided and who has to do what. ${datePrompt()} `
      + `${where}The meeting was called "${title}". People who can be given work: ${people.text}. `
      + 'The speech may be in English, in Telugu, or in both mixed together (Telugu is often written in English letters). '
      + 'Understand all of it, and write every title, summary and decision in clear English. '
      + 'Match the names people say to the closest person. Only list real action items that someone agreed to or was asked to do, not discussion. '
      + `Reply as JSON: {"summary":"2 to 4 plain sentences","decisions":["..."],"tasks":${SHAPE(TASK_SHAPE)}}`,
    user: part,
    maxTokens: 2000,
  }).then((out) => ({
    summary: clean(String(out.summary || ''), 1500),
    decisions: (Array.isArray(out.decisions) ? out.decisions : []).map((d) => clean(String(d), 300)).filter(Boolean),
    tasks: cleanTasks(out.tasks, people, ownerId),
  }));
}

// POST /api/meeting-notes/:id/extract — { create? } summary, decisions and action items for the whole meeting.
// The transcript is read in parts (all at once), then merged. With create, each task becomes a to-do for the
// person it is for; that happens once per meeting, so a second run with create is refused.
router.post('/:id(\\d+)/extract', authenticate, async (req, res, next) => {
  try {
    const row = await mine(req);
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
    if (req.body.create && row.extracted?.created) {
      return res.status(409).json({ error: 'The to-dos were already made from this meeting' });
    }
    const transcript = String(row.transcript || '').trim();
    if (transcript.length < 40) return res.status(400).json({ error: 'There is not enough said yet to work from' });

    const people = await peopleForPrompt();
    const parts = splitText(transcript, CHUNK_CHARS);
    const results = await Promise.all(parts.map((part, i) => readPart(part, {
      index: i + 1, total: parts.length, people, ownerId: req.user.id, title: row.title,
    })));

    const decisions = [...new Map(results.flatMap((r) => r.decisions).map((d) => [d.toLowerCase(), d])).values()].slice(0, 30);
    const tasks = [...new Map(results.flatMap((r) => r.tasks).map((t) => [t.title.toLowerCase(), t])).values()].slice(0, 60);
    let summary = results.map((r) => r.summary).filter(Boolean).join(' ');
    if (parts.length > 1 && summary) {
      // Several parts: shorten the joined part summaries into one.
      const out = await chatJSON({
        system: 'You join the summaries of consecutive parts of one meeting into one summary of 3 to 6 plain sentences, in English. Reply as JSON: {"summary":"..."}',
        user: summary,
        maxTokens: 800,
      });
      summary = clean(String(out.summary || summary), 1500);
    }

    const result = { summary: clean(summary, 1500), decisions, tasks, parts: parts.length };
    if (req.body.create) {
      const actor = await loadActor(req.user.id);
      const made = [];
      const failed = [];
      for (const t of tasks) {
        // Tasks for someone else go to them as a personal to-do; the rest stay on the speaker's own list.
        const body = { title: t.title, due_date: t.due_date || undefined, due_time: t.due_time || undefined, priority: t.priority || undefined };
        if (t.assignee) body.delegate_to = t.assignee.id;
        const made1 = await createTodoCore(actor, body);
        if (made1.todo) made.push({ title: t.title, assignee: t.assignee ? t.assignee.name : null });
        else failed.push(t.title);
      }
      result.created = made;
      result.failed = failed;
    }
    await db.query('UPDATE meeting_notes SET extracted = $2, updated_at = NOW() WHERE id = $1', [row.id, JSON.stringify(result)]);
    res.json(result);
  } catch (err) {
    fail(res, err, next);
  }
});

module.exports = router;
