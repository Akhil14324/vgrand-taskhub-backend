const test = require('node:test');
const assert = require('node:assert');
const { visibleBusinessIds, buildTree } = require('./orgTree');

const sites = [
  { id: 10, business_id: 1, name: 'Ongolu', kind: 'branch', status: 'active' },
  { id: 11, business_id: 1, name: 'Kandukuru', kind: 'branch', status: 'active' },
  { id: 20, business_id: 2, name: 'Tripura', kind: 'project', status: 'under_construction' },
];
const businesses = [
  { id: 1, name: 'Family Restaurant', sector: 'food' },
  { id: 2, name: 'Infra', sector: 'real_estate' },
  { id: 3, name: 'Healthcare', sector: 'healthcare' },
];
const siteMembers = [
  { site_id: 10, user_id: 6, name: 'Chandrasekhar', designation: 'head' },
  { site_id: 20, user_id: 50, name: 'Site worker', designation: 'member' },
];

test('leadership sees every business', () => {
  assert.strictEqual(visibleBusinessIds({ global: 1, memberships: new Map() }, sites), null);
  assert.strictEqual(visibleBusinessIds({ global: 3, memberships: new Map() }, sites), null);
});

test('a member sees their businesses plus the business of their site', () => {
  const actor = { id: 50, global: null, memberships: new Map([[3, 'member']]) };
  assert.deepStrictEqual([...visibleBusinessIds(actor, sites, [20])].sort(), [2, 3]);
});

test('the tree keeps only visible businesses and nests sites with their people', () => {
  const actor = { id: 6, global: null, memberships: new Map([[1, 'head']]) };
  const tree = buildTree({
    group: { id: 1, name: 'Vgrand' }, businesses, sites, siteMembers,
    visible: visibleBusinessIds(actor, sites, [10]), actor, canChange: (id) => id === 1,
  });
  assert.strictEqual(tree.group.name, 'Vgrand');
  assert.deepStrictEqual(tree.businesses.map((b) => b.id), [1]);
  const [restaurant] = tree.businesses;
  assert.strictEqual(restaurant.designation, 'head');
  assert.strictEqual(restaurant.can_change, true);
  assert.deepStrictEqual(restaurant.sites.map((s) => s.name), ['Ongolu', 'Kandukuru']);
  assert.strictEqual(restaurant.sites[0].is_member, true);
  assert.deepStrictEqual(restaurant.sites[0].members, [{ id: 6, name: 'Chandrasekhar', designation: 'head' }]);
});
