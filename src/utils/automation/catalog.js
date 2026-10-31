/**
 * What automations can listen for (contexts) and do (actions). The mobile app draws its forms from
 * GET /api/automation/catalog, which serves this file, so a new action is added here once and the
 * editor shows it. Field types the editor understands:
 *   text, textarea, number, select{options}, bool, time (HH:MM), days (weekday picker), date (YYYY-MM-DD),
 *   person, business, task, priority, status, label, cond (the three-box comparison), expr (advanced).
 * Text fields may contain %variables; fields marked `raw` are not interpolated (they are expressions).
 */
const { CMP_OPS, evaluate, ExprError } = require('./expr');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

const PRIORITIES = [
  { value: '1', label: 'Urgent' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Medium' },
  { value: '4', label: 'Low' },
];
const STATUSES = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold', label: 'On hold' },
];
const SCOPES = [
  { value: 'any', label: 'Any to-do I can see' },
  { value: 'mine', label: 'Only mine' },
  { value: 'business', label: 'Only in one business' },
  { value: 'board', label: 'Only on one board' },
];

const TODO_FILTERS = [
  { key: 'scope', type: 'select', label: 'Which to-dos', options: SCOPES, default: 'any' },
  { key: 'business_id', type: 'business', label: 'Business', showWhen: { key: 'scope', is: 'business' } },
  { key: 'board_id', type: 'board', label: 'Board', showWhen: { key: 'scope', is: 'board' } },
  { key: 'text', type: 'text', label: 'Title contains (optional)', placeholder: 'invoice' },
  { key: 'label', type: 'label', label: 'Has label (optional)', placeholder: 'finance' },
];

const DAY_FIELD = { key: 'days', type: 'days', label: 'On these days', default: [1, 2, 3, 4, 5] };

const TODO_VARS = ['todo_id', 'todo_title', 'todo_notes', 'todo_status', 'todo_priority', 'todo_due', 'todo_deadline', 'todo_labels', 'todo_business', 'todo_business_id', 'todo_assignee', 'todo_by'];

