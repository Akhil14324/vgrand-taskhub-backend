/**
 * Pure helpers for GET /api/org/tree (group -> company -> site). No database here, so they are unit-tested.
 */

const SITE_KINDS = ['branch', 'site', 'project'];
const SITE_STATUSES = ['active', 'under_construction', 'upcoming', 'completed'];

const isLeaderActor = (actor) => actor?.global !== null && actor?.global !== undefined && actor.global <= 3;

/**
 * Businesses the viewer sees in the sidebar: leadership sees all (null = no limit); everyone else the
 * businesses they belong to, plus the business of any site they are placed at.
 */
function visibleBusinessIds(actor, sites, mySiteIds = []) {
  if (isLeaderActor(actor)) return null;
  const ids = new Set([...(actor?.memberships?.keys?.() || [])].map(Number));
  const mine = new Set(mySiteIds.map(Number));
  for (const s of sites) if (mine.has(Number(s.id))) ids.add(Number(s.business_id));
  return ids;
}

function buildTree({ group, businesses, sites, siteMembers, visible, actor, canChange = () => false }) {
  const membersBySite = new Map();
  for (const m of siteMembers) {
    if (!membersBySite.has(m.site_id)) membersBySite.set(m.site_id, []);
    membersBySite.get(m.site_id).push({ id: m.user_id, name: m.name, designation: m.designation });
  }
  const sitesByBusiness = new Map();
  for (const s of sites) {
    if (!sitesByBusiness.has(s.business_id)) sitesByBusiness.set(s.business_id, []);
    sitesByBusiness.get(s.business_id).push({
      id: s.id, name: s.name, kind: s.kind, status: s.status, address: s.address || null,
      members: membersBySite.get(s.id) || [],
      is_member: (membersBySite.get(s.id) || []).some((m) => m.id === actor?.id),
    });
  }
  return {
    group: group || null,
    businesses: businesses
      .filter((b) => visible === null || visible.has(Number(b.id)))
      .map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        sector: b.sector || 'other',
        color: b.color || null,
        logo_url: b.logo_url || null,
        designation: actor?.memberships?.get?.(Number(b.id)) || null,
        can_change: !!canChange(b.id),
        sites: sitesByBusiness.get(b.id) || [],
      })),
  };
}

module.exports = { SITE_KINDS, SITE_STATUSES, visibleBusinessIds, buildTree };
