const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const stream = require('stream');
const { promisify } = require('util');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { DELETE_FOR_EVERYONE_WINDOW_MS } = require('../constants/chat');
const cloudinary = require('../utils/cloudinary');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 5000;
const MAX_UPLOAD_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE || '5242880', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const UPLOAD_BASE_URL = process.env.UPLOAD_BASE_URL || '';
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (!USE_CLOUDINARY && !fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = USE_CLOUDINARY
  ? multer.memoryStorage()
  : multer.diskStorage({
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
    const allowed = /image\/|application\/pdf|text\/plain|audio\//;
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

async function buildConversationPreview(conversationId, userId, viewerRole) {
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

  const isSuperAdmin = viewerRole === 'super_admin';
  const participants = await db.query(
    `SELECT u.id, u.name, u.role, u.status, u.business_id, u.profile_picture, u.last_seen
     FROM conversation_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id = $1 ${isSuperAdmin ? '' : "AND cp.is_invisible = FALSE"}
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

// GET /api/chat/users — list users available to start a chat with
router.get('/users', authenticate, async (req, res, next) => {
  try {
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    let result;
    if (isAdmin) {
      result = await db.query(
        `SELECT u.id, u.name, u.username, u.role, u.status
         FROM users u
         WHERE u.id != $1 AND u.status = 'active'
         ORDER BY u.name`,
        [req.user.id]
      );
    } else {
      result = await db.query(
        `SELECT DISTINCT u.id, u.name, u.username, u.role, u.status
         FROM users u
         JOIN user_businesses ub1 ON ub1.user_id = u.id
         JOIN user_businesses ub2 ON ub2.business_id = ub1.business_id AND ub2.user_id = $1
         WHERE u.id != $1 AND u.status = 'active'
         ORDER BY u.name`,
        [req.user.id]
      );
    }
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/conversations — list current user's conversations
router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === 'super_admin';
    const invisibleFilter = isSuperAdmin ? '' : 'AND cp.is_invisible = FALSE';

    const result = await db.query(
      `WITH user_convs AS (
         SELECT c.id, c.name, c.type, c.business_id, c.created_at, c.updated_at,
                cp.is_admin AS is_group_admin, cp.last_read_message_id, cp.is_muted
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.id
         WHERE cp.user_id = $1 AND cp.is_hidden = FALSE
         ORDER BY c.updated_at DESC
       ),
       last_msgs AS (
         SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id, m.id, m.body, m.attachment_url, m.attachment_type,
           m.sender_id, m.created_at, m.deleted_at
         FROM messages m
         WHERE m.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM message_deletions md
             WHERE md.message_id = m.id AND md.user_id = $1
           )
         ORDER BY m.conversation_id, m.created_at DESC
       ),
       unread_counts AS (
         SELECT m.conversation_id, COUNT(*) AS cnt
         FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
         WHERE m.sender_id != $1
           AND m.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM message_deletions md
             WHERE md.message_id = m.id AND md.user_id = $1
           )
           AND m.id > COALESCE(cp.last_read_message_id, 0)
         GROUP BY m.conversation_id
       ),
       conv_participants AS (
         SELECT cu.conversation_id,
           json_agg(json_build_object(
             'id', u.id, 'name', u.name, 'role', u.role,
            'status', u.status, 'business_id', u.business_id,
            'profile_picture', u.profile_picture, 'last_seen', u.last_seen,
            'is_admin', cu.is_admin
          ) ORDER BY u.name) AS participants
         FROM (
           SELECT DISTINCT cp.conversation_id, cp.user_id, cp.is_admin
           FROM conversation_participants cp
           WHERE 1=1 ${invisibleFilter}
           UNION
           SELECT DISTINCT m.conversation_id, m.sender_id, FALSE AS is_admin
           FROM messages m
           WHERE m.conversation_id IN (SELECT id FROM user_convs)
         ) cu
         JOIN users u ON u.id = cu.user_id
         GROUP BY cu.conversation_id
       )
       SELECT uc.*,
         COALESCE(lm.id, NULL) AS last_msg_id,
         lm.body AS last_msg_body,
         lm.attachment_url AS last_msg_attachment_url,
         lm.attachment_type AS last_msg_attachment_type,
         lm.sender_id AS last_msg_sender_id,
         lm.created_at AS last_msg_created_at,
         lm.deleted_at AS last_msg_deleted_at,
         COALESCE(uc_cnt.cnt, 0) AS unread_count,
         cp_part.participants
       FROM user_convs uc
       LEFT JOIN last_msgs lm ON lm.conversation_id = uc.id
       LEFT JOIN unread_counts uc_cnt ON uc_cnt.conversation_id = uc.id
       LEFT JOIN conv_participants cp_part ON cp_part.conversation_id = uc.id`,
      [req.user.id]
    );

    const conversations = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      business_id: row.business_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_group_admin: row.is_group_admin,
      is_muted: row.is_muted || false,
      last_read_message_id: row.last_read_message_id,
      participants: row.participants || [],
      last_message: row.last_msg_id ? {
        id: row.last_msg_id,
        body: row.last_msg_body,
        attachment_url: row.last_msg_attachment_url,
        attachment_type: row.last_msg_attachment_type,
        sender_id: row.last_msg_sender_id,
        created_at: row.last_msg_created_at,
        deleted_at: row.last_msg_deleted_at,
      } : null,
      unread_count: parseInt(row.unread_count, 10),
    }));

    const totalUnread = conversations.reduce((sum, c) => sum + c.unread_count, 0);
    res.json({ conversations, total_unread: totalUnread });
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
      if (!['admin', 'super_admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Only admins can create group chats' });
      }
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

      // Find the direct conversation the other user already participates in and that only
      // contains messages between the two of you. Prefer the one with the most messages
      // (the original conversation) in case duplicates were previously created.
      const existing = await db.query(
        `SELECT c.id,
           (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id AND user_id = $1) AS has_current_user
         FROM conversations c
         JOIN conversation_participants cp_other ON cp_other.conversation_id = c.id AND cp_other.user_id = $2
         WHERE c.type = 'direct'
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.sender_id NOT IN ($1, $2)
           )
         ORDER BY (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) DESC
         LIMIT 1`,
        [req.user.id, otherId]
      );

      if (existing.rows.length > 0) {
        const existingId = existing.rows[0].id;
        const hasCurrentUser = parseInt(existing.rows[0].has_current_user, 10) > 0;

        if (!hasCurrentUser) {
          // Current user row was deleted/removed; re-add it
          await db.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, is_admin)
             VALUES ($1, $2, FALSE)
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET is_hidden = FALSE`,
            [existingId, req.user.id]
          );
        }

        await db.query(
          'UPDATE conversation_participants SET is_hidden = FALSE WHERE conversation_id = $1 AND user_id = $2',
          [existingId, req.user.id]
        );
        const preview = await buildConversationPreview(existingId, req.user.id, req.user.role);
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

    const preview = await buildConversationPreview(conversationId, req.user.id, req.user.role);
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
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.is_edited, m.deleted_at, m.reply_to_id
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $4
               WHERE m.conversation_id = $1 AND m.id > $2 AND md.message_id IS NULL
               ORDER BY m.created_at ASC LIMIT $3`;
      params = [id, parseInt(after), lim, req.user.id];
    } else if (before) {
      query = `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.is_edited, m.deleted_at, m.reply_to_id
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $4
               WHERE m.conversation_id = $1 AND m.id < $2 AND md.message_id IS NULL
               ORDER BY m.created_at DESC LIMIT $3`;
      params = [id, parseInt(before), lim, req.user.id];
    } else {
      query = `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
                      m.body, m.attachment_url, m.attachment_type, m.created_at, m.edited_at, m.is_edited, m.deleted_at, m.reply_to_id
               FROM messages m JOIN users u ON u.id = m.sender_id
               LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $3
               WHERE m.conversation_id = $1 AND md.message_id IS NULL
               ORDER BY m.created_at DESC LIMIT $2`;
      params = [id, lim, req.user.id];
    }

    const result = await db.query(query, params);
    const messages = result.rows.reverse();

    if (messages.length > 0) {
      const messageIds = messages.map((m) => m.id);
      const reactionsResult = await db.query(
        `SELECT mr.message_id, mr.emoji, json_agg(json_build_object('userId', mr.user_id, 'userName', u.name)) as users
         FROM message_reactions mr JOIN users u ON u.id = mr.user_id
         WHERE mr.message_id = ANY($1::int[]) GROUP BY mr.message_id, mr.emoji`,
        [messageIds]
      );
      const reactionsMap = {};
      reactionsResult.rows.forEach((r) => {
        if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = {};
        reactionsMap[r.message_id][r.emoji] = r.users;
      });
      messages.forEach((m) => {
        m.reactions = reactionsMap[m.id] || {};
      });

      const replyIds = [...new Set(messages.map((m) => m.reply_to_id).filter(Boolean))];
      if (replyIds.length > 0) {
        const replyResult = await db.query(
          `SELECT m.id, m.body, m.attachment_url, m.attachment_type, u.name as sender_name
           FROM messages m JOIN users u ON u.id = m.sender_id
           WHERE m.id = ANY($1::int[])`,
          [replyIds]
        );
        const replyMap = {};
        replyResult.rows.forEach((r) => {
          replyMap[r.id] = {
            id: r.id,
            body: r.body,
            attachmentUrl: r.attachment_url,
            attachmentType: r.attachment_type,
            senderName: r.sender_name,
          };
        });
        messages.forEach((m) => {
          if (m.reply_to_id) m.replyTo = replyMap[m.reply_to_id] || null;
        });
      }
    }

    res.json({ messages, has_more: result.rows.length === lim });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/conversations/:id/messages — REST fallback send
router.post('/conversations/:id/messages', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { body, attachmentUrl, attachmentType, clientTempId, replyToId } = req.body;

    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    const sanitized = sanitizeBody(body);
    if (!sanitized && !attachmentUrl) {
      return res.status(400).json({ error: 'Message body or attachment is required' });
    }

    const result = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [id, req.user.id, sanitized, attachmentUrl || null, attachmentType || null, replyToId || null]
    );

    const msg = result.rows[0];
    const userResult = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id]);

    let replyTo = null;
    if (replyToId) {
      const replyResult = await db.query(
        `SELECT m.id, m.body, m.attachment_url, m.attachment_type, u.name as sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id = $1`,
        [replyToId]
      );
      if (replyResult.rows.length > 0) {
        const r = replyResult.rows[0];
        replyTo = {
          id: r.id,
          body: r.body,
          attachmentUrl: r.attachment_url,
          attachmentType: r.attachment_type,
          senderName: r.sender_name,
        };
      }
    }

    const message = {
      id: msg.id,
      conversationId: parseInt(id),
      senderId: req.user.id,
      senderName: userResult.rows[0].name,
      body: sanitized,
      attachmentUrl: attachmentUrl || null,
      attachmentType: attachmentType || null,
      replyToId: replyToId || null,
      replyTo,
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

    // Hide the conversation for the current user (delete-for-me)
    await db.query(
      'UPDATE conversation_participants SET is_hidden = TRUE WHERE conversation_id = $1 AND user_id = $2',
      [id, userId]
    );

    // Mark all existing messages as deleted for the current user so they
    // do not reappear if the conversation becomes visible again later.
    await db.query(
      `INSERT INTO message_deletions (message_id, user_id)
       SELECT id, $2 FROM messages WHERE conversation_id = $1
       ON CONFLICT DO NOTHING`,
      [id, userId]
    );

    // Check if any unhidden participants remain
    const remaining = await db.query(
      'SELECT COUNT(*) AS cnt FROM conversation_participants WHERE conversation_id = $1 AND is_hidden = FALSE',
      [id]
    );

    if (parseInt(remaining.rows[0].cnt, 10) === 0) {
      // No unhidden participants left — permanently delete the conversation and all its messages
      await db.query('DELETE FROM message_deletions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)', [id]);
      await db.query('DELETE FROM messages WHERE conversation_id = $1', [id]);
      await db.query('DELETE FROM conversation_participants WHERE conversation_id = $1', [id]);
      await db.query('DELETE FROM conversations WHERE id = $1', [id]);

      const io = req.app.get('io');
      if (io) {
        io.to(`conv:${id}`).emit('conversation:deleted', { conversationId: parseInt(id), deletedBy: userId });
      }
    }

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

      const attachmentUrl = msg.attachment_url;

      // Permanently delete the message and all related records
      await db.query('DELETE FROM message_deletions WHERE message_id = $1', [id]);
      await db.query('DELETE FROM messages WHERE id = $1', [id]);

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
          permanent: true,
        });
      }

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid scope. Use "me" or "everyone".' });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/upload — image/file/audio upload for attachments
router.post('/upload', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (USE_CLOUDINARY) {
      const ext = path.extname(req.file.originalname || '');
      const publicId = `chat/${Date.now()}_${Math.round(Math.random() * 1e9)}`;
      const resourceType = req.file.mimetype.startsWith('image/') ? 'image' : 'raw';
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { public_id: publicId, resource_type: resourceType, format: ext.replace('.', '') || undefined },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);
        bufferStream.pipe(uploadStream);
      });
      return res.status(201).json({
        url: result.secure_url,
        type: req.file.mimetype,
        filename: req.file.originalname,
        size: req.file.size,
      });
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

// PATCH /api/chat/messages/:id — edit message
router.patch('/messages/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Body is required' });
    }

    const msgResult = await db.query('SELECT sender_id FROM messages WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (msgResult.rows[0].sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Can only edit your own messages' });
    }

    const sanitized = sanitizeBody(body);
    await db.query('UPDATE messages SET body = $1, is_edited = TRUE, edited_at = NOW() WHERE id = $2', [sanitized, id]);

    const io = req.app.get('io');
    if (io) {
      const msgConv = await db.query('SELECT conversation_id FROM messages WHERE id = $1', [id]);
      if (msgConv.rows.length > 0) {
        io.to(`conv:${msgConv.rows[0].conversation_id}`).emit('message:edited', {
          messageId: parseInt(id),
          conversationId: msgConv.rows[0].conversation_id,
          body: sanitized,
          editedAt: new Date().toISOString(),
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/chat/conversations/:id/mute — toggle mute
router.patch('/conversations/:id/mute', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { muted } = req.body;
    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    await db.query(
      'UPDATE conversation_participants SET is_muted = $3 WHERE conversation_id = $1 AND user_id = $2',
      [id, req.user.id, !!muted]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/upload-profile-picture — upload user profile picture
router.post('/upload-profile-picture', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    let fileUrl;
    if (USE_CLOUDINARY) {
      const publicId = `profiles/${req.user.id}_${Date.now()}`;
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { public_id: publicId, resource_type: 'image' },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);
        bufferStream.pipe(uploadStream);
      });
      fileUrl = result.secure_url;
    } else {
      const baseUrl = UPLOAD_BASE_URL || `${req.protocol}://${req.get('host')}/uploads`;
      fileUrl = `${baseUrl}/${req.file.filename}`;
    }
    await db.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [fileUrl, req.user.id]);
    res.status(201).json({ url: fileUrl });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/conversations/:id/pinned — get pinned message