const CONTEXTS = Object.assign(Object.create(null), {
  // ---- events: a moment in time. They run the task once each time they happen.
  time_at: {
    kind: 'event', group: 'Time', icon: 'alarm-outline', label: 'At a time of day',
    hint: 'Runs once at the time you choose, on the days you choose',
    fields: [{ key: 'at', type: 'time', label: 'At', default: '09:00' }, DAY_FIELD],
    vars: [],
  },
  interval: {
    kind: 'event', group: 'Time', icon: 'repeat-outline', label: 'Every so often',
    hint: 'Runs again and again, for example every 30 minutes during work hours',
    fields: [
      { key: 'every', type: 'number', label: 'Every (minutes, 5 or more)', default: 30, min: 5, max: 1440 },
      { key: 'from', type: 'time', label: 'Only from (optional)', optional: true },
      { key: 'to', type: 'time', label: 'Only until (optional)', optional: true },
      DAY_FIELD,
    ],
    vars: [],
  },
  date_on: {
    kind: 'event', group: 'Time', icon: 'calendar-outline', label: 'On a date',
    hint: 'Runs once, on one day',
    fields: [{ key: 'date', type: 'date', label: 'Date' }, { key: 'at', type: 'time', label: 'At', default: '09:00' }],
    vars: [],
  },
  todo_created: {
    kind: 'event', group: 'To-dos', icon: 'add-circle-outline', label: 'A to-do is added',
    hint: 'When a to-do or business task appears for you', fields: TODO_FILTERS, vars: TODO_VARS,
  },
  todo_completed: {
    kind: 'event', group: 'To-dos', icon: 'checkmark-circle-outline', label: 'A to-do is finished',
    hint: 'When anything you can see is ticked off', fields: TODO_FILTERS, vars: TODO_VARS,
  },
  todo_reopened: {
    kind: 'event', group: 'To-dos', icon: 'refresh-circle-outline', label: 'A to-do is reopened',
    hint: 'When a finished to-do is brought back', fields: TODO_FILTERS, vars: TODO_VARS,
  },
  todo_status: {
    kind: 'event', group: 'To-dos', icon: 'swap-horizontal-outline', label: 'A status changes',
    hint: 'When a to-do moves to another status',
    fields: [{ key: 'to', type: 'select', label: 'Changes to', options: [{ value: 'any', label: 'Anything' }, ...STATUSES, { value: 'blocked', label: 'Blocked' }, { value: 'in_review', label: 'In review' }], default: 'any' }, ...TODO_FILTERS],
    vars: [...TODO_VARS, 'status_from', 'status_to'],
  },
  todo_assigned: {
    kind: 'event', group: 'To-dos', icon: 'person-add-outline', label: 'A to-do is given to me',
    hint: 'When somebody makes you accountable for something',
    fields: TODO_FILTERS.filter((f) => f.key !== 'scope'), vars: TODO_VARS,
  },
  todo_priority: {
    kind: 'event', group: 'To-dos', icon: 'flag-outline', label: 'Priority changes',
    hint: 'When the priority of a to-do is changed',
    fields: [{ key: 'to', type: 'select', label: 'Changes to', options: [{ value: 'any', label: 'Anything' }, ...PRIORITIES], default: 'any' }, ...TODO_FILTERS],
    vars: TODO_VARS,
  },
  todo_due_changed: {
    kind: 'event', group: 'To-dos', icon: 'calendar-number-outline', label: 'A due date or deadline changes',
    hint: 'When a to-do is moved to another day', fields: TODO_FILTERS, vars: TODO_VARS,
  },
  todo_commented: {
    kind: 'event', group: 'To-dos', icon: 'chatbubble-ellipses-outline', label: 'Someone comments',
    hint: 'When a new comment lands on a to-do', fields: TODO_FILTERS, vars: [...TODO_VARS, 'comment_text', 'comment_by'],
  },
  todo_changed: {
    kind: 'event', group: 'To-dos', icon: 'create-outline', label: 'A to-do changes in any way',
    hint: 'Edits, status moves, assignments, warnings. Busy: add filters', fields: TODO_FILTERS, vars: [...TODO_VARS, 'change_kind'],
  },
  notification: {
    kind: 'event', group: 'Messages', icon: 'notifications-outline', label: 'I get a notification',
    hint: 'Any in-app notification, such as being mentioned or asked for an update',
    fields: [
      { key: 'ntype', type: 'select', label: 'Kind', default: 'any', options: [
        { value: 'any', label: 'Any' }, { value: 'mention', label: 'Chat mention' }, { value: 'todo_assigned', label: 'To-do assigned' },
        { value: 'todo_reminder', label: 'Reminder' }, { value: 'todo_deadline', label: 'Deadline today' }, { value: 'todo_nudge', label: 'Bell' },
        { value: 'todo_mention', label: 'Mentioned on a to-do' }, { value: 'todo_proposed', label: 'Task proposed' }, { value: 'kudos', label: 'Kudos' },
      ] },
      { key: 'text', type: 'text', label: 'Text contains (optional)' },
    ],
    vars: ['notification_type', 'notification_title', 'notification_text'],
  },
  chat_message: {
    kind: 'event', group: 'Messages', icon: 'chatbubble-outline', label: 'A chat message arrives',
    hint: 'A message from somebody else in any chat you are in',
    fields: [
      { key: 'from', type: 'person', label: 'From (optional)', optional: true },
      { key: 'text', type: 'text', label: 'Message contains (optional)' },
    ],
    vars: ['message_text', 'message_from', 'message_from_id', 'conversation_id'],
  },
  app_opened: {
    kind: 'event', group: 'Device', icon: 'phone-portrait-outline', label: 'TaskHub is opened',
    hint: 'Each time you open the app (not when you switch tabs back)', fields: [], vars: [],
  },
  webhook: {
    kind: 'event', group: 'Web', icon: 'link-outline', label: 'A web link is called',
    hint: 'Gets its own secret link. Anything that can call a URL (a form, a Zap, another app) can start it',
    fields: [], vars: ['hook_body', 'hook_json', 'hook_query'],
  },
  // ---- states: true or false right now. The profile is "active" while all (or any) of them hold.
  time_range: {
    kind: 'state', group: 'Time', icon: 'time-outline', label: 'Between two times',
    hint: 'Active from the first time to the second, on the days you choose',
    fields: [{ key: 'from', type: 'time', label: 'From', default: '09:00' }, { key: 'to', type: 'time', label: 'Until', default: '18:00' }, DAY_FIELD],
  },
  overdue_count: {
    kind: 'state', group: 'To-dos', icon: 'alert-circle-outline', label: 'I have overdue work',
    hint: 'Active while you have at least this many overdue to-dos',
    fields: [{ key: 'min', type: 'number', label: 'At least', default: 3, min: 1, max: 500 }],
  },
  open_today_count: {
    kind: 'state', group: 'To-dos', icon: 'list-outline', label: 'My day is full or empty',
    hint: 'Active while the number of to-dos due today is above or below a number',
    fields: [
      { key: 'cmp', type: 'select', label: 'The count is', options: [{ value: 'ge', label: 'at least' }, { value: 'le', label: 'at most' }], default: 'ge' },
      { key: 'n', type: 'number', label: 'Number', default: 5, min: 0, max: 500 },
    ],
  },
  app_open: {
    kind: 'state', group: 'Device', icon: 'eye-outline', label: 'TaskHub is open',
    hint: 'Active while the app is open on any of your devices',
    fields: [{ key: 'is', type: 'select', label: 'The app is', options: [{ value: 'open', label: 'open' }, { value: 'closed', label: 'closed' }], default: 'open' }],
  },
  battery: {
    kind: 'state', group: 'Device', icon: 'battery-half-outline', label: 'Battery level',
    hint: 'Needs the app to be open (browsers only share the battery with open pages)',
    device: true,
    fields: [
      { key: 'cmp', type: 'select', label: 'Battery is', options: [{ value: 'le', label: 'at most' }, { value: 'ge', label: 'at least' }], default: 'le' },
      { key: 'percent', type: 'number', label: 'Percent', default: 20, min: 1, max: 100 },
      { key: 'charging', type: 'select', label: 'And it is', options: [{ value: 'any', label: 'charging or not' }, { value: 'no', label: 'not charging' }, { value: 'yes', label: 'charging' }], default: 'any' },
    ],
  },
  place: {
    kind: 'state', group: 'Device', icon: 'location-outline', label: 'At a place',
    hint: 'Active while you are near a spot. Needs location permission and the app open',
    device: true, sensor: 'location',
    fields: [
      { key: 'lat', type: 'number', label: 'Latitude', decimals: true, min: -90, max: 90 },
      { key: 'lon', type: 'number', label: 'Longitude', decimals: true, min: -180, max: 180 },
      { key: 'radius', type: 'number', label: 'Radius (metres)', default: 150, min: 50, max: 20000 },
      { key: 'is', type: 'select', label: 'I am', options: [{ value: 'inside', label: 'inside' }, { value: 'outside', label: 'outside' }], default: 'inside' },
    ],
  },
  variable: {
    kind: 'state', group: 'Variables', icon: 'code-outline', label: 'A variable has a value',
    hint: 'Active while one of your global variables (like %MODE) matches',
    fields: [{ key: 'cond', type: 'cond', label: 'When', default: { left: '%MODE', op: 'eq', right: 'work' } }],
  },
});

