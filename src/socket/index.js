const jwt = require('jsonwebtoken');
const db = require('../db');
const { sanitizeText } = require('../middleware/sanitize');
const { deliverMessage } = require('../services/chatDelivery');

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
    // Personal room: conversation list updates, notifications, to-do and task changes.
    socket.join(getUserSocketKey(socket.userId));

    io.emit('presence:update', { userId: socket.userId, online: true });
    socket.emit('presence:snapshot', { userIds: [...presenceMap.keys()] });

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

        const message = await deliverMessage(io, {
          conversationId,
          sender: { id: socket.userId, name: socket.userName },
          body: sanitized,
          attachmentUrl: attachmentUrl || null,
          attachmentType: attachmentType || null,
          replyToId: replyToId || null,
        });

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

    socket.on('edit_message', async (data, ack) => {
      try {
        const { messageId, body } = data || {};
        if (!messageId || !body) {
          if (ack) ack({ error: 'messageId and body are required' });
          return;
        }

        const msgResult = await db.query('SELECT conversation_id, sender_id FROM messages WHERE id = $1 AND deleted_at IS NULL', [messageId]);
        if (msgResult.rows.length === 0) {
          if (ack) ack({ error: 'Message not found' });
          return;
        }
        const { conversation_id: conversationId, sender_id: senderId } = msgResult.rows[0];

        if (senderId !== socket.userId) {
          if (ack) ack({ error: 'Can only edit your own messages' });
          return;
        }

        const sanitized = sanitizeBody(body);
        if (!sanitized) {
          if (ack) ack({ error: 'Body cannot be empty' });
          return;
        }

        await db.query(
          'UPDATE messages SET body = $1, is_edited = TRUE, edited_at = NOW() WHERE id = $2',
          [sanitized, messageId]
        );

        io.to(`conv:${conversationId}`).emit('message:edited', {
          messageId,
          conversationId: Number(conversationId),
          body: sanitized,
          editedAt: new Date().toISOString(),
        });

        if (ack) ack({ ok: true });
      } catch (err) {
        console.error('[socket] edit_message error:', err.message);
        if (ack) ack({ error: 'Failed to edit' });
      }
    });

    socket.on('pin_message', async (data, ack) => {
      try {
        const { conversationId, messageId } = data || {};
        if (!conversationId || !messageId) {
          if (ack) ack({ error: 'conversationId and messageId are required' });
          return;
        }

        if (!(await isParticipant(conversationId, socket.userId))) {
          if (ack) ack({ error: 'Not a participant' });
          return;
        }

        await db.query(
          'UPDATE conversation_participants SET pinned_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, socket.userId, messageId]
        );

        if (ack) ack({ ok: true });
      } catch (err) {
        console.error('[socket] pin_message error:', err.message);
        if (ack) ack({ error: 'Failed to pin' });
      }
    });

    socket.on('forward_message', async (data, ack) => {
      try {
        const { messageId, targetConversationId } = data || {};
        if (!messageId || !targetConversationId) {
          if (ack) ack({ error: 'messageId and targetConversationId are required' });
          return;
        }

        const msgResult = await db.query('SELECT conversation_id, body, attachment_url, attachment_type, meta FROM messages WHERE id = $1 AND deleted_at IS NULL', [messageId]);
        if (msgResult.rows.length === 0) {
          if (ack) ack({ error: 'Message not found' });
          return;
        }
        const msg = msgResult.rows[0];

        if (!(await isParticipant(msg.conversation_id, socket.userId))) {
          if (ack) ack({ error: 'Not a participant in source conversation' });
          return;
        }

        if (!(await isParticipant(targetConversationId, socket.userId))) {
          if (ack) ack({ error: 'Not a participant in target conversation' });
          return;
        }

        const message = await deliverMessage(io, {
          conversationId: targetConversationId,
          sender: { id: socket.userId, name: socket.userName },
          body: msg.body,
          attachmentUrl: msg.attachment_url,
          attachmentType: msg.attachment_type,
          meta: msg.meta,
        });

        if (ack) ack({ ok: true, message });
      } catch (err) {
        console.error('[socket] forward_message error:', err.message);
        if (ack) ack({ error: 'Failed to forward' });
      }
    });

    socket.on('update_last_seen', async () => {
      try {
        await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [socket.userId]);
      } catch (err) {
        console.error('[socket] update_last_seen error:', err.message);
      }
    });

    socket.on('disconnect', () => {
      const stillOnline = removePresence(socket.userId, socket.id);
      if (!stillOnline) {
        db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [socket.userId]).catch(() => {});
        io.emit('presence:update', { userId: socket.userId, online: false });
      }
    });
  });
}

module.exports = { setupSocketIO, isOnline, presenceMap };
