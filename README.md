# vgrand-taskhub-backend

Node/Express + PostgreSQL backend for TaskHub — multi-business task monitoring with real-time chat.

## Features

- JWT auth (user, admin, super_admin roles)
- Business scoping (users assigned to one or more businesses via `user_businesses`)
- Task CRUD with warnings, overdue notifications
- **Real-time chat** (1:1 and group) via Socket.IO
- File/image upload for chat attachments (multer, local disk)

## Setup

```bash
npm install
cp .env.example .env   # edit values
npm run migrate         # run SQL migrations
npm run dev             # start dev server
```

## Chat Feature

### Dependencies

- `socket.io` — WebSocket server for real-time messaging
- `multer` — file upload middleware for chat attachments

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `UPLOAD_DIR` | Local directory for uploaded files | `./uploads` |
| `UPLOAD_MAX_SIZE` | Max upload size in bytes | `5242880` (5MB) |
| `UPLOAD_BASE_URL` | Base URL for serving uploaded files (e.g. CDN) | Auto-derived from request |

### Socket.IO Event Contract

**Client emits:**
- `join_conversations` — `{ conversationIds: number[] }`
- `send_message` — `{ conversationId, body?, attachmentUrl?, attachmentType?, clientTempId? }` (ack callback)
- `typing_start` / `typing_stop` — `{ conversationId }`
- `mark_read` — `{ conversationId, messageId }`

**Server emits:**
- `message:new` — `{ id, conversationId, senderId, senderName, body, attachmentUrl, attachmentType, createdAt }`
- `message:read` — `{ conversationId, userId, lastReadMessageId }`
- `typing:update` — `{ conversationId, userId, userName, typing }`
- `presence:update` — `{ userId, online }`
- `conversation:updated` — `{ conversationId, lastMessagePreview, lastMessageAt }`

### REST Endpoints (`/api/chat`)

| Method | Path | Description |
|---|---|---|
| GET | `/conversations` | List user's conversations with unread counts |
| POST | `/conversations` | Create direct or group conversation |
| GET | `/conversations/:id/messages` | Paginated message history (`?before=<id>` or `?after=<id>`) |
| POST | `/conversations/:id/messages` | REST fallback send |
| PATCH | `/conversations/:id/read` | Mark read up to message ID |
| POST | `/upload` | Upload image/file attachment |

### Migration

Run `npm run migrate` to apply `010_create_chat_tables.sql` which creates:
- `conversations` — direct or group chats
- `conversation_participants` — junction with `last_read_message_id` for read tracking
- `messages` — text + attachment support, soft delete