// ---- actions ---------------------------------------------------------------------------------------

const TODO_TARGET = { key: 'todo', type: 'text', label: 'Which to-do (number)', default: '%todo_id', hint: 'The one that started this, unless you pick another' };

const ACTIONS = Object.assign(Object.create(null), {
  // flow
  if: { group: 'Flow', icon: 'git-branch-outline', label: 'If', opens: 'if', fields: [{ key: 'cond', type: 'cond', label: 'Condition' }] },
  elseif: { group: 'Flow', icon: 'git-compare-outline', label: 'Else if', continues: 'if', fields: [{ key: 'cond', type: 'cond', label: 'Condition' }] },
  else: { group: 'Flow', icon: 'git-merge-outline', label: 'Else', continues: 'if', fields: [] },
  end_if: { group: 'Flow', icon: 'return-down-forward-outline', label: 'End if', closes: 'if', fields: [] },
  for: {
    group: 'Flow', icon: 'repeat-outline', label: 'Repeat', opens: 'for',
    hint: 'Do the actions inside again and again',
    fields: [
      { key: 'mode', type: 'select', label: 'Repeat', options: [{ value: 'count', label: 'a number of times' }, { value: 'each', label: 'for each item in a list' }], default: 'count' },
      { key: 'times', type: 'text', label: 'How many times', default: '3', showWhen: { key: 'mode', is: 'count' } },
      { key: 'list', type: 'text', label: 'List (a variable such as %found)', showWhen: { key: 'mode', is: 'each' } },
      { key: 'var', type: 'text', label: 'Call each one', default: 'item', hint: 'Use it as %item inside. %item_index is its number' },
    ],
  },
  end_for: { group: 'Flow', icon: 'return-down-back-outline', label: 'End repeat', closes: 'for', fields: [] },
  break: { group: 'Flow', icon: 'exit-outline', label: 'Leave the repeat', fields: [] },
  stop: { group: 'Flow', icon: 'stop-circle-outline', label: 'Stop', hint: 'Ends this task here', fields: [] },
  wait: { group: 'Flow', icon: 'hourglass-outline', label: 'Wait', hint: 'Up to 60 seconds', fields: [{ key: 'seconds', type: 'number', label: 'Seconds', default: 5, min: 1, max: 60 }] },
  label: { group: 'Flow', icon: 'bookmark-outline', label: 'Label', hint: 'A place to jump to', fields: [{ key: 'name', type: 'text', label: 'Name', raw: true }] },
  goto: { group: 'Flow', icon: 'arrow-redo-outline', label: 'Jump to label', fields: [{ key: 'name', type: 'text', label: 'Label name', raw: true }] },
  perform_task: {
    group: 'Flow', icon: 'play-forward-outline', label: 'Run another task',
    fields: [
      { key: 'task_id', type: 'task', label: 'Task' },
      { key: 'par1', type: 'text', label: 'Give it a value (%par1)', optional: true },
      { key: 'par2', type: 'text', label: 'And another (%par2)', optional: true },
      { key: 'into', type: 'text', label: 'Keep its answer in', optional: true, hint: 'The other task can end with "Return"' },
    ],
  },
  return: { group: 'Flow', icon: 'arrow-undo-outline', label: 'Return a value', hint: 'Ends this task and hands a value back', fields: [{ key: 'value', type: 'text', label: 'Value' }] },
  // variables
  set_var: {
    group: 'Variables', icon: 'pricetag-outline', label: 'Set a variable',
    hint: 'A name in CAPITALS is remembered for good (global); small letters live for this run only',
    fields: [
      { key: 'name', type: 'text', label: 'Name', raw: true, placeholder: 'count' },
      { key: 'value', type: 'text', label: 'Value', placeholder: '%count + 1' },
      { key: 'calculate', type: 'bool', label: 'Calculate it (maths, text functions)', default: false },
    ],
  },
  clear_var: { group: 'Variables', icon: 'close-circle-outline', label: 'Clear a variable', fields: [{ key: 'name', type: 'text', label: 'Name', raw: true }] },
  var_split: {
    group: 'Variables', icon: 'cut-outline', label: 'Split into a list',
    fields: [{ key: 'name', type: 'text', label: 'List name', raw: true }, { key: 'from', type: 'text', label: 'Text to split' }, { key: 'sep', type: 'text', label: 'Split at', default: ',' }],
  },
  var_join: {
    group: 'Variables', icon: 'link-outline', label: 'Join a list into text',
    fields: [{ key: 'name', type: 'text', label: 'Put the text in', raw: true }, { key: 'list', type: 'text', label: 'List (such as %found)' }, { key: 'sep', type: 'text', label: 'Between items', default: ', ' }],
  },
  var_replace: {
    group: 'Variables', icon: 'swap-horizontal-outline', label: 'Find and replace',
    fields: [
      { key: 'name', type: 'text', label: 'Variable to change', raw: true },
      { key: 'find', type: 'text', label: 'Find' }, { key: 'replace', type: 'text', label: 'Replace with', optional: true },
      { key: 'regex', type: 'bool', label: 'Find is a pattern', default: false },
    ],
  },
  // to-dos
  create_todo: {
    group: 'To-dos', icon: 'add-circle-outline', label: 'Add a to-do',
    fields: [
      { key: 'title', type: 'text', label: 'Title', placeholder: 'Call %message_from' },
      { key: 'notes', type: 'textarea', label: 'Notes', optional: true },
      { key: 'when', type: 'select', label: 'Due', default: 'none', options: [{ value: 'none', label: 'No date (Inbox)' }, { value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'days', label: 'In some days' }] },
      { key: 'days', type: 'text', label: 'How many days', default: '2', showWhen: { key: 'when', is: 'days' } },
      { key: 'time', type: 'time', label: 'At (optional)', optional: true },
      { key: 'priority', type: 'priority', label: 'Priority', default: '4' },
      { key: 'labels', type: 'text', label: 'Labels, comma separated', optional: true },
      { key: 'business_id', type: 'business', label: 'In a business (optional)', optional: true },
      { key: 'assign_to', type: 'person', label: 'Give it to (optional)', optional: true },
    ],
  },
  complete_todo: { group: 'To-dos', icon: 'checkmark-circle-outline', label: 'Finish a to-do', fields: [TODO_TARGET] },
  reopen_todo: { group: 'To-dos', icon: 'refresh-circle-outline', label: 'Reopen a to-do', fields: [TODO_TARGET] },
  rename_todo: { group: 'To-dos', icon: 'text-outline', label: 'Change the title', fields: [TODO_TARGET, { key: 'title', type: 'text', label: 'New title' }] },
  set_priority: { group: 'To-dos', icon: 'flag-outline', label: 'Set priority', fields: [TODO_TARGET, { key: 'priority', type: 'priority', label: 'Priority', default: '2' }] },
  add_label: { group: 'To-dos', icon: 'pricetag-outline', label: 'Add a label', fields: [TODO_TARGET, { key: 'label', type: 'text', label: 'Label' }] },
  remove_label: { group: 'To-dos', icon: 'remove-circle-outline', label: 'Remove a label', fields: [TODO_TARGET, { key: 'label', type: 'text', label: 'Label' }] },
  set_due: {
    group: 'To-dos', icon: 'calendar-outline', label: 'Set the due date',
    fields: [
      TODO_TARGET,
      { key: 'when', type: 'select', label: 'Due', default: 'today', options: [{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'days', label: 'In some days' }, { value: 'clear', label: 'No date' }] },
      { key: 'days', type: 'text', label: 'How many days', default: '2', showWhen: { key: 'when', is: 'days' } },
    ],
  },
  set_status: { group: 'To-dos', icon: 'swap-horizontal-outline', label: 'Set the status', fields: [TODO_TARGET, { key: 'status', type: 'status', label: 'Status', default: 'in_progress' }] },
  assign_todo: { group: 'To-dos', icon: 'person-add-outline', label: 'Give a to-do to someone', fields: [TODO_TARGET, { key: 'person', type: 'person', label: 'Person' }] },
  add_comment: { group: 'To-dos', icon: 'chatbubble-outline', label: 'Comment on a to-do', fields: [TODO_TARGET, { key: 'text', type: 'textarea', label: 'Comment' }] },
  find_todos: {
    group: 'To-dos', icon: 'search-outline', label: 'Find to-dos',
    hint: 'Fills %found (titles), %found_ids and %found_count. Pair it with Repeat',
    fields: [
      { key: 'which', type: 'select', label: 'Look for', default: 'overdue', options: [
        { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'week', label: 'Due in the next 7 days' },
        { value: 'inbox', label: 'In my Inbox' }, { value: 'urgent', label: 'Urgent and open' }, { value: 'open', label: 'All open' },
      ] },
      { key: 'label', type: 'text', label: 'With label (optional)', optional: true },
      { key: 'business_id', type: 'business', label: 'In a business (optional)', optional: true },
      { key: 'into', type: 'text', label: 'Keep them in', default: 'found', raw: true },
    ],
  },
  // tell people
  notify_me: {
    group: 'Tell people', icon: 'notifications-outline', label: 'Notify me',
    hint: 'A notification in the app, and a push to your devices',
    fields: [{ key: 'title', type: 'text', label: 'Title', default: 'TaskHub' }, { key: 'message', type: 'textarea', label: 'Message' }],
  },
  notify_user: {
    group: 'Tell people', icon: 'person-circle-outline', label: 'Notify someone',
    fields: [{ key: 'person', type: 'person', label: 'Who' }, { key: 'title', type: 'text', label: 'Title', default: 'TaskHub' }, { key: 'message', type: 'textarea', label: 'Message' }],
  },
  send_chat: {
    group: 'Tell people', icon: 'chatbubble-ellipses-outline', label: 'Send a chat message',
    hint: 'A direct message from you',
    fields: [{ key: 'person', type: 'person', label: 'To' }, { key: 'text', type: 'textarea', label: 'Message' }],
  },
  // this device (needs the app to be open)
  toast: { group: 'On screen', icon: 'chatbox-outline', label: 'Show a message', hint: 'A short message on your screen (the app must be open)', fields: [{ key: 'message', type: 'text', label: 'Message' }] },
  alert: {
    group: 'On screen', icon: 'warning-outline', label: 'Full-screen alert', hint: 'The flashing red screen. If the app is closed you get a push instead',
    fields: [{ key: 'title', type: 'text', label: 'Title', default: 'Heads up' }, { key: 'message', type: 'textarea', label: 'Message' }],
  },
  sound: { group: 'On screen', icon: 'musical-notes-outline', label: 'Play a sound', fields: [{ key: 'kind', type: 'select', label: 'Sound', default: 'bell', options: [{ value: 'bell', label: 'Bell' }, { value: 'meow', label: 'Meow' }, { value: 'done', label: 'Done chime' }] }] },
  vibrate: { group: 'On screen', icon: 'radio-outline', label: 'Vibrate', hint: 'Phones that allow it (not iPhone)', fields: [{ key: 'ms', type: 'number', label: 'Milliseconds', default: 300, min: 50, max: 2000 }] },
  speak: { group: 'On screen', icon: 'volume-high-outline', label: 'Say it out loud', hint: 'Reads the text aloud (the app must be open)', fields: [{ key: 'text', type: 'text', label: 'Text' }] },
  open_screen: {
    group: 'On screen', icon: 'navigate-outline', label: 'Go to a screen',
    fields: [{ key: 'screen', type: 'select', label: 'Screen', default: 'Todos', options: [{ value: 'Todos', label: 'To-do' }, { value: 'Dashboard', label: 'Home' }, { value: 'Progress', label: 'Progress' }, { value: 'ChatList', label: 'Chat' }, { value: 'Approvals', label: 'Approvals' }, { value: 'Notifications', label: 'Notifications' }] }],
  },
  open_todo: { group: 'On screen', icon: 'open-outline', label: 'Open a to-do', fields: [TODO_TARGET] },
  start_focus: { group: 'On screen', icon: 'timer-outline', label: 'Start Focus mode', fields: [{ key: 'minutes', type: 'number', label: 'Minutes', default: 25, min: 5, max: 120 }, { ...TODO_TARGET, optional: true }] },
  // web
  http_request: {
    group: 'Web', icon: 'globe-outline', label: 'Call a web address', advanced: true,
    hint: 'Sends a request to a public website. Fills %http_status and %http_body',
    fields: [
      { key: 'method', type: 'select', label: 'Method', default: 'GET', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'DELETE', label: 'DELETE' }] },
      { key: 'url', type: 'text', label: 'Address (https://...)' },
      { key: 'headers', type: 'textarea', label: 'Headers, one per line (Name: value)', optional: true },
      { key: 'body', type: 'textarea', label: 'Body', optional: true },
      { key: 'into', type: 'text', label: 'Keep the answer in', default: 'http_body', raw: true },
    ],
  },
  log: { group: 'Flow', icon: 'document-text-outline', label: 'Add to the run log', fields: [{ key: 'message', type: 'text', label: 'Text' }] },
});