router.get('/conversations/:id/pinned', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    const result = await db.query(
      `SELECT m.id, m.body, m.attachment_url, m.attachment_type, m.sender_id, u.name as sender_name, m.created_at
       FROM conversation_participants cp
       JOIN messages m ON m.id = cp.pinned_message_id
       JOIN users u ON u.id = m.sender_id
       WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND m.deleted_at IS NULL`,
      [id, req.user.id]
    );
    res.json({ pinnedMessage: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// PUT /api/chat/conversations/:id/pinned — pin a message (REST fallback)
router.put('/conversations/:id/pinned', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { messageId } = req.body;
    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }
    if (!(await isParticipant(id, req.user.id))) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    await db.query(
      'UPDATE conversation_participants SET pinned_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
      [id, req.user.id, messageId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/chat/last-seen — update user's last seen timestamp (REST fallback)
router.patch('/last-seen', authenticate, async (req, res, next) => {
  try {
    await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/chat/conversations/:id/leave — leave a group conversation
router.delete('/conversations/:id/leave', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const convCheck = await db.query('SELECT type FROM conversations WHERE id = $1', [id]);
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (convCheck.rows[0].type !== 'group') {
      return res.status(400).json({ error: 'Can only leave group conversations' });
    }
    const partCheck = await db.query(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (partCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    await db.query(
      'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
