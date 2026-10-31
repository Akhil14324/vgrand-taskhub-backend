const { isLeader, managesBusiness } = require('./org');

/**
 * Who may see, fill and shape a board (F-WS-06, F-PERM-01). Pure: give it the actor from loadActor(), the
 * boards row and that board's board_members rows.
 *
 *   view    open the board and see its structure (items are still filtered by the to-do rules)
 *   add     add items, groups' items and fill cells
 *   manage  change the board itself: name, columns, labels, groups, views, members
 *
 * Business and site boards: everyone in the business sees and fills them (open assignment); the people who
 * manage that business, leadership and the board's creator shape them. A private board is seen only by its
 * creator, its members and leadership. Personal boards belong to their owner and whoever they invite.
 * Group boards (above every business) are for leadership and invited people.
 */
function boardAccess(actor, board, members = []) {
  const none = { view: false, add: false, manage: false, role: null };
  if (!actor || !board) return none;
  const mine = members.find((m) => Number(m.user_id) === Number(actor.id));
  const role = mine ? mine.role : null;
  const invitedEditor = role === 'editor' || role === 'admin';
  const isCreator = Number(board.created_by) === Number(actor.id);
  const leader = isLeader(actor);

  if (board.scope === 'personal') {
    const owner = Number(board.owner_id) === Number(actor.id);
    return {
      view: owner || !!role,
      add: owner || invitedEditor,
      manage: owner || role === 'admin',
      role: owner ? 'owner' : role,
    };
  }

  if (board.scope === 'group') {
    return {
      view: leader || !!role,
      add: leader || invitedEditor,
      manage: leader || role === 'admin' || isCreator,
      role: role || (leader ? 'leader' : null),
    };
  }

  // business or site
  const inBusiness = !!actor.memberships?.has(Number(board.business_id));
  const manages = leader || managesBusiness(actor, board.business_id);
  if (board.privacy === 'private') {
    const seen = leader || isCreator || !!role;
    return {
      view: seen,
      add: leader || isCreator || invitedEditor,
      manage: leader || isCreator || role === 'admin',
      role: role || (isCreator ? 'owner' : leader ? 'leader' : null),
    };
  }
  return {
    view: leader || inBusiness || !!role,
    add: leader || inBusiness || invitedEditor,
    manage: manages || isCreator || role === 'admin',
    role: role || (manages ? 'manager' : inBusiness ? 'member' : null),
  };
}

/** Who may create a board in a scope. Personal: anyone; business/site: anyone in it; group: leadership. */
function canCreateBoard(actor, scope, businessId) {
  if (!actor) return false;
  if (scope === 'personal') return true;
  if (scope === 'group') return isLeader(actor);
  return isLeader(actor) || !!actor.memberships?.has(Number(businessId));
}

module.exports = { boardAccess, canCreateBoard };