const TASK_VARS = [
  { group: 'Time', items: ['TIME (14:30)', 'DATE (2026-10-17)', 'DAY (Saturday)', 'HOUR', 'MIN', 'WEEKDAY (1 to 7)', 'TODAY', 'TOMORROW'] },
  { group: 'You', items: ['USER (your name)', 'USERID', 'trigger'] },
  { group: 'Counts', items: ['overdue_count', 'today_count', 'open_count'] },
  { group: 'Device', items: ['battery', 'charging'] },
];

// ---- ready-made automations ------------------------------------------------------------------------

const RECIPES = [
  {
    id: 'morning-briefing', icon: 'sunny-outline', title: 'Morning briefing',
    description: 'Every weekday at 8:30, a notification telling you how many to-dos are due today and how many are overdue.',
    profile: { name: 'Morning briefing', contexts: [{ type: 'time_at', at: '08:30', days: [1, 2, 3, 4, 5] }] },
    enter: {
      name: 'Morning briefing',
      actions: [
        { type: 'find_todos', which: 'today', into: 'today' },
        { type: 'find_todos', which: 'overdue', into: 'late' },
        { type: 'if', cond: { left: '%today_count', op: 'gt', right: '0' } },
        { type: 'notify_me', title: 'Good morning, %USER', message: '%today_count due today, %late_count overdue. First up: %today(1)' },
        { type: 'else' },
        { type: 'notify_me', title: 'Good morning, %USER', message: 'Nothing is due today. %late_count overdue.' },
        { type: 'end_if' },
      ],
    },
  },
  {
    id: 'urgent-alert', icon: 'warning-outline', title: 'Urgent work, full-screen alert',
    description: 'When an urgent to-do is given to you, the flashing alert appears so you cannot miss it.',
    profile: { name: 'Urgent work alert', contexts: [{ type: 'todo_assigned' }] },
    enter: {
      name: 'Urgent alert',
      actions: [
        { type: 'if', cond: { left: '%todo_priority', op: 'le', right: '1' } },
        { type: 'alert', title: 'Urgent', message: '%todo_title' },
        { type: 'sound', kind: 'bell' },
        { type: 'end_if' },
      ],
    },
  },
  {
    id: 'auto-label-invoices', icon: 'pricetags-outline', title: 'Label invoices automatically',
    description: 'Any new to-do with "invoice" in the title gets the finance label and High priority.',
    profile: { name: 'Label invoices', contexts: [{ type: 'todo_created', scope: 'mine', text: 'invoice' }] },
    enter: {
      name: 'Label invoices',
      actions: [
        { type: 'add_label', todo: '%todo_id', label: 'finance' },
        { type: 'set_priority', todo: '%todo_id', priority: '2' },
      ],
    },
  },
  {
    id: 'celebrate', icon: 'trophy-outline', title: 'Celebrate every finish',
    description: 'A message and a chime whenever you finish something, and a running total in the variable %DONE_COUNT.',
    profile: { name: 'Celebrate', contexts: [{ type: 'todo_completed', scope: 'mine' }] },
    enter: {
      name: 'Celebrate',
      actions: [
        { type: 'set_var', name: 'DONE_COUNT', value: '%DONE_COUNT + 1', calculate: true },
        { type: 'toast', message: 'Done: %todo_title (%DONE_COUNT so far)' },
        { type: 'sound', kind: 'done' },
      ],
    },
  },
  {
    id: 'evening-check', icon: 'moon-outline', title: 'Evening overdue check',
    description: 'At 5:30 on weekdays, if anything is overdue, you get a list of the first few.',
    profile: { name: 'Evening overdue check', contexts: [{ type: 'time_at', at: '17:30', days: [1, 2, 3, 4, 5] }] },
    enter: {
      name: 'Evening check',
      actions: [
        { type: 'find_todos', which: 'overdue', into: 'late' },
        { type: 'if', cond: { left: '%late_count', op: 'gt', right: '0' } },
        { type: 'var_join', name: 'list', list: '%late', sep: '; ' },
        { type: 'notify_me', title: '%late_count overdue before you go', message: '%list' },
        { type: 'end_if' },
      ],
    },
  },
  {
    id: 'overdue-pileup', icon: 'alert-circle-outline', title: 'Overdue pile-up warning',
    description: 'A state profile: when you have 3 or more overdue to-dos it warns you once, and cheers when you are back under.',
    profile: { name: 'Overdue pile-up', contexts: [{ type: 'overdue_count', min: 3 }] },
    enter: { name: 'Pile-up warning', actions: [{ type: 'notify_me', title: 'Overdue is piling up', message: 'You have %overdue_count overdue to-dos. Pick one and finish it first.' }] },
    exit: { name: 'Back on track', actions: [{ type: 'toast', message: 'Back under control. Nice work.' }] },
  },
  {
    id: 'battery-low', icon: 'battery-dead-outline', title: 'Low battery heads-up',
    description: 'While the app is open, tells you when the battery drops under 20% and is not charging.',
    profile: { name: 'Low battery', contexts: [{ type: 'battery', cmp: 'le', percent: 20, charging: 'no' }] },
    enter: { name: 'Low battery', actions: [{ type: 'toast', message: 'Battery is at %battery%. Save your work and plug in.' }, { type: 'vibrate', ms: 300 }] },
  },
  {
    id: 'standup-reminder', icon: 'people-outline', title: 'Stand-up reminder',
    description: 'At 10:00 on weekdays, a nudge to post your daily stand-up.',
    profile: { name: 'Stand-up reminder', contexts: [{ type: 'time_at', at: '10:00', days: [1, 2, 3, 4, 5] }] },
    enter: { name: 'Stand-up reminder', actions: [{ type: 'notify_me', title: 'Stand-up time', message: 'Post what you did and what is next.' }] },
  },
  {
    id: 'web-to-todo', icon: 'link-outline', title: 'Web link that adds a to-do',
    description: 'Gets a secret link. Any form or app that calls it creates a to-do from the text it sends.',
    profile: { name: 'Web link to to-do', contexts: [{ type: 'webhook' }] },
    enter: { name: 'Web link to to-do', actions: [{ type: 'create_todo', title: '%hook_body', when: 'none', priority: '4' }] },
  },
  {
    id: 'deep-work', icon: 'headset-outline', title: 'Deep work hours',
    description: 'From 9 to 12 on weekdays it sets %MODE to focus; afterwards it sets it back. Other automations can check it.',
    profile: { name: 'Deep work hours', contexts: [{ type: 'time_range', from: '09:00', to: '12:00', days: [1, 2, 3, 4, 5] }] },
    enter: { name: 'Deep work starts', actions: [{ type: 'set_var', name: 'MODE', value: 'focus' }, { type: 'toast', message: 'Deep work until 12:00' }] },
    exit: { name: 'Deep work ends', actions: [{ type: 'set_var', name: 'MODE', value: 'normal' }] },
  },
];

