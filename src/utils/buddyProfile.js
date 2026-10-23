// A person's cat buddy (Mochi): its name and look, kept in users.preferences.buddy so it follows them to
// another device and other people can see it. The lists mirror Taskhub-mobile/src/utils/buddyProfile.js.
const COATS = ['snow', 'cream', 'rose', 'ruby', 'shadow'];
const HATS = ['none', 'party', 'crown', 'beanie', 'bow', 'glasses', 'shades'];
const DEFAULT_NAME = 'Mochi';

/** The clean { name, coat, hat } object, or null if the value is not an object at all. */
function cleanBuddy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = typeof value.name === 'string'
    ? value.name.replace(/[^\p{L}\p{N} '’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16)
    : '';
  return {
    name: name || DEFAULT_NAME,
    coat: COATS.includes(value.coat) ? value.coat : 'snow',
    hat: HATS.includes(value.hat) ? value.hat : 'none',
  };
}

module.exports = { COATS, HATS, DEFAULT_NAME, cleanBuddy };
