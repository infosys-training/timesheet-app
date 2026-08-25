const { toDateOnly, parseDateRange, DATE_ONLY_SQL } = require('../../utils/reportDates');
const { workEntrySchema } = require('../../validation/schemas');
jest.unmock('sqlite3');

describe('report date utilities', () => {
  test.each([
    [1705276800000, '2024-01-15'],
    ['1705276800000', '2024-01-15'],
    [new Date('2024-01-15T00:00:00.000Z'), '2024-01-15'],
    ['2024-01-15', '2024-01-15'],
    ['2024-01-15T23:30:00-05:00', '2024-01-16'],
    [null, null],
    [undefined, null],
    ['not-a-date', 'not-a-date']
  ])('toDateOnly(%p) returns %p', (value, expected) => {
    expect(toDateOnly(value)).toBe(expected);
  });

  test('parseDateRange validates calendar dates and ordering', () => {
    expect(parseDateRange({})).toEqual({ startDate: undefined, endDate: undefined });
    expect(parseDateRange({ startDate: '2024-01-15', endDate: '2024-01-31' }))
      .toEqual({ startDate: '2024-01-15', endDate: '2024-01-31' });
    expect(parseDateRange({ startDate: '2024-02-30' }).error).toEqual(expect.any(String));
    expect(parseDateRange({ startDate: '2024-1-15' }).error).toEqual(expect.any(String));
    expect(parseDateRange({ startDate: '2024-02-01', endDate: '2024-01-31' }).error)
      .toEqual(expect.any(String));
  });

  test('normalizes integer and text dates at inclusive SQL boundaries', async () => {
    const sqlite3 = jest.requireActual('sqlite3').verbose();
    const db = new sqlite3.Database(':memory:');
    const run = (sql, params = []) => new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    await run(`CREATE TABLE work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      hours DECIMAL(5,2) NOT NULL,
      description TEXT,
      date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const dates = ['2024-01-14', '2024-01-15', '2024-01-20', '2024-01-31', '2024-02-01'];
    for (const date of dates) {
      const { value } = workEntrySchema.validate({
        clientId: 1,
        hours: 1,
        date
      });
      await run(
        'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
        [1, 'test@example.com', 1, date, value.date.getTime()]
      );
    }
    await run(
      'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
      [1, 'test@example.com', 1, 'text', '2024-01-15']
    );
    const rows = await all(
      `SELECT date FROM work_entries
       WHERE client_id = ? AND ${DATE_ONLY_SQL} >= ? AND ${DATE_ONLY_SQL} <= ?
       ORDER BY date`,
      [1, '2024-01-15', '2024-01-31']
    );

    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.date === 1705276800000)).toBe(true);
    expect(rows.some((row) => row.date === '2024-01-15')).toBe(true);
    expect(rows.some((row) => row.date === 1706659200000)).toBe(true);
    expect(rows.some((row) => row.date === 1705190400000)).toBe(false);
    expect(rows.some((row) => row.date === 1706745600000)).toBe(false);
    await new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
  });
});