// ---- cleaning and checking what a person sends ------------------------------------------------------

const MAX_ACTIONS = 60;
const clip = (v, n) => String(v ?? '').slice(0, n);

function fieldValue(field, raw) {
  switch (field.type) {
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) return field.default ?? null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return field.default ?? null;
      const lo = field.min ?? -1e9; const hi = field.max ?? 1e9;
      return Math.min(hi, Math.max(lo, field.decimals ? n : Math.round(n)));
    }
    case 'bool': return raw === true || raw === 'true';
    case 'days': return Array.isArray(raw) ? [...new Set(raw.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : (field.default || []);
    case 'time': return HM.test(String(raw || '')) ? String(raw) : (field.optional ? '' : (field.default || ''));
    case 'date': return YMD.test(String(raw || '')) ? String(raw) : '';
    case 'cond': {
      const c = raw && typeof raw === 'object' ? raw : {};
      return { left: clip(c.left, 300), op: CMP_OPS[c.op] ? c.op : 'eq', right: clip(c.right, 300) };
    }
    case 'select': {
      const allowed = (field.options || []).map((o) => o.value);
      return allowed.includes(String(raw)) ? String(raw) : (field.default ?? allowed[0] ?? '');
    }
    case 'textarea': return clip(raw, 3000);
    default: return clip(raw, 1000);
  }
}

