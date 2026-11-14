const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { chatJSON, visionJSON, configured } = require('../utils/openai');

// /api/ai: everything that uses GPT. Each call needs OPENAI_API_KEY on the server (see utils/openai.js).
const router = express.Router();
const image = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }).single('file');

const clean = (v, n) => sanitizeText(v, n) || '';

function fail(res, err, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

router.get('/status', authenticate, (req, res) => res.json({ enabled: configured() }));

// POST /api/ai/suggest-steps — { title, notes? } 3 to 7 steps for a to-do, shaped by how this person broke
// similar work down before.
router.post('/suggest-steps', authenticate, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 300);
    if (!title) return res.status(400).json({ error: 'What is the to-do?' });
    const notes = clean(req.body.notes, 1500);
    const words = [...new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))].slice(0, 6);
    let examples = [];
    if (words.length) {
      examples = (await db.query(
        `SELECT p.title, (SELECT array_agg(c.title ORDER BY c.id) FROM todos c WHERE c.parent_id = p.id) AS steps
         FROM todos p JOIN todo_members tm ON tm.todo_id = p.id AND tm.user_id = $1
         WHERE p.parent_id IS NULL AND p.id <> COALESCE($3, 0) AND p.title ILIKE ANY($2::text[])
           AND EXISTS (SELECT 1 FROM todos c WHERE c.parent_id = p.id)
         ORDER BY p.id DESC LIMIT 3`,
        [req.user.id, words.map((w) => `%${w}%`), parseInt(req.body.todo_id, 10) || null]
      )).rows;
    }
    const out = await chatJSON({
      system: 'You break one work task into the concrete steps needed to finish it, for a small team of business managers. '
        + 'Reply as JSON: {"steps": ["..."]}. 3 to 7 steps, in order, each a short imperative phrase (under 70 characters), '
        + 'no numbering, no vague steps like "start" or "finish". If the task is trivial and needs fewer than 3 steps, give fewer. '
        + 'If past examples of similar work are given, follow their style and level of detail.',
      user: `Task: ${title}\n${notes ? `Details: ${notes}\n` : ''}${examples.length
        ? `Past examples by this person:\n${examples.map((e) => `- ${e.title}: ${(e.steps || []).join('; ')}`).join('\n')}` : ''}`,
    });
    const steps = (Array.isArray(out.steps) ? out.steps : []).map((s) => clean(String(s), 200)).filter(Boolean).slice(0, 8);
    res.json({ steps, learned_from: examples.length });
  } catch (err) {
    fail(res, err, next);
  }
});

/** The people GPT may assign to, as { name, username } lines, plus a resolver for what it answers. */
async function peopleForPrompt() {
  const rows = (await db.query(`SELECT id, name, username FROM users WHERE status <> 'inactive' ORDER BY name LIMIT 300`)).rows;
  const byUsername = new Map(rows.map((r) => [String(r.username).toLowerCase(), r]));
  return { rows, text: rows.map((r) => `${r.name} (@${r.username})`).join(', '), byUsername };
}

const TASK_SHAPE = '{"tasks":[{"title":"short imperative title","assignee":"username of the person it is for, or null","for_me":true or false,'
  + '"due_date":"YYYY-MM-DD or null","due_time":"HH:MM or null","priority":1-4 or null}]}';

function cleanTasks(list, people, myId) {
  return (Array.isArray(list) ? list : []).slice(0, 25).map((t) => {
    const title = clean(String(t.title || ''), 300);
    if (!title) return null;
    const who = t.assignee ? people.byUsername.get(String(t.assignee).replace(/^@/, '').toLowerCase()) : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null;
    const time = /^\d{2}:\d{2}$/.test(t.due_time || '') ? t.due_time : null;
    const priority = [1, 2, 3, 4].includes(Number(t.priority)) ? Number(t.priority) : null;
    return {
      title,
      assignee: who && who.id !== myId ? { id: who.id, name: who.name, username: who.username } : null,
      for_me: !who || who.id === myId,
      due_date: date,
      due_time: date ? time : null,
      priority,
    };
  }).filter(Boolean);
}

const datePrompt = () => {
  const today = todayInAppZone();
  const weekday = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  return `Today is ${weekday} ${today} (time zone ${APP_TIMEZONE}). Turn relative dates ("tomorrow", "next Friday") into YYYY-MM-DD.`;
};

// POST /api/ai/parse-tasks — { text } one spoken or typed message with several tasks becomes a list to confirm.
router.post('/parse-tasks', authenticate, async (req, res, next) => {
  try {
    const text = clean(req.body.text, 4000);
    if (!text) return res.status(400).json({ error: 'Say or type the tasks first' });
    const people = await peopleForPrompt();
    const out = await chatJSON({
      system: `You split a message into separate to-do tasks. ${datePrompt()} `
        + `People who can be given a task: ${people.text}. Match names loosely (first names, nicknames, spelling mistakes) to the closest person. `
        + 'A task meant for the speaker ("remind me", "I need to") has assignee null and for_me true. A task for someone else has their username as assignee. '
        + `Do not invent tasks. Keep each title short and start it with a verb. Reply as JSON: ${TASK_SHAPE}`,
      user: text,
    });
    res.json({ tasks: cleanTasks(out.tasks, people, req.user.id) });
  } catch (err) {
    fail(res, err, next);
  }
});

// POST /api/ai/photo — field "file" (a picture) and optional "hint": a handwritten note, whiteboard, invoice or
// photo of a problem becomes a short summary and a list of tasks to confirm.
router.post('/photo', authenticate, (req, res, next) => {
  image(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message });
      if (!req.file || !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Send a photo' });
      const people = await peopleForPrompt();
      const hint = clean(req.body.hint, 500);
      const out = await visionJSON({
        system: `You look at a photo taken at work (a handwritten note, whiteboard, invoice, bill, stock or equipment problem, a site) and turn it into things to do. ${datePrompt()} `
          + `People who can be given a task: ${people.text}. Only create tasks the photo actually calls for; if a name written in it matches a person, assign it to them. `
          + `Reply as JSON: {"summary":"1 to 3 plain sentences on what the photo shows","tasks":${TASK_SHAPE.slice(9, -1)}}`,
        user: hint ? `Context from the person: ${hint}` : 'What needs doing because of this photo?',
        imageUrl: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
      });
      res.json({ summary: clean(String(out.summary || ''), 800), tasks: cleanTasks(out.tasks, people, req.user.id) });
    } catch (err) {
      fail(res, err, next);
    }
  });
});

module.exports = router;
// Shared with routes/meetingNotes.js so standalone meeting notes read people and dates the same way.
module.exports.helpers = { peopleForPrompt, cleanTasks, datePrompt, TASK_SHAPE, clean };
