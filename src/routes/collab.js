const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { getTodoFor, audienceIds } = require('../services/todoQueries');
const { uploadOne, storeUpload, MAX_SIZE } = require('../utils/uploads');

const router = express.Router();

// Reactions are drawn as icons by the app; these are the allowed kinds.
const REACTIONS = ['like', 'love', 'done', 'fire', 'idea', 'thanks'];

async function actorOf(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor) {
    res.status(401).json({ error: 'User no longer exists' });
    return null;
  }
  return actor;
}

async function visible(req, res, actor, todoId) {
  const todo = await getTodoFor(todoId, actor.id, actor);
  if (!todo) {
    res.status(404).json({ error: 'To-do not found' });
    return null;
  }
  return todo;
}

const announce = async (todoId) => emitToUsers(await audienceIds(todoId), 'todo:changed', { todoId: Number(todoId), action: 'commented' });

const REACTION_SUMMARY = (table, key) => `
  SELECT kind, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
  FROM ${table} WHERE ${key} = $1 GROUP BY kind ORDER BY MIN(created_at)`;

const ATTACHMENT_COLUMNS = 'id, todo_id, comment_id, user_id, url, filename, mime, size_bytes AS size, created_at';

// GET /api/collab/todos/:id — reactions on the to-do and the files attached to it directly
router.get('/todos/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visible(req, res, actor, req.params.id);
    if (!todo) return;
    const [reactions, files] = await Promise.all([
      db.query(REACTION_SUMMARY('todo_reactions', 'todo_id'), [todo.id, actor.id]),
      db.query(
        `SELECT ${ATTACHMENT_COLUMNS} FROM todo_attachments WHERE todo_id = $1 AND comment_id IS NULL AND draft = FALSE ORDER BY id`,
        [todo.id]
      ),
    ]);
    res.json({ reactions: reactions.rows, attachments: files.rows, kinds: REACTIONS });
  } catch (err) {
    next(err);
  }
});

// POST /api/collab/todos/:id/react — { kind } toggles the caller's reaction on the to-do
router.post('/todos/:id(\\d+)/react', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visible(req, res, actor, req.params.id);
    if (!todo) return;
    const kind = String(req.body.kind || '');
    if (!REACTIONS.includes(kind)) return res.status(400).json({ error: 'Unknown reaction' });
    const removed = await db.query('DELETE FROM todo_reactions WHERE todo_id = $1 AND user_id = $2 AND kind = $3', [todo.id, actor.id, kind]);
    if (!removed.rowCount) await db.query('INSERT INTO todo_reactions (todo_id, user_id, kind) VALUES ($1, $2, $3)', [todo.id, actor.id, kind]);
    const reactions = await db.query(REACTION_SUMMARY('todo_reactions', 'todo_id'), [todo.id, actor.id]);
    await announce(todo.id);
    res.json({ reactions: reactions.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/collab/comments/:id/react — { kind } toggles the caller's reaction on a comment
router.post('/comments/:id(\\d+)/react', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await db.query('SELECT id, todo_id FROM todo_comments WHERE id = $1', [req.params.id]);
    const comment = found.rows[0];
    const todo = comment ? await getTodoFor(comment.todo_id, actor.id, actor) : null;
    if (!comment || !todo) return res.status(404).json({ error: 'Comment not found' });
    const kind = String(req.body.kind || '');
    if (!REACTIONS.includes(kind)) return res.status(400).json({ error: 'Unknown reaction' });
    const removed = await db.query('DELETE FROM todo_comment_reactions WHERE comment_id = $1 AND user_id = $2 AND kind = $3', [comment.id, actor.id, kind]);
    if (!removed.rowCount) await db.query('INSERT INTO todo_comment_reactions (comment_id, user_id, kind) VALUES ($1, $2, $3)', [comment.id, actor.id, kind]);
    const reactions = await db.query(REACTION_SUMMARY('todo_comment_reactions', 'comment_id'), [comment.id, actor.id]);
    await announce(comment.todo_id);
    res.json({ reactions: reactions.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/collab/todos/:id/attachments?for=task|comment — multipart "file"
// "comment" files stay drafts until the comment that carries them is posted.
router.post('/todos/:id(\\d+)/attachments', authenticate, (req, res, next) => {
  uploadOne(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Files can be up to ${Math.round(MAX_SIZE / 1048576)} MB` });
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visible(req, res, actor, req.params.id);
    if (!todo) return;
    if (!req.file) return res.status(400).json({ error: 'Choose a file' });
    const stored = await storeUpload(req, 'todos');
    const draft = req.query.for === 'comment';
    const row = await db.query(
      `INSERT INTO todo_attachments (todo_id, user_id, url, filename, mime, size_bytes, draft)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ATTACHMENT_COLUMNS}`,
      [todo.id, actor.id, stored.url, stored.filename, stored.mime, stored.size, draft]
    );
    if (!draft) await announce(todo.id);
    res.status(201).json({ attachment: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/collab/attachments/:id — the uploader, the to-do's creator, or whoever may edit it
router.delete('/attachments/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await db.query('SELECT id, todo_id, user_id FROM todo_attachments WHERE id = $1', [req.params.id]);
    const row = found.rows[0];
    const todo = row ? await getTodoFor(row.todo_id, actor.id, actor) : null;
    if (!row || !todo) return res.status(404).json({ error: 'File not found' });
    if (row.user_id !== actor.id && todo.created_by !== actor.id && !todo.permissions.can_edit) {
      return res.status(403).json({ error: 'You can only remove your own files' });
    }
    await db.query('DELETE FROM todo_attachments WHERE id = $1', [row.id]);
    await announce(row.todo_id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.REACTIONS = REACTIONS;
