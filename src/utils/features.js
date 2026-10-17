// Per-person feature switches kept in users.preferences.features ({ key: boolean }). The list of keys
// mirrors FEATURES in Taskhub-mobile/src/utils/features.js; unknown keys are dropped.
const FEATURE_KEYS = [
  'water', 'stretch', 'focus', 'buddy', 'roulette', 'roast',
  'deadlines', 'labels', 'estimates', 'reminders',
  'board', 'calendar', 'timeline', 'leaderboard', 'automation',
];

/** Returns the clean { key: boolean } object, or null if the value is not an object at all. */
function cleanFeatures(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of FEATURE_KEYS) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  return out;
}

module.exports = { FEATURE_KEYS, cleanFeatures };
