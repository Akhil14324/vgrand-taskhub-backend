/**
 * Ready-made boards for the kinds of work in the group (MONDAY_FEATURE_SPEC.md F-MORE-16), and the shape every
 * template has. Pure and unit-tested; services/boardBuild.js turns a definition into a board.
 *
 * definition = {
 *   icon, color, item_word,
 *   columns: [{ system_key } | { kind, title, settings?, labels?: [{ label, color }] }],
 *   groups:  [{ name, color, items?: [{ title, values?: { [column title]: value } }] }],
 *   views:   [{ kind, name }]
 * }
 */

const status = (labels) => ({ kind: 'status', title: 'Stage', labels: labels.map(([label, color]) => ({ label, color })) });
const dropdown = (title, options) => ({ kind: 'dropdown', title, settings: { options: options.map(([label, color], i) => ({ id: `o${i + 1}`, label, color })) } });
const VIEWS = [{ kind: 'table', name: 'Main table' }, { kind: 'kanban', name: 'Kanban' }, { kind: 'calendar', name: 'Calendar' }];
const PLAN_VIEWS = [{ kind: 'table', name: 'Main table' }, { kind: 'gantt', name: 'Gantt' }, { kind: 'workload', name: 'Workload' }];

const BUILT_INS = {
  restaurant_daily: {
    name: 'Restaurant daily operations',
    description: 'Opening and closing checklists, kitchen maintenance, purchase requests and complaints for a branch.',
    sector: 'food',
    definition: {
      icon: 'restaurant-outline', color: 'orange', item_word: 'Task',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'date' }, dropdown('Area', [['Kitchen', 'orange'], ['Service', 'blue'], ['Cash', 'green'], ['Stores', 'purple']]), { kind: 'checkbox', title: 'Checked' }],
      groups: [
        { name: 'Opening checklist', color: 'green', items: [{ title: 'Gas, water and power checked' }, { title: 'Kitchen cleaned and stocked' }, { title: 'Cash counter opened with float' }] },
        { name: 'Closing checklist', color: 'blue', items: [{ title: 'Cash counted and handed over' }, { title: 'Leftover stock recorded' }, { title: 'Kitchen switched off and locked' }] },
        { name: 'Maintenance', color: 'orange' },
        { name: 'Purchase requests', color: 'purple' },
        { name: 'Customer complaints', color: 'red' },
      ],
      views: VIEWS,
    },
  },
  bar_operations: {
    name: 'Bar stock and licences',
    description: 'Stock counts, licence renewals, events and maintenance for the lounge.',
    sector: 'liquor',
    definition: {
      icon: 'wine-outline', color: 'pink', item_word: 'Task',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'deadline' }, { kind: 'numbers', title: 'Amount', settings: { unit: '₹', decimals: 0 } }],
      groups: [
        { name: 'Licences and renewals', color: 'red', items: [{ title: 'Excise licence renewal' }, { title: 'Fire safety certificate' }] },
        { name: 'Stock', color: 'blue' },
        { name: 'Events', color: 'purple' },
        { name: 'Maintenance', color: 'orange' },
      ],
      views: VIEWS,
    },
  },
  construction_project: {
    name: 'Construction project',
    description: 'A building project by phase, with dates for the Gantt, site issues, material requests and approvals.',
    sector: 'real_estate',
    definition: {
      icon: 'business-outline', color: 'blue', item_word: 'Work',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'timeline' }, { kind: 'numbers', title: 'Cost', settings: { unit: '₹', decimals: 0 } }, { kind: 'files', title: 'Drawings' }, { system_key: 'dependency' }],
      groups: [
        { name: 'Approvals and permits', color: 'purple', items: [{ title: 'Building plan approval' }, { title: 'Environmental clearance' }] },
        { name: 'Foundation', color: 'brown', items: [{ title: 'Excavation' }, { title: 'Footings and columns' }] },
        { name: 'Structure', color: 'blue', items: [{ title: 'Slabs' }, { title: 'Brickwork' }] },
        { name: 'Finishing', color: 'green', items: [{ title: 'Plastering' }, { title: 'Flooring and tiles' }, { title: 'Painting' }] },
        { name: 'Site issues', color: 'red' },
      ],
      views: PLAN_VIEWS,
    },
  },
  unit_sales: {
    name: 'Flat sales pipeline',
    description: 'Every buyer from first call to registration, with the flat, the amount and the next step.',
    sector: 'real_estate',
    definition: {
      icon: 'people-outline', color: 'green', item_word: 'Buyer',
      columns: [{ system_key: 'person' }, status([['New lead', 'grey'], ['Site visit', 'blue'], ['Negotiation', 'orange'], ['Booked', 'purple'], ['Registered', 'green'], ['Lost', 'red']]), { kind: 'phone', title: 'Phone' }, { kind: 'text', title: 'Flat' }, { kind: 'numbers', title: 'Deal value', settings: { unit: '₹', decimals: 0 } }, { system_key: 'date' }],
      groups: [{ name: 'This month', color: 'blue' }, { name: 'Follow up', color: 'orange' }, { name: 'Closed', color: 'green' }],
      views: [{ kind: 'table', name: 'Main table' }, { kind: 'kanban', name: 'Pipeline' }, { kind: 'chart', name: 'Chart' }],
    },
  },
  mining_production: {
    name: 'Mining production and dispatch',
    description: 'Daily production, equipment maintenance and dispatches.',
    sector: 'mining',
    definition: {
      icon: 'diamond-outline', color: 'brown', item_word: 'Entry',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'date' }, { kind: 'numbers', title: 'Tonnes', settings: { decimals: 1 } }, dropdown('Machine', [['Excavator', 'orange'], ['Crusher', 'blue'], ['Truck', 'green']])],
      groups: [{ name: 'Production', color: 'brown' }, { name: 'Equipment maintenance', color: 'orange' }, { name: 'Dispatch', color: 'green' }],
      views: VIEWS,
    },
  },
  hospital_project: {
    name: 'Hospital project',
    description: 'Construction plan, licences and approvals, vendors and hiring for the hospital.',
    sector: 'healthcare',
    definition: {
      icon: 'medkit-outline', color: 'aquamarine', item_word: 'Task',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'timeline' }, { kind: 'text', title: 'Vendor' }, { kind: 'numbers', title: 'Budget', settings: { unit: '₹', decimals: 0 } }],
      groups: [{ name: 'Construction', color: 'blue' }, { name: 'Licences and approvals', color: 'purple' }, { name: 'Equipment and vendors', color: 'orange' }, { name: 'Hiring', color: 'green' }],
      views: PLAN_VIEWS,
    },
  },
  software_sprint: {
    name: 'Software sprint',
    description: 'Features and bugs with points, for VTech.',
    sector: 'software',
    definition: {
      icon: 'code-slash-outline', color: 'purple', item_word: 'Item',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'item_type' }, { system_key: 'points' }, { system_key: 'date' }, { kind: 'link', title: 'Pull request' }],
      groups: [{ name: 'This sprint', color: 'blue' }, { name: 'Backlog', color: 'grey' }, { name: 'Bugs', color: 'red' }],
      views: [{ kind: 'table', name: 'Main table' }, { kind: 'kanban', name: 'Kanban' }, { kind: 'chart', name: 'Chart' }],
    },
  },
  leadership_priorities: {
    name: 'Leadership priorities',
    description: 'What leadership is driving across the companies, with an owner and a date for each.',
    sector: 'other',
    definition: {
      icon: 'star-outline', color: 'dark_purple', item_word: 'Priority',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'deadline' }, { system_key: 'priority' }, { kind: 'long_text', title: 'Notes' }],
      groups: [{ name: 'This week', color: 'red' }, { name: 'This month', color: 'orange' }, { name: 'This quarter', color: 'blue' }],
      views: [{ kind: 'table', name: 'Main table' }, { kind: 'workload', name: 'Who carries what' }],
    },
  },
  service_desk: {
    name: 'Service desk',
    description: 'Requests in, with a priority and a date to answer by.',
    sector: 'other',
    definition: {
      icon: 'help-buoy-outline', color: 'sky', item_word: 'Request',
      columns: [{ system_key: 'person' }, { system_key: 'status' }, { system_key: 'priority' }, { system_key: 'deadline' }, { kind: 'email', title: 'From' }],
      groups: [{ name: 'New', color: 'blue' }, { name: 'Waiting on them', color: 'orange' }, { name: 'Answered', color: 'green' }],
      views: VIEWS,
    },
  },
};

/** Check a definition's shape against the column catalog; returns a list of problems (empty = fine). */
function checkDefinition(def, { KINDS, SYSTEM_COLUMNS, COLOR_NAMES, VIEW_KINDS }) {
  const problems = [];
  if (!def || typeof def !== 'object') return ['no definition'];
  for (const c of def.columns || []) {
    if (c.system_key) { if (!SYSTEM_COLUMNS[c.system_key]) problems.push(`unknown built-in column ${c.system_key}`); continue; }
    if (!KINDS[c.kind] || KINDS[c.kind].system) problems.push(`unknown column type ${c.kind}`);
    if (!c.title) problems.push('a column has no title');
    for (const l of c.labels || []) if (!COLOR_NAMES.includes(l.color)) problems.push(`label colour ${l.color}`);
  }
  for (const g of def.groups || []) {
    if (!g.name) problems.push('a group has no name');
    if (g.color && !COLOR_NAMES.includes(g.color)) problems.push(`group colour ${g.color}`);
  }
  for (const v of def.views || []) if (!VIEW_KINDS.includes(v.kind)) problems.push(`view kind ${v.kind}`);
  return problems;
}

module.exports = { BUILT_INS, checkDefinition };
