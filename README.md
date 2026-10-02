# vgrand-taskhub-backend

Node/Express + PostgreSQL backend for TaskHub — the VGrand group's internal app for to-dos (personal and business), the organisation hierarchy and real-time chat.

## Features

- JWT auth (user, admin, super_admin roles) plus an **organisation hierarchy** (Chairman → Chief of Staff → Directors → business heads → managers/accountants/… → members)
- Business scoping via `user_businesses` (each membership has a `designation`)
- Tasks across businesses: priority, review/approval flow, comments & activity, warnings, overdue alerts, deletion requests that go up the chain of command
- Personal **to-dos** (Todoist-style): lists, due dates/times, reminders, recurrence, @mentions that add the to-do to someone else's list, sharing into chat
- **Real-time chat** (1:1 and group) via Socket.IO, @mentions (and `@all` in groups)
- **Push notifications** through Firebase Cloud Messaging (web/PWA) and Expo (native)

## Setup

```bash
npm install
cp .env.example .env   # edit values
npm run migrate         # run SQL migrations (+ one-time organisation seed)
npm run dev             # start dev server
npm test                # unit tests (node --test)
```

The server also runs pending migrations on startup.

### Organisation seed

On first start (`SEED_ORGANIZATION=true`, default) `src/seed/organization.js` creates the four businesses (VGrand Family Restaurant, VGrand Infra, VTech, BVL Mines & Minerals) and the people:

| Username | Name | Position |
|---|---|---|
| `vinod` | T Vinod Kumar | Chairman (level 1, super admin) |
| `kaushal` | Kaushal | Chief of Staff (level 2) + Head of VTech |
| `akhil` | V Akhil | Director (level 3) |
| `varun` | N Varun Kumar | Director (level 3) |
| `chandrasekhar` | Chandrasekhar | Head, VGrand Family Restaurant |
| `srinivas` | Srinivas | Head, BVL Mines & Minerals |
| `nagarjuna` | Nagarjuna | Head, VGrand Infra |
| `ashok` | Ashok Kumar | Head, VGrand Infra |

New accounts get `SEED_DEFAULT_PASSWORD` and must change it on first login. An existing account with the same username is placed in the hierarchy instead (its password is untouched). Existing businesses whose names match are reused. The seed runs once (marker `seed:organization-v1` in the `migrations` table); afterwards everything is managed from the app's Organisation screen.

### Chain of command

Levels (lower = more senior): `0` system owner (`Superadmin` account), `1` Chairman, `2` Chief of Staff, `3` Director, `4` Head, `5` Manager, `6` Accountant / Supervisor / Coordinator, `7` Member, `8` Intern. A person's level inside a business is the most senior of their leadership tier and their designation there. See `src/utils/org.js`.

- Only someone **strictly more senior** can manage, delete, reset the password of, or change the role of another person.
- The Organisation portal (`/api/org/people…`) is for levels ≤ 2 (Chairman, Chief of Staff). Heads/managers can add people junior to them to their own business.
- Tasks: the creator or anyone senior to the creator can edit/delete; others can **request deletion**, which goes to the creator and the next tier up. Tasks with "review before closing" go to `in_review` when the assignee finishes; the creator or anyone senior to the finisher approves or requests changes.

### Environment variables

See `.env.example`. Notable ones:

