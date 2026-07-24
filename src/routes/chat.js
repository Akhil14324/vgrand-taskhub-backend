const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { DELETE_FOR_EVERYONE_WINDOW_MS } = require('../constants/chat');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 5000;
const MAX_UPLOAD_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE || '5242880', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const UPLOAD_BASE_URL = process.env.UPLOAD_BASE_URL || '';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const name = `chat_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = /image\/|application\/pdf|text\/plain/;
    if (allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'), false);
    }
  },
});

function sanitizeBody(body) {
  if (!body) return null;
  const trimmed = String(body).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_MESSAGE_LENGTH) return trimmed.slice(0, MAX_MESSAGE_LENGTH);
  return trimmed.replace(/<[^>]*>/g, '');
}

async function getUserBusinesses(userId) {
  const result = await db.query('SELECT business_id FROM user_businesses WHERE user_id = $1', [userId]);
  return result.rows.map((r) => r.business_id);
}

async function isParticipant(conversationId, userId) {
  const result = await db.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return result.rows.length > 0;
}

async function getParticipantUserIds(conversationId) {
  const result = await db.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [conversationId]
  );
  return result.rows.map((r) => r.user_id);
}

async function buildConversationPreview(conversationId, userId) {
  const conv = await db.query(
    `SELECT c.*, cp.is_admin AS is_group_admin
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $2
     WHERE c.id = $1`,
    [conversationId, userId]
  );

  const lastMsg = await db.query(
    `SELECT m.id, m.body, m.attachment_url, m.attachment_type, m.sender_id, m.created_at, m.deleted_at
     FROM messages m
     LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $2
     WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND md.message_id IS NULL
     ORDER BY m.created_at DESC LIMIT 1`,
    [conversationId, userId]
  );

  const unread = await db.query(
    `SELECT COUNT(*) AS cnt FROM messages m
     LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $2
     WHERE m.conversation_id = $1
       AND m.sender_id != $2
       AND m.deleted_at IS NULL
       AND md.message_id IS NULL
       AND m.id > COALESCE(
         (SELECT last_read_message_id FROM conversation_participants
          WHERE conversation_id = $1 AND user_id = $2), 0
       )`,
    [conversationId, userId]
  );

  const participants = await db.query(
    `SELECT u.id, u.name, u.role, u.status, u.business_id
     FROM conversation_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id = $1
     ORDER BY u.name`,
    [conversationId]
  );

  return {
    ...conv.rows[0],
    participants: participants.rows,
    last_message: lastMsg.rows[0] || null,
    unread_count: parseInt(unread.rows[0].cnt, 10),
  };
}

// GET /api/chat/conversations — list current user's conversations
router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const convs = await db.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
       WHERE cp.user_id = $1 AND cp.is_hidden = FALSE
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );

    const result = [];
    for (const row of convs.rows) {
      result.push(await buildConversationPreview(row.id, req.user.id));
    }

    const totalUnread = result.reduce((sum, c) => sum + c.unread_count, 0);
    res.json({ conversations: result, total_unread: totalUnread });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/conversations — start a direct or group conversation
router.post('/conversations', authenticate, async (req, res, next) => {
  try {
    const { type, participantIds, name, businessId } = req.body;

    if (!type || !['direct', 'group'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "direct" or "group"' });
    }
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ error: 'At least one participant is required' });
    }

    const allIds = [...new Set([...participantIds, req.user.id])];

    if (type === 'group') {
      if (allIds.length < 3) {
        return res.status(400).json({ error: 'Group chat requires at least 3 participants' });
      }
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Group name is required for group chats' });
      }
    }

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

    if (!isAdmin) {
      const userBusinesses = await getUserBusinesses(req.user.id);
      for (const pid of participantIds) {
        if (pid === req.user.id) continue;
        const pBusinesses = await getUserBusinesses(pid);
        const hasCommon = pBusinesses.some((b) => userBusinesses.includes(b));
        if (!hasCommon) {
          return res.status(403).json({ error: 'You can only message users within your assigned businesses' });
        }
      }
    }

    if (type === 'direct') {
      if (allIds.length !== 2) {
        return res.status(400).json({ error: 'Direct chat must have exactly 2 participants' });
      }
      const otherId = participantIds[0];
      const existing = await db.query(
        `SELECT c.id FROM conversations c
         WHERE c.type = 'direct'
           AND c.id IN (
             SELECT conversation_id FROM conversation_participants WHERE user_id = $1
             INTERSECT
             SELECT conversation_id FROM conversation_participants WHERE user_id = $2
           )
         LIMIT 1`,
        [req.user.id, otherId]
      );
      if (existing.rows.length > 0) {
        const preview = await buildConversationPreview(existing.rows[0].id, req.user.id);
        return res.json({ conversation: preview });
      }
    }

    const convResult = await db.query(
      `INSERT INTO conversations (type, name, business_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, type === 'group' ? name.trim() : null, businessId || null, req.user.id]
    );
    const conversationId = convResult.rows[0].id;

    for (const uid of allIds) {
      await db.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, is_admin)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [conversationId, uid, uid === req.user.id && type === 'group']
      );
    }

    const preview = await buildConversationPreview(conversationId, req.user.id);
    res.status(201).json({ conversation: preview });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/conversations/:id/messages — paginated message history
