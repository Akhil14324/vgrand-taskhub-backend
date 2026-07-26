const { describe, it } = require('node:test');
const assert = require('node:assert');
const { formatOverdueMessage } = require('../utils/dates');

describe('formatOverdueMessage', () => {
  it('formats a past due date cleanly', () => {
    const msg = formatOverdueMessage({
      title: 'Quarterly report',
      business_name: 'Acme',
      due_date: new Date(2026, 6, 23)
    });
    assert.strictEqual(
      msg,
      'Task "Quarterly report" (Acme) is overdue. Due date was Jul 23, 2026.'
    );
  });

  it('does not shift day-of-month across common timezones', () => {
    const timezones = ['America/Los_Angeles', 'Asia/Kolkata', 'UTC'];

    for (const tz of timezones) {
      const oldTz = process.env.TZ;
      process.env.TZ = tz;

      // Local-midnight date, as node-postgres returns for a Postgres DATE column
      const due = new Date(2026, 6, 23);
      const msg = formatOverdueMessage({
        title: 'Boundary check',
        business_name: 'Globex',
        due_date: due
      });

      assert.strictEqual(
        msg,
        'Task "Boundary check" (Globex) is overdue. Due date was Jul 23, 2026.',
        `off-by-one day produced for TZ=${tz}`
      );

      process.env.TZ = oldTz;
    }
  });
});