function cleanFields(spec, input) {
  const out = {};
  for (const field of spec.fields) {
    const raw = input[field.key] !== undefined ? input[field.key] : field.default;
    out[field.key] = fieldValue(field, raw);
  }
  return out;
}

/** Clean and check one profile's contexts. Returns { contexts, errors[] }. */
function cleanContexts(list) {
  const errors = [];
  const contexts = [];
  const input = Array.isArray(list) ? list.slice(0, 10) : [];
  let events = 0;
  input.forEach((c, i) => {
    const spec = CONTEXTS[c?.type];
    if (!spec) { errors.push(`Context ${i + 1} is not something we know`); return; }
    if (spec.kind === 'event') events += 1;
    const clean = { type: c.type, ...cleanFields(spec, c) };
    if (c.type === 'time_at' && !clean.at) errors.push('Choose a time');
    if (c.type === 'date_on' && !clean.date) errors.push('Choose a date');
    if (c.type === 'place' && (clean.lat === null || clean.lon === null)) errors.push('Choose a place');
    if (c.type === 'time_range' && (!clean.from || !clean.to)) errors.push('Choose both times');
    contexts.push(clean);
  });
  if (!contexts.length) errors.push('Add at least one thing to listen for');
  if (events > 1) errors.push('A profile can start from only one event. Use another profile for the second');
  return { contexts, errors };
}

