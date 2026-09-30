const { describe, it } = require('node:test');
const assert = require('node:assert');
const { nextOccurrence, advance } = require('./recurrence');

describe('recurrence', () => {
  it('rolls a daily to-do to the day after today', () => {
    assert.strictEqual(nextOccurrence('2026-09-30', 'daily', '2026-09-30'), '2026-10-01');
  });

  it('skips past days when an overdue daily to-do is completed', () => {
    assert.strictEqual(nextOccurrence('2026-09-25', 'daily', '2026-09-30'), '2026-10-01');
  });

  it('keeps an early-completed weekly to-do on its cadence', () => {
    assert.strictEqual(nextOccurrence('2026-10-05', 'weekly', '2026-09-30'), '2026-10-12');
  });

  it('skips weekends for weekday recurrence', () => {
    // 2026-10-02 is a Friday.
    assert.strictEqual(advance('2026-10-02', 'weekdays'), '2026-10-05');
  });

  it('clamps monthly recurrence to the end of shorter months', () => {
    assert.strictEqual(advance('2026-01-31', 'monthly'), '2026-02-28');
  });
});
