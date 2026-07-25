function sanitizeText(value, maxLength = 5000) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return '';
  const stripped = trimmed.replace(/<[^>]*>/g, '');
  return stripped.slice(0, maxLength);
}

function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

function sanitizeObject(obj, fields, maxLengths = {}) {
  const result = {};
  for (const field of fields) {
    if (obj[field] !== undefined && obj[field] !== null) {
      result[field] = sanitizeText(obj[field], maxLengths[field] || 5000);
    }
  }
  return result;
}

module.exports = { sanitizeText, validatePassword, sanitizeObject };
