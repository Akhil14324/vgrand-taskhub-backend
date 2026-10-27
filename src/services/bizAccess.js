const { isLeader, managesBusiness } = require('../utils/org');

/**
 * What the actor may do in one business's workspace (sprints, epics, releases, time):
 * anyone in the business, and leadership, can see it; managers of the business, and leadership, plan it.
 */
function accessFor(actor, businessId) {
  return {
    view: isLeader(actor) || actor.memberships.has(businessId),
    manage: isLeader(actor) || managesBusiness(actor, businessId),
  };
}

module.exports = { accessFor };
