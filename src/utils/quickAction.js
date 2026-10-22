const jwt = require('jsonwebtoken');

// A short-lived link inside a notification that lets someone approve a step with one tap, without opening
// the app. It only ever carries "go ahead" for one step and one person; anything else (redo, stop, ...)
// needs a note, so those open the app.
const base = () => (process.env.PUBLIC_API_URL || 'https://vgrand-taskhub-backend-production.up.railway.app').replace(/\/+$/, '');

function stepGoUrl(stepId, userId) {
  const token = jwt.sign({ kind: 'step-go', stepId, userId }, process.env.JWT_SECRET, { expiresIn: '3d' });
  return `${base()}/api/quick/step-go?t=${encodeURIComponent(token)}`;
}

function readStepGo(token) {
  const p = jwt.verify(token, process.env.JWT_SECRET);
  if (p.kind !== 'step-go') throw new Error('Wrong link');
  return { stepId: p.stepId, userId: p.userId };
}

module.exports = { stepGoUrl, readStepGo };
