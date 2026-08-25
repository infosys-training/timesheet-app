jest.mock('sqlite3', () => jest.requireActual('sqlite3'));

const { getDatabase, initializeDatabase, closeDatabase } = require('../../database/init');

function run(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.run(query, params, function(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });
}

function get(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.get(query, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

describe('SQLite foreign-key enforcement', () => {
  let database;

  beforeAll(async () => {
    database = getDatabase();
    await initializeDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test('enables foreign keys and cascades deleted clients to work entries', async () => {
    const pragma = await get(database, 'PRAGMA foreign_keys');
    expect(pragma.foreign_keys).toBe(1);

    await run(database, 'INSERT INTO users (email) VALUES (?)', ['foreign-keys@example.com']);
    const client = await run(
      database,
      'INSERT INTO clients (name, user_email) VALUES (?, ?)',
      ['Cascade Client', 'foreign-keys@example.com']
    );
    await run(
      database,
      'INSERT INTO work_entries (client_id, user_email, hours, date) VALUES (?, ?, ?, ?)',
      [client.lastID, 'foreign-keys@example.com', 5, '2024-01-15']
    );

    await run(database, 'DELETE FROM clients WHERE id = ?', [client.lastID]);

    const remaining = await get(
      database,
      'SELECT COUNT(*) AS count FROM work_entries WHERE client_id = ?',
      [client.lastID]
    );
    expect(remaining.count).toBe(0);
  });
});
