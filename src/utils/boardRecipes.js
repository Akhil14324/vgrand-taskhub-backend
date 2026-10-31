/**
 * Automation recipes for one board, in the words of the board (MONDAY_FEATURE_SPEC.md F-AUT-01, F-AUT-02).
 * Each recipe builds a normal automation profile + task (utils/automation/catalog.js), limited to the board with
 * scope 'board', so it runs on the existing engine with all its limits and loop protection. Pure, unit-tested.
 *
 *   build(board, params) -> { profile: { name, contexts }, tasks: { enter: { name, actions } } }
 */

const onBoard = (board) => ({ scope: 'board', board_id: String(board.id) });
const STATUS_WORDS = { todo: 'Not started', in_progress: 'Working on it', blocked: 'Stuck', in_review: 'In review', on_hold: 'On hold', done: 'Done' };

const BOARD_RECIPES = [
  {
    id: 'done-notify',
    icon: 'checkmark-done-outline',
    sentence: 'When an item is done, notify me',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: done`, contexts: [{ type: 'todo_completed', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: done`, actions: [{ type: 'notify_me', title: 'Done on %todo_business', message: '%todo_title was finished by %todo_by' }] } },
    }),
  },
  {
    id: 'status-notify',
    icon: 'swap-horizontal-outline',
    sentence: 'When the status changes to {status}, notify me',
    params: [{ key: 'status', type: 'status', default: 'blocked' }],
    build: (board, p) => {
      const to = Object.keys(STATUS_WORDS).includes(p.status) ? p.status : 'blocked';
      return {
        profile: { name: `${board.name}: ${STATUS_WORDS[to]}`, contexts: [{ type: 'todo_status', to, ...onBoard(board) }] },
        tasks: { enter: { name: `${board.name}: ${STATUS_WORDS[to]}`, actions: [{ type: 'notify_me', title: `${STATUS_WORDS[to]}: %todo_title`, message: 'On %todo_business, given to %todo_assignee' }] } },
      };
    },
  },
  {
    id: 'stuck-alert',
    icon: 'warning-outline',
    sentence: 'When an item gets stuck, show me a full-screen alert',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: stuck alert`, contexts: [{ type: 'todo_status', to: 'blocked', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: stuck alert`, actions: [{ type: 'alert', title: 'Stuck', message: '%todo_title' }, { type: 'sound', kind: 'bell' }] } },
    }),
  },
  {
    id: 'new-item-notify',
    icon: 'add-circle-outline',
    sentence: 'When an item is added, notify me',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: new item`, contexts: [{ type: 'todo_created', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: new item`, actions: [{ type: 'notify_me', title: 'New on %todo_business', message: '%todo_title' }] } },
    }),
  },
  {
    id: 'new-item-assign',
    icon: 'person-add-outline',
    sentence: 'When an item is added, give it to {person}',
    params: [{ key: 'person', type: 'person' }],
    build: (board, p) => ({
      profile: { name: `${board.name}: hand new items over`, contexts: [{ type: 'todo_created', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: hand new items over`, actions: [{ type: 'assign_todo', todo: '%todo_id', person: String(p.person || '') }] } },
    }),
    check: (p) => (p.person ? null : 'Pick the person'),
  },
  {
    id: 'new-item-start',
    icon: 'play-circle-outline',
    sentence: 'When an item is added, set its status to Working on it',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: start new items`, contexts: [{ type: 'todo_created', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: start new items`, actions: [{ type: 'set_status', todo: '%todo_id', status: 'in_progress' }] } },
    }),
  },
  {
    id: 'comment-notify',
    icon: 'chatbubble-ellipses-outline',
    sentence: 'When someone comments on an item, notify me',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: comments`, contexts: [{ type: 'todo_commented', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: comments`, actions: [{ type: 'notify_me', title: '%comment_by on %todo_title', message: '%comment_text' }] } },
    }),
  },
  {
    id: 'done-comment',
    icon: 'document-text-outline',
    sentence: 'When an item is done, write "Finished" in its updates',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: note when done`, contexts: [{ type: 'todo_completed', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: note when done`, actions: [{ type: 'add_comment', todo: '%todo_id', text: 'Finished.' }] } },
    }),
  },
  {
    id: 'urgent-alert',
    icon: 'flag-outline',
    sentence: 'When an item becomes urgent, show me a full-screen alert',
    params: [],
    build: (board) => ({
      profile: { name: `${board.name}: urgent`, contexts: [{ type: 'todo_priority', to: '1', ...onBoard(board) }] },
      tasks: { enter: { name: `${board.name}: urgent`, actions: [{ type: 'alert', title: 'Urgent', message: '%todo_title' }] } },
    }),
  },
  {
    id: 'morning-overdue',
    icon: 'sunny-outline',
    sentence: 'Every weekday at {at}, tell me how many of my items are overdue',
    params: [{ key: 'at', type: 'time', default: '09:00' }],
    build: (board, p) => ({
      profile: { name: `${board.name}: morning check`, contexts: [{ type: 'time_at', at: /^\d{2}:\d{2}$/.test(p.at || '') ? p.at : '09:00', days: [1, 2, 3, 4, 5, 6] }] },
      tasks: { enter: { name: `${board.name}: morning check`, actions: [
        { type: 'find_todos', which: 'overdue', into: 'late' },
        { type: 'if', cond: { left: '%late_count', op: 'gt', right: '0' } },
        { type: 'notify_me', title: 'Overdue', message: '%late_count of your items are overdue. First: %late(1)' },
        { type: 'end_if' },
      ] } },
    }),
  },
];

/** The recipe list for the client: id, icon, sentence and what it asks for. */
function recipeList() {
  return BOARD_RECIPES.map(({ id, icon, sentence, params }) => ({ id, icon, sentence, params }));
}

/** Build a recipe for a board, or { error }. */
function buildRecipe(id, board, params = {}) {
  const r = BOARD_RECIPES.find((x) => x.id === id);
  if (!r) return { error: 'Unknown recipe' };
  const problem = r.check ? r.check(params) : null;
  if (problem) return { error: problem };
  return r.build(board, params);
}

/** Is this automation profile one of this board's (any context limited to it)? */
function isBoardProfile(contexts, boardId) {
  return (Array.isArray(contexts) ? contexts : []).some((c) => c.scope === 'board' && Number(c.board_id) === Number(boardId));
}

module.exports = { BOARD_RECIPES, recipeList, buildRecipe, isBoardProfile };