| Variable | Description |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Pooled / direct Postgres URLs (migrations use the direct one) |
| `DATABASE_SSL` | `true`/`false` to force TLS; auto-on for Render, Supabase, Railway, Neon |
| `CLIENT_URL` | Comma-separated allowed origins (your PWA URL) or `*` |
| `APP_TIMEZONE` | Timezone for "today" and to-do reminders (default `Asia/Kolkata`) |
| `FIREBASE_SERVICE_ACCOUNT` | Service-account JSON (raw or base64) for FCM — or use `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |
| `SEED_ORGANIZATION`, `SEED_DEFAULT_PASSWORD` | One-time organisation seed |
| `UPLOAD_DIR`, `UPLOAD_MAX_SIZE`, `UPLOAD_BASE_URL`, `CLOUDINARY_*` | Chat attachments |

## Notifications

`src/utils/notify.js` → `notify(userIds, { type, title, body, data })` stores an in-app notification, emits `notification:new` to each user's socket room and sends a push. `src/utils/push.js` sends **data-only** FCM messages to web tokens (the PWA service worker decides whether to show a system notification or an in-app banner) and Expo pushes to native tokens. Chat messages push without being stored; @mentions are stored and push even when a chat is muted.

`data` carries deep-link ids: `conversationId`, `todoId`, `approvalId`.

Jobs: `jobs/overdueNotifications.js` (daily) and `jobs/todoReminders.js` (every minute, for to-dos with a due time).

## Socket.IO Event Contract

Each socket joins `user:<id>` (personal room) on connect and `conv:<id>` rooms via `join_conversations`.

**Client emits:**
- `join_conversations` — `{ conversationIds: number[] }`
- `send_message` — `{ conversationId, body?, attachmentUrl?, attachmentType?, clientTempId?, replyToId? }` (ack callback)
- `typing_start` / `typing_stop` — `{ conversationId }`
- `mark_read` — `{ conversationId, messageId }`
- `react_to_message` — `{ messageId, emoji }` (ack)
- `edit_message` — `{ messageId, body }` (ack)
- `pin_message` — `{ conversationId, messageId }` (ack)
- `forward_message` — `{ messageId, targetConversationId }` (ack)
- `update_last_seen`

**Server emits:**
- `message:new` — `{ id, conversationId, senderId, senderName, body, attachmentUrl, attachmentType, replyToId, replyTo, meta, createdAt }` (`meta.kind === 'todos'` for shared to-do cards)
- `message:read` — `{ conversationId, userId, lastReadMessageId }`
- `message:reaction`, `message:edited`, `message:deleted`, `conversation:deleted`
- `typing:update` — `{ conversationId, userId, userName, typing }`
- `presence:update` — `{ userId, online }`; `presence:snapshot` — `{ userIds }` sent on connect
- `conversation:updated` — `{ conversationId, messageId, lastMessagePreview, lastMessageAt }` (personal room)
- `notification:new` — the stored notification row (personal room)
- `todo:changed` — `{ todoId, action }` (personal rooms of everyone who can see the to-do: its members and, for a business to-do, the whole business and leadership)

## REST Endpoints

### Chat (`/api/chat`)

| Method | Path | Description |
|---|---|---|
| GET | `/users` | Everyone you can start a chat with (all active colleagues) |
| GET | `/conversations` | Your conversations with unread counts |
| POST | `/conversations` | Create direct or group conversation |
| GET | `/conversations/:id/messages` | Paginated history (`?before=<id>` or `?after=<id>`) |
| POST | `/conversations/:id/messages` | REST fallback send (same fan-out as the socket) |
| PATCH | `/conversations/:id/read` | Mark read up to message ID |
| POST | `/upload` | Upload image/file attachment |

### To-dos and business tasks (`/api/todos`)

There is one kind of item. A **to-do** with no `business_id` is personal (visible to the people on it, `todo_members`). A **business task** is a to-do with a `business_id`: everyone in that business sees it, leadership sees every business, and permissions follow the chain of command (`src/services/todoAccess.js`). Every response carries server-computed `permissions` flags (`can_edit`, `can_delete`, `can_change_status`, `can_assign`, `can_approve`, `can_review`, `can_warn`, `can_request_delete`, `can_add_subtask`, `can_comment`); clients never re-derive them.

Statuses: `todo` · `in_progress` · `blocked` · `in_review` · `on_hold` · `done`. Sub-tasks nest to 8 levels; each has its own description (`notes`) and comments.

| Method | Path | Description |
|---|---|---|
| GET | `/` | My lists, sections, filters, the to-dos I can see (open, plus finished recently) and the businesses I belong to |
| GET | `/:id` | One to-do I can see, with its direct sub-tasks |
| POST | `/` | Create `{ title, notes, due_date, due_time, priority, list_id, section_id, recurrence, labels, parent_id, business_id, assign_to, requires_approval, mention_ids }`. With `business_id`: set directly by someone who manages the business, otherwise stored as a *proposal* (`review_state = 'proposed'`) |
| PUT | `/:id` | Edit (needs `can_edit`); `list_id`/`section_id` move it in *my* lists only; `assigned_user_id` reassigns a business task |
| POST | `/:id/toggle` | Tick / untick. Recurring ones roll to the next date; business work that needs review goes `in_review` instead of closing |
| POST | `/:id/status` | `todo` · `in_progress` · `on_hold` (done and in review go through toggle, blocked through blockers) |
| POST | `/:id/review` | `{ decision: accept|reject, note }` decide on a proposed business task |
| POST | `/:id/approve`, `/:id/reject` | Review finished work (`note`) |
| POST | `/:id/warn` | `{ message }` warn the assignee (must be senior) |
| POST | `/:id/request-delete` | `{ reason }` ask the chain of command to delete |
| DELETE | `/:id` | Personal: the creator deletes for everyone, others leave. Business: whoever set it, or a senior |
| POST | `/:id/assign`, `/:id/updates`, `/:id/blockers` | Accountable person, progress checkpoint, blockers (see `routes/todoTimeline.js`) |
| GET | `/:id/timeline` | History, comments, blockers and the numbers of one to-do |
| GET | `/gantt?business_id=&scope=mine&assignee_id=&from=&to=` | Rows for the timeline chart: each to-do with the stretches it spent in one status with one person |
| GET | `/assignees?business_id=` | People business work in that business can be given to |
| GET/POST | `/:id/comments` | Comments (separate from the description) |
| POST | `/board-order` | `{ ids }` my own order of cards on a board |
| GET | `/completed`, `/insights` | Completion history, 7-day counts and streak |
| POST | `/share` | `{ conversation_ids, todo_ids, title?, note? }` checklist card in chat |
| POST | `/import`, `/reorder`, `/:id/duplicate` | Copy shared items, manual order, duplicate (personal) |
| POST/PUT/DELETE | `/lists`, `/sections`, `/filters` | Lists, sections and saved filters |
| POST | `/:id/move-to-business` | `{ business_id, assign_to? }` turn my personal to-do (and its sub-tasks) into a business task; a manager's is accepted, anyone else's becomes a proposal |
| POST | `/sections` | `{ name }` a section of my Inbox (list sections use `/lists/:id/sections`) |

The Team Monitor (`/api/monitor`) follows the hierarchy: leadership sees people strictly below them, business heads those below them in their business; nobody sees upward.

### Approvals (`/api/approvals`)

`GET /` → `{ requests, reviews, proposals, mine, count }`: deletion requests, finished work and proposed tasks waiting on you, and your own requests · `POST /:id/decide` `{ decision: approve|reject, note }` · `DELETE /:id` (withdraw).

### Organisation (`/api/org`)

`GET /structure` (org chart, everyone) · `GET /directory?q=` (people for @mentions/pickers) · `GET /catalog` · portal only: `GET/POST /people`, `PUT /people/:id`, `PUT /people/:id/password`, `DELETE /people/:id` · `PUT/DELETE /businesses/:id/members/:userId` (portal, or heads/managers for people junior to them).

### Notifications (`/api/notifications`)

`GET /` · `GET /unread-count` · `PUT /:id/read` · `PUT /read-all` · `DELETE /read` · `POST /push-token` `{ token, platform, provider: fcm|expo }` · `DELETE /push-token` · `GET /push-status` · `POST /test`.

## Migrations

SQL files in `src/migrations/` run in filename order and are tracked in the `migrations` table. `027_org_todos_approvals.sql` adds the hierarchy columns, task workflow, approvals, to-dos, notification data and FCM token support. `030_unify_tasks_into_todos.sql` makes a task a to-do that belongs to a business: it adds the business, review, approval and warning columns to `todos` and **copies** existing tasks (with their comments, history, warnings, approvals, notifications and chat cards) into it. The old `tasks` and `task_activity` tables are left in place, unused, and can be dropped by a later migration once you are happy with the copy. `031_todo_board_order.sql` stores each person's own board ordering. `032_inbox_sections.sql` lets a section belong to a person (`owner_id`) instead of a list, so the Inbox can have sections.
