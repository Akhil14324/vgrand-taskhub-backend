const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { uploadOne, storeUpload, MAX_SIZE } = require('../utils/uploads');

/**
 * Notes (migration 060), mounted at /api/notes. A private notepad: only the person who wrote a note can see it.
 *
 *   GET    /                       { q? } my notes, pinned first, newest change first, each with its pictures
 *   POST   /                       { title?, body? }
 *   GET    /:id
 *   PATCH  /:id                    { title?, body?, pinned? }
 *   DELETE /:id
 *   POST   /:id/images             multipart "file" (a picture)
 *   DELETE /:id/images/:imageId
 */
const router = express.Router();

const IMAGE_COLUMNS = 'id, note_id, url, filename, mime, size_bytes AS size, created_at';

async function own(req, res) {
  const note = (await db.query('SELECT * FROM notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id])).rows[0];
  if (!note) res.status(404).json({ error: 'Note not found' });
  return note || null;
}

async function withImages(notes) {
  if (!notes.length) return notes;
  const imgs = (await db.query(`SELECT ${IMAGE_COLUMNS} FROM note_images WHERE note_id = ANY($1::int[]) ORDER BY id`, [notes.map((n) => n.id)])).rows;
  const byNote = new Map();
  for (const i of imgs) {
    if (!byNote.has(i.note_id)) byNote.set(i.note_id, []);
    byNote.get(i.note_id).push(i);
  }
  return notes.map((n) => ({ ...n, images: byNote.get(n.id) || [] }));
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const q = sanitizeText(req.query.q, 100);
    const rows = (await db.query(
      `SELECT * FROM notes WHERE user_id = $1 AND deleted_at IS NULL
         AND ($2::text = '' OR title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%')
       ORDER BY pinned DESC, updated_at DESC LIMIT 500`,
      [req.user.id, q || '']
    )).rows;
    res.json({ notes: await withImages(rows) });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query(
      'INSERT INTO notes (user_id, title, body) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, sanitizeText(req.body.title, 200) || '', sanitizeText(req.body.body, 50000) || '']
    )).rows[0];
    res.status(201).json({ note: (await withImages([row]))[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const note = await own(req, res);
    if (!note) return;
    res.json({ note: (await withImages([note]))[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const note = await own(req, res);
    if (!note) return;
    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 200) || '' : note.title;
    const body = req.body.body !== undefined ? sanitizeText(req.body.body, 50000) || '' : note.body;
    const pinned = req.body.pinned !== undefined ? !!req.body.pinned : note.pinned;
    const row = (await db.query('UPDATE notes SET title = $2, body = $3, pinned = $4, updated_at = NOW() WHERE id = $1 RETURNING *', [note.id, title, body, pinned])).rows[0];
    res.json({ note: (await withImages([row]))[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const note = await own(req, res);
    if (!note) return;
    await db.query('UPDATE notes SET deleted_at = NOW() WHERE id = $1', [note.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/images', authenticate, (req, res, next) => {
  uploadOne(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Pictures can be up to ${Math.round(MAX_SIZE / 1048576)} MB` });
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}, async (req, res, next) => {
  try {
    const note = await own(req, res);
    if (!note) return;
    if (!req.file) return res.status(400).json({ error: 'Choose a picture' });
    if (!String(req.file.mimetype).startsWith('image/')) return res.status(400).json({ error: 'Notes take pictures only' });
    const stored = await storeUpload(req, 'notes');
    const image = (await db.query(
      `INSERT INTO note_images (note_id, url, filename, mime, size_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING ${IMAGE_COLUMNS}`,
      [note.id, stored.url, stored.filename, stored.mime, stored.size]
    )).rows[0];
    await db.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [note.id]);
    res.status(201).json({ image });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)/images/:imageId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const note = await own(req, res);
    if (!note) return;
    await db.query('DELETE FROM note_images WHERE id = $1 AND note_id = $2', [req.params.imageId, note.id]);
    await db.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [note.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
