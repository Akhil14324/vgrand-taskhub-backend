const jwt = require('jsonwebtoken');
const db = require('../db');
const { sanitizeText } = require('../middleware/sanitize');
const { sendPushToUser } = require('../utils/push');

const presenceMap = new Map();

const rateLimitMap = new Map();

function checkRateLimit(userId, event, maxCount, windowMs) {
  const key = `${userId}:${event}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= maxCount;
}

function getUserSocketKey(userId) {
  return `user:${userId}`;
}

async function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const result = await db.query(
    'SELECT id, role, status, name FROM users WHERE id = $1',
    [decoded.id]
  );
  if (result.rows.length === 0) return null;
  const user = result.rows[0];
  if (user.status === 'inactive') return null;
  return user;
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

function addPresence(userId, socketId) {
  if (!presenceMap.has(userId)) {
    presenceMap.set(userId, new Set());
  }
  presenceMap.get(userId).add(socketId);
}

function removePresence(userId, socketId) {
  const set = presenceMap.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) {
      presenceMap.delete(userId);
      return false;
    }
  }
  return true;
}

function isOnline(userId) {
  return presenceMap.has(userId);
}

function sanitizeBody(body) {
  return sanitizeText(body, 5000) || null;
}

function setupSocketIO(io) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('No token provided'));
    }
    try {
      const user = await verifyToken(token);
      if (!user) {
        return next(new Error('Invalid or expired token'));
      }
      socket.userId = user.id;
      socket.userName = user.name;
      socket.userRole = user.role;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    addPresence(socket.userId, socket.id);

    io.emit('presence:update', { userId: socket.userId, online: true });

    socket.on('join_conversations', async (data) => {
      try {
        const { conversationIds } = data || {};
        if (!Array.isArray(conversationIds)) return;
        for (const cid of conversationIds) {
          if (await isParticipant(cid, socket.userId)) {
            socket.join(`conv:${cid}`);
          }
        }
      } catch (err) {
        console.error('[socket] join_conversations error:', err.message);
      }
    });

    socket.on('send_message', async (data, ack) => {
      try {
        if (!checkRateLimit(socket.userId, 'send_message', 30, 10000)) {
          if (ack) ack({ error: 'Rate limit exceeded' });
          return;
        }
        const { conversationId, body, attachmentUrl, attachmentType, clientTempId, replyToId } = data || {};
        if (!conversationId) {
          if (ack) ack({ error: 'conversationId is required' });
          return;
        }
        if (!(await isParticipant(conversationId, socket.userId))) {
          if (ack) ack({ error: 'Not a participant' });
          return;
        }

        const sanitized = sanitizeBody(body);
        if (!sanitized && !attachmentUrl) {
          if (ack) ack({ error: 'Message body or attachment is required' });
          return;
        }

        const result = await db.query(
          `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type, reply_to_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
          [conversationId, socket.userId, sanitized, attachmentUrl || null, attachmentType || null, replyToId || null]
        );

        const msg = result.rows[0];

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
          conversationId,
          senderId: socket.userId,
          senderName: socket.userName,
          body: sanitized,
          attachmentUrl: attachmentUrl || null,
          attachmentType: attachmentType || null,
          replyToId: replyToId || null,
          replyTo,
          createdAt: msg.created_at,
        };

        await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

        await db.query(
          'UPDATE conversation_participants SET is_hidden = FALSE WHERE conversation_id = $1',
          [conversationId]
        );

        io.to(`conv:${conversationId}`).emit('message:new', message);

        const participantIds = await getParticipantUserIds(conversationId);
        const offlineParticipantIds = [];
        for (const pid of participantIds) {
          if (pid === socket.userId) continue;
          const conv = await db.query(
            `SELECT m.body, m.attachment_url, m.created_at FROM messages m
             LEFT JOIN message_deletions md ON md.message_id = m.id AND md.user_id = $2
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND md.message_id IS NULL
             ORDER BY m.created_at DESC LIMIT 1`,
            [conversationId, pid]
          );
          io.to(getUserSocketKey(pid)).emit('conversation:updated', {
            conversationId,
            lastMessagePreview: conv.rows[0]?.body || '[Attachment]',
            lastMessageAt: conv.rows[0]?.created_at || msg.created_at,
          });

          if (!isOnline(pid)) {
            offlineParticipantIds.push(pid);
          }
        }

        if (offlineParticipantIds.length > 0) {
          const pushBody = sanitized ? sanitized : '[Attachment]';
          for (const pid of offlineParticipantIds) {
            sendPushToUser(pid, socket.userName, pushBody, {
              type: 'chat',
              conversationId: Number(conversationId),
            });
          }
        }

        if (ack) ack({ message, clientTempId });
      } catch (err) {
        console.error('[socket] send_message error:', err.message);
        if (ack) ack({ error: 'Failed to send message' });
      }
    });

    socket.on('typing_start', async (data) => {
      try {
        if (!checkRateLimit(socket.userId, 'typing', 20, 10000)) return;
        const { conversationId } = data || {};
        if (!conversationId) return;
        if (!(await isParticipant(conversationId, socket.userId))) return;
        socket.to(`conv:${conversationId}`).emit('typing:update', {
          conversationId,
          userId: socket.userId,
          userName: socket.userName,
          typing: true,
        });
      } catch (err) {
        console.error('[socket] typing_start error:', err.message);
      }
    });

    socket.on('typing_stop', async (data) => {
      try {
        const { conversationId } = data || {};
        if (!conversationId) return;
        socket.to(`conv:${conversationId}`).emit('typing:update', {
          conversationId,
          userId: socket.userId,
          userName: socket.userName,
          typing: false,
        });
      } catch (err) {
        console.error('[socket] typing_stop error:', err.message);
      }
    });

    socket.on('mark_read', async (data) => {
      try {
        const { conversationId, messageId } = data || {};
        if (!conversationId || !messageId) return;
        if (!(await isParticipant(conversationId, socket.userId))) return;

        await db.query(
          `UPDATE conversation_participants
           SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3)
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, socket.userId, parseInt(messageId)]
        );

        socket.to(`conv:${conversationId}`).emit('message:read', {
          conversationId,
          userId: socket.userId,
          lastReadMessageId: parseInt(messageId),
        });
      } catch (err) {
        console.error('[socket] mark_read error:', err.message);
      }
    });

    socket.on('react_to_message', async (data, ack) => {
      try {
        const { messageId, emoji } = data || {};
        if (!messageId || !emoji) {
          if (ack) ack({ error: 'messageId and emoji are required' });
          return;
        }

        const msgResult = await db.query('SELECT conversation_id FROM messages WHERE id = $1', [messageId]);
        if (msgResult.rows.length === 0) {
          if (ack) ack({ error: 'Message not found' });
          return;
        }
        const conversationId = msgResult.rows[0].conversation_id;

        if (!(await isParticipant(conversationId, socket.userId))) {
          if (ack) ack({ error: 'Not a participant' });
          return;
        }

        const existing = await db.query(
          'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
          [messageId, socket.userId, emoji]
        );

        if (existing.rows.length > 0) {
          await db.query('DELETE FROM message_reactions WHERE id = $1', [existing.rows[0].id]);
        } else {
          await db.query(
            'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
            [messageId, socket.userId, emoji]
          );
        }

        const reactionsResult = await db.query(
          `SELECT emoji, json_agg(json_build_object('userId', user_id, 'userName', u.name)) as users
           FROM message_reactions mr JOIN users u ON u.id = mr.user_id
           WHERE mr.message_id = $1 GROUP BY emoji`,
          [messageId]
        );
        const reactions = {};
        reactionsResult.rows.forEach((r) => {
          reactions[r.emoji] = r.users;
        });

        io.to(`conv:${conversationId}`).emit('message:reaction', {
          messageId,
          conversationId,
          reactions,
        });

        if (ack) ack({ ok: true, reactions });
      } catch (err) {
        console.error('[socket] react_to_message error:', err.message);
        if (ack) ack({ error: 'Failed to react' });
      }
    });

    socket.on('disconnect', () => {
      const stillOnline = removePresence(socket.userId, socket.id);
      if (!stillOnline) {
        io.emit('presence:update', { userId: socket.userId, online: false });
      }
    });
  });
}

module.exports = { setupSocketIO, isOnline, presenceMap };
