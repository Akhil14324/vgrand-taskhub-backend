const jwt = require('jsonwebtoken');
const db = require('../db');

const presenceMap = new Map();

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
  if (!body) return null;
  const trimmed = String(body).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 5000) return trimmed.slice(0, 5000);
  return trimmed.replace(/<[^>]*>/g, '');
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
        const { conversationId, body, attachmentUrl, attachmentType, clientTempId } = data || {};
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
          `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
          [conversationId, socket.userId, sanitized, attachmentUrl || null, attachmentType || null]
        );

        const msg = result.rows[0];
        const message = {
          id: msg.id,
          conversationId,
          senderId: socket.userId,
          senderName: socket.userName,
          body: sanitized,
          attachmentUrl: attachmentUrl || null,
          attachmentType: attachmentType || null,
          createdAt: msg.created_at,
        };

        await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

        await db.query(
          'UPDATE conversation_participants SET is_hidden = FALSE WHERE conversation_id = $1 AND user_id != $2',
          [conversationId, socket.userId]
        );

        io.to(`conv:${conversationId}`).emit('message:new', message);

        const participantIds = await getParticipantUserIds(conversationId);
        for (const pid of participantIds) {
          if (pid === socket.userId) continue;
          if (!isOnline(pid)) {
            const conv = await db.query(
              `SELECT m.body, m.attachment_url, m.created_at FROM messages m
               WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT 1`,
              [conversationId]
            );
            io.to(getUserSocketKey(pid)).emit('conversation:updated', {
              conversationId,
              lastMessagePreview: conv.rows[0]?.body || '[Attachment]',
              lastMessageAt: msg.created_at,
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

    socket.on('disconnect', () => {
      const stillOnline = removePresence(socket.userId, socket.id);
      if (!stillOnline) {
        io.emit('presence:update', { userId: socket.userId, online: false });
      }
    });
  });
}

module.exports = { setupSocketIO, isOnline, presenceMap };
