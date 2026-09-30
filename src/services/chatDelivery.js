const db = require('../db');
const { notify } = require('../utils/notify');
const { sendPushToUsers } = require('../utils/push');
const { extractMentions } = require('../utils/mentions');

function previewFor({ body, attachmentType, meta }) {
  if (meta?.kind === 'todos') {
    const count = meta.items?.length || 0;
    return count === 1 ? `📋 To-do: ${meta.items[0].title}` : `📋 Shared ${count} to-dos${meta.title ? ` · ${meta.title}` : ''}`;
  }
  if (meta?.kind === 'task') return `🗂️ Task: ${meta.task?.title || ''}`;
  if (body) return body.length > 140 ? `${body.slice(0, 137)}…` : body;
  if (attachmentType?.startsWith('image/')) return '📷 Photo';
  if (attachmentType?.startsWith('audio/')) return '🎤 Voice message';
  return '📎 Attachment';
}

async function loadReplyTo(replyToId) {
  if (!replyToId) return null;
  const result = await db.query(
    `SELECT m.id, m.body, m.attachment_url, m.attachment_type, u.name AS sender_name
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.id = $1`,
    [replyToId]
  );
  const r = result.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    body: r.body,
    attachmentUrl: r.attachment_url,
    attachmentType: r.attachment_type,
    senderName: r.sender_name,
  };
}

/**
 * Persist a chat message and fan it out: socket event to the conversation room,
 * list updates to each participant, @mention notifications and device pushes.
 * Used by the socket handler, the REST fallback, forwarding and to-do sharing so
 * every path behaves the same.
 */
async function deliverMessage(io, {
  conversationId,
  sender,
  body = null,
  attachmentUrl = null,
  attachmentType = null,
  replyToId = null,
  meta = null,
}) {
  const convId = Number(conversationId);
  const inserted = await db.query(
    `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type, reply_to_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [convId, sender.id, body, attachmentUrl, attachmentType, replyToId || null, meta]
  );
  const row = inserted.rows[0];
  const replyTo = await loadReplyTo(replyToId);

  const message = {
    id: row.id,
    conversationId: convId,
    senderId: sender.id,
    senderName: sender.name,
    body,
    attachmentUrl,
    attachmentType,
    replyToId: replyToId || null,
    replyTo,
    meta,
    createdAt: row.created_at,
  };

  await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [convId]);
  await db.query('UPDATE conversation_participants SET is_hidden = FALSE WHERE conversation_id = $1', [convId]);

  if (io) io.to(`conv:${convId}`).emit('message:new', message);

  // Fan-out runs after the sender gets their ack; failures here must not fail the send.
  fanOut(io, message).catch((err) => console.error('[chat] fan-out failed:', err.message));
  return message;
}

async function fanOut(io, message) {
  const convResult = await db.query('SELECT id, type, name FROM conversations WHERE id = $1', [message.conversationId]);
  const conversation = convResult.rows[0];
  if (!conversation) return;

  const participants = await db.query(
    `SELECT cp.user_id, cp.is_muted, cp.is_invisible, LOWER(u.username) AS username
     FROM conversation_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id = $1 AND u.status != 'inactive'`,
    [message.conversationId]
  );
  const others = participants.rows.filter((p) => p.user_id !== message.senderId);
  const preview = previewFor(message);

  if (io) {
    for (const p of others) {
      io.to(`user:${p.user_id}`).emit('conversation:updated', {
        conversationId: message.conversationId,
        messageId: message.id,
        lastMessagePreview: preview,
        lastMessageAt: message.createdAt,
      });
    }
  }

  // @mentions (and @all / @everyone in groups) notify even when the chat is muted.
  const mentionNames = new Set(extractMentions(message.body));
  const mentionAll = conversation.type === 'group' && (mentionNames.has('all') || mentionNames.has('everyone'));
  const mentioned = others.filter((p) => mentionAll || mentionNames.has(p.username)).map((p) => p.user_id);
  const where = conversation.type === 'group' ? ` in ${conversation.name || 'a group'}` : '';
  const data = { type: 'chat', conversationId: message.conversationId, tag: `chat-${message.conversationId}` };

  if (mentioned.length) {
    await notify(mentioned, {
      type: 'mention',
      title: `${message.senderName} mentioned you${where}`,
      body: preview,
      data,
    });
  }

  const pushIds = others
    .filter((p) => !p.is_muted && !p.is_invisible && !mentioned.includes(p.user_id))
    .map((p) => p.user_id);
  if (pushIds.length) {
    const title = conversation.type === 'group'
      ? `${message.senderName} · ${conversation.name || 'Group'}`
      : message.senderName;
    await sendPushToUsers(pushIds, title, preview, data);
  }
}

module.exports = { deliverMessage, previewFor };