/**
 * Work out how the blocks of an action list nest. Returns { errors: [{ index, message }], jump } where
 * `jump[i]` says, for an If / Else if / Else, the index to go to when its branch is not taken, for an
 * Else / Else if reached by falling through, `end[i]` where the If ends, and for Repeat where it ends.
 */
function analyzeBlocks(actions) {
  const errors = [];
  const nextBranch = {}; // if/elseif/else index -> index of the next branch or end_if
  const endOf = {}; // if/elseif/else/for index -> index of its closing action
  const loopStart = {}; // end_for index -> index of its for
  const stack = [];
  actions.forEach((a, i) => {
    const spec = ACTIONS[a.type];
    if (!spec) return;
    if (a.type === 'if') stack.push({ kind: 'if', branches: [i] });
    else if (a.type === 'for') stack.push({ kind: 'for', start: i });
    else if (a.type === 'elseif' || a.type === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') { errors.push({ index: i, message: `${spec.label} needs an If above it` }); return; }
      if (top.branches.some((b) => actions[b].type === 'else')) { errors.push({ index: i, message: 'Nothing can follow Else except End if' }); return; }
      nextBranch[top.branches[top.branches.length - 1]] = i;
      top.branches.push(i);
    } else if (a.type === 'end_if') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') { errors.push({ index: i, message: 'End if has no If' }); return; }
      stack.pop();
      nextBranch[top.branches[top.branches.length - 1]] = i;
      for (const b of top.branches) endOf[b] = i;
    } else if (a.type === 'end_for') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'for') { errors.push({ index: i, message: 'End repeat has no Repeat' }); return; }
      stack.pop();
      endOf[top.start] = i; loopStart[i] = top.start;
    } else if (a.type === 'break' && !stack.some((s) => s.kind === 'for')) {
      errors.push({ index: i, message: 'Leave the repeat only works inside a Repeat' });
    }
  });
  for (const open of stack) {
    const first = open.kind === 'if' ? open.branches[0] : open.start;
    errors.push({ index: first, message: open.kind === 'if' ? 'This If is never closed with End if' : 'This Repeat is never closed with End repeat' });
  }
  return { errors, nextBranch, endOf, loopStart };
}

