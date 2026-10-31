const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor, isLeader } = require('../utils/org');
const { chatJSON } = require('../utils/openai');
const { cleanMeetingTasks, guessBusiness, MEETING_TASK_SHAPE } = require('../utils/drafts');
const { draftsFor, confirm, undo, membershipMap } = require('../services/drafts');
const { helpers } = require('./ai');

/**
 * /api/drafts: tasks waiting for their owner's OK (MONDAY_FEATURE_SPEC.md F-MTG-05, F-CAP-03).
 *   GET    /                    { meeting_id? } waiting drafts + a per-person summary
 *   PATCH  /:id                 { title?, assignee_id?, business_id?, due_date?, due_time?, priority? }
 *   POST   /drop                { ids } set aside (kept, status dropped)
 *   POST   /confirm             { ids } become to-dos, one notification per person
 *   POST   /undo                { ids } within a minute of confirming
 *   POST   /from-text           { text } one long message -> drafts (Inbox)
 */
const router = express.Router();
const { peopleForPrompt, datePrompt } = helpers;

const ids = (v) => (Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 500);

router.get('/', authenticate, async (req, res, next) => {
  try {
    res.json(await draftsFor(req.user.id, { meetingId: parseInt(req.query.meeting_id, 10) || null }));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const d = (await db.query(`SELECT * FROM todo_drafts WHERE id = $1 AND owner_id = $2 AND status = 'draft'`, [req.params.id, req.user.id])).rows[0];
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 500) : d.title;
    if (!title) return res.status(400).json({ error: 'Give it a title' });

    let assigneeId = d.assignee_id;
    let confidence = d.confidence;
    if (req.body.assignee_id !== undefined) {
      assigneeId = parseInt(req.body.assignee_id, 10) || null;
      if (assigneeId) {
        const ok = await db.query(`SELECT 1 FROM users WHERE id = $1 AND status != 'inactive'`, [assigneeId]);
        if (!ok.rows.length) return res.status(404).json({ error: 'Person not found' });
      }
      // Picked by hand: no longer a guess.
      confidence = assigneeId && assigneeId !== req.user.id ? 'sure' : 'mine';
      if (assigneeId === req.user.id) assigneeId = null;
    }

    let businessId = d.business_id;
    if (req.body.business_id !== undefined) {
      businessId = parseInt(req.body.business_id, 10) || null;
      if (businessId) {
        const actor = await loadActor(req.user.id);
        if (!(isLeader(actor) || actor.memberships.has(businessId))) return res.status(403).json({ error: 'You are not part of that business' });
      }
    } else if (req.body.assignee_id !== undefined) {
      const { memberships, leaders } = await membershipMap();
      const meeting = d.meeting_id ? (await db.query('SELECT business_id FROM meeting_notes WHERE id = $1', [d.meeting_id])).rows[0] : null;
      businessId = guessBusiness({ assigneeId, meetingBusinessId: meeting?.business_id || null, memberships, leaders });
    }

    const date = req.body.due_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null) : d.due_date;
    const time = req.body.due_time !== undefined ? (/^\d{2}:\d{2}$/.test(req.body.due_time || '') ? req.body.due_time : null) : d.due_time;
    const priority = req.body.priority !== undefined ? ([1, 2, 3, 4].includes(Number(req.body.priority)) ? Number(req.body.priority) : null) : d.priority;

    await db.query(
      `UPDATE todo_drafts SET title = $2, assignee_id = $3, confidence = $4, business_id = $5, due_date = $6, due_time = $7, priority = $8
       WHERE id = $1`,
      [d.id, title, assigneeId, confidence, businessId, date, date ? time : null, priority]
    );
    const { drafts } = await draftsFor(req.user.id, { meetingId: d.meeting_id });
    res.json({ draft: drafts.find((x) => x.id === d.id) || null });
  } catch (err) {
    next(err);
  }
});

router.post('/drop', authenticate, async (req, res, next) => {
  try {
    const r = await db.query(
      `UPDATE todo_drafts SET status = 'dropped', decided_at = NOW() WHERE owner_id = $1 AND status = 'draft' AND id = ANY($2::int[])`,
      [req.user.id, ids(req.body.ids)]
    );
    res.json({ dropped: r.rowCount });
  } catch (err) {
    next(err);
  }
});

router.post('/confirm', authenticate, async (req, res, next) => {
  try {
    const list = ids(req.body.ids);
    if (!list.length) return res.status(400).json({ error: 'Pick the tasks to create' });
    res.json(await confirm(req.user.id, list));
  } catch (err) {
    next(err);
  }
});

router.post('/undo', authenticate, async (req, res, next) => {
  try {
    res.json(await undo(req.user.id, ids(req.body.ids)));
  } catch (err) {
    next(err);
  }
});

// One long typed or spoken message ("Kaushal fix the gate by Friday, Nagarjuna send the drawings, ...") becomes
// drafts in the Inbox, reviewed the same way as a meeting's.
router.post('/from-text', authenticate, async (req, res, next) => {
  try {
    const text = sanitizeText(req.body.text, 8000);
    if (!text) return res.status(400).json({ error: 'Say or type the tasks first' });
    const people = await peopleForPrompt();
    const out = await chatJSON({
      system: `You split a message into separate tasks. ${datePrompt()} People who can be given a task: ${people.text}. `
        + 'The message may be in English, Telugu or both; write titles in English starting with a verb. '
        + 'Match names to the closest person (username as assignee) and copy the name as written into assignee_said. '
        + `A task the writer keeps for themself has assignee null and assignee_said null. Do not invent tasks. Reply as JSON: ${MEETING_TASK_SHAPE}`,
      user: text,
      maxTokens: 6000,
    });
    const tasks = cleanMeetingTasks(out.tasks, people, req.user.id);
    const { memberships, leaders } = await membershipMap();
    let position = 0;
    for (const t of tasks) {
      position += 1;
      await db.query(
        `INSERT INTO todo_drafts (owner_id, source, title, quote, assignee_id, assignee_said, confidence, business_id, due_date, due_time, priority, position)
         VALUES ($1, 'message', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [req.user.id, t.title, t.quote || '', t.assignee_id, t.assignee_said, t.confidence,
          guessBusiness({ assigneeId: t.assignee_id, memberships, leaders }), t.due_date, t.due_time, t.priority, position]
      );
    }
    res.status(201).json(await draftsFor(req.user.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