router.get('/conversations/:id/messages', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { before, after, limit } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit) || 30));

    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    let query, params;
    if (after) {
      query = `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.deleted_at
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $4
               WHERE m.conversation_id = $1 AND m.id > $2 AND md.message_id IS NULL
               ORDER BY m.created_at ASC LIMIT $3`;
      params = [id, parseInt(after), lim, req.user.id];
    } else if (before) {
      query = `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.deleted_at
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $4
               WHERE m.conversation_id = $1 AND m.id < $2 AND md.message_id IS NULL
               ORDER BY m.created_at DESC LIMIT $3`;
      params = [id, parseInt(before), lim, req.user.id];
    } else {
      query = `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.deleted_at
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $3
               WHERE m.conversation_id = $1 AND md.message_id IS NULL
               ORDER BY m.created_at DESC LIMIT $2`;
      params = [id, lim, req.user.id];
    }

    const result = await db.query(query, params);
    const messages = result.rows.reverse();
    res.json({ messages, has_more: result.rows.length === lim });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/conversations/:id/messages — REST fallback send
router.post('/conversations/:id/messages', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { body, attachmentUrl, attachmentType, clientTempId } = req.body;

    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    const sanitized = sanitizeBody(body);
    if (!sanitized && !attachmentUrl) {
      return res.status(400).json({ error: 'Message body or attachment is required' });
    }

    const result = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [id, req.user.id, sanitized, attachmentUrl || null, attachmentType || null]
    );

    const msg = result.rows[0];
    const userResult = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id]);

    const message = {
      id: msg.id,
      conversationId: parseInt(id),
      senderId: req.user.id,
      senderName: userResult.rows[0].name,
      body: sanitized,
      attachmentUrl: attachmentUrl || null,
      attachmentType: attachmentType || null,
      createdAt: msg.created_at,
    };

    await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [id]);
    await db.query(
      'UPDATE conversation_participants SET is_hidden = FALSE WHERE conversation_id = $1 AND user_id != $2',
      [id, req.user.id]
    );

    res.status(201).json({ message, clientTempId });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/chat/conversations/:id/read — mark read up to a message id
router.patch('/conversations/:id/read', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { messageId } = req.body;

    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }
    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    await db.query(
      `UPDATE conversation_participants
       SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3)
       WHERE conversation_id = $1 AND user_id = $2`,
      [id, req.user.id, parseInt(messageId)]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/chat/conversations/:id — hide conversation for current user
router.delete('/conversations/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!(await isParticipant(id, userId))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    await db.query(
      'UPDATE conversation_participants SET is_hidden = TRUE WHERE conversation_id = $1 AND user_id = $2',
      [id, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/chat/messages/:id?scope=me|everyone — WhatsApp-style message deletion
router.delete('/messages/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const scope = req.query.scope || 'me';
    const userId = req.user.id;

    const msgResult = await db.query(
      'SELECT id, conversation_id, sender_id, body, attachment_url, attachment_type, created_at, deleted_at FROM messages WHERE id = $1',
      [id]
    );
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const msg = msgResult.rows[0];

    if (!(await isParticipant(msg.conversation_id, userId))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    if (scope === 'me') {
      await db.query(
        'INSERT INTO message_deletions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, userId]
      );
      return res.json({ ok: true });
    }

    if (scope === 'everyone') {
      const isSender = msg.sender_id === userId;
      const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

      if (!isSender && !isAdmin) {
        return res.status(403).json({ error: 'Only the sender can delete this message' });
      }

      if (!isAdmin) {
        const elapsed = Date.now() - new Date(msg.created_at).getTime();
        if (elapsed > DELETE_FOR_EVERYONE_WINDOW_MS) {
          return res.status(403).json({ error: 'Delete window has expired' });
        }
      }

      if (msg.deleted_at) {
        return res.status(400).json({ error: 'Message is already deleted' });
      }

      const attachmentUrl = msg.attachment_url;
      await db.query(
        'UPDATE messages SET deleted_at = NOW(), body = NULL, attachment_url = NULL, attachment_type = NULL WHERE id = $1',
        [id]
      );

      if (attachmentUrl) {
        try {
          const filename = path.basename(attachmentUrl);
          const filePath = path.join(UPLOAD_DIR, filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.error('[chat] Failed to delete attachment file:', e.message);
        }
      }

      const io = req.app.get('io');
      if (io) {
        io.to(`conv:${msg.conversation_id}`).emit('message:deleted', {
          conversationId: msg.conversation_id,
          messageId: parseInt(id),
          deletedAt: new Date().toISOString(),
        });
      }

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid scope. Use "me" or "everyone".' });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/upload — image/file upload for attachments
router.post('/upload', authenticate, upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const baseUrl = UPLOAD_BASE_URL || `${req.protocol}://${req.get('host')}/uploads`;
    const fileUrl = `${baseUrl}/${req.file.filename}`;
    res.status(201).json({
      url: fileUrl,
      type: req.file.mimetype,
      filename: req.file.filename,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