/**
 * Clean and check a task's actions. `canUseWeb` says whether the person may use the web action.
 * Returns { actions, errors: [{ index, message }] }.
 */
function cleanTask(list, { canUseWeb = false } = {}) {
  const errors = [];
  const input = Array.isArray(list) ? list.slice(0, MAX_ACTIONS) : [];
  if (Array.isArray(list) && list.length > MAX_ACTIONS) errors.push({ index: MAX_ACTIONS, message: `A task can have up to ${MAX_ACTIONS} actions` });
  const actions = [];
  input.forEach((a, i) => {
    const spec = ACTIONS[a?.type];
    if (!spec) { errors.push({ index: i, message: 'An action here is not one we know' }); return; }
    if (spec.advanced && !canUseWeb) errors.push({ index: i, message: `${spec.label} is not switched on for you. Ask somebody who manages access` });
    const clean = { type: a.type, ...cleanFields(spec, a) };
    if (a.id) clean.id = clip(a.id, 40);
    if (a.disabled) clean.disabled = true;
    if (a.when && String(a.when).trim()) {
      clean.when = clip(a.when, 300);
      try { evaluate(clean.when, () => '0'); } catch (err) {
        if (err instanceof ExprError) errors.push({ index: i, message: `"Only if" says: ${err.message}` });
      }
    }
    for (const f of spec.fields) {
      if (f.optional || f.type === 'bool' || f.type === 'select' || f.type === 'number' || f.showWhen || f.type === 'time') continue;
      if (f.type === 'cond') continue;
      if (clean[f.key] === '' || clean[f.key] === null) errors.push({ index: i, message: `${spec.label}: fill in "${f.label}"` });
    }
    if (a.type === 'set_var' && clean.name && !/^[A-Za-z_][A-Za-z0-9_]{0,38}$/.test(clean.name.replace(/^%/, ''))) {
      errors.push({ index: i, message: 'Variable names use letters, digits and _ only' });
    }
    if (a.type === 'set_var' && clean.calculate && clean.value) {
      try { evaluate(clean.value, () => '0'); } catch (err) {
        if (err instanceof ExprError) errors.push({ index: i, message: `Calculation: ${err.message}` });
      }
    }
    actions.push(clean);
  });
  const blocks = analyzeBlocks(actions);
  errors.push(...blocks.errors);
  const labels = new Set(actions.filter((a) => a.type === 'label').map((a) => a.name));
  actions.forEach((a, i) => { if (a.type === 'goto' && !labels.has(a.name)) errors.push({ index: i, message: `There is no label called "${a.name}"` }); });
  return { actions, errors };
}

/** The part of the catalog the editor needs. */
function publicCatalog() {
  const strip = (map) => Object.entries(map).map(([type, spec]) => ({ type, ...spec }));
  return { contexts: strip(CONTEXTS), actions: strip(ACTIONS), comparisons: Object.entries(CMP_OPS).map(([value, v]) => ({ value, label: v.label, needs: v.needs })), variables: TASK_VARS, recipes: RECIPES.map((r) => ({ id: r.id, icon: r.icon, title: r.title, description: r.description })) };
}

module.exports = { CONTEXTS, ACTIONS, RECIPES, MAX_ACTIONS, cleanContexts, cleanTask, cleanFields, analyzeBlocks, publicCatalog };
