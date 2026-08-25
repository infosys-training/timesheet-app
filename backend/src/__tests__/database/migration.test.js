jest.unmock('sqlite3');

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'timesheet-migration-'));
const databasePath = path.join(tempDirectory, 'timesheet.db');
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = databasePath;

const {
  getDatabase,
  initializeDatabase,
  closeDatabase
} = require('../../database/init');

function run(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.run(query, params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function all(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function close(database) {
  return new Promise((resolve, reject) => {
    database.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

describe('Database schema migration', () => {
  let legacyDatabase;

  beforeAll(async () => {
    legacyDatabase = new sqlite3.Database(databasePath);
    await run(legacyDatabase, `
      CREATE TABLE users (
        email TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(legacyDatabase, `
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        user_email TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
      )
    `);
    await run(legacyDatabase, `
      CREATE TABLE work_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        hours DECIMAL(5,2) NOT NULL,
        description TEXT,
        date DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
      )
    `);
    await run(legacyDatabase, 'INSERT INTO users (email) VALUES (?)', ['legacy@example.com']);
    await run(
      legacyDatabase,
      'INSERT INTO clients (name, user_email) VALUES (?, ?)',
      ['Legacy Client', 'legacy@example.com']
    );
    await run(
      legacyDatabase,
      `INSERT INTO work_entries
       (client_id, user_email, hours, description, date)
       VALUES (?, ?, ?, ?, ?)`,
      [1, 'legacy@example.com', 4, 'Legacy entry', '2026-08-24']
    );
    await close(legacyDatabase);
    legacyDatabase = null;

    await initializeDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  test('adds approval columns and preserves existing data', async () => {
    const database = getDatabase();
    const usersColumns = await all(database, 'PRAGMA table_info(users)');
    const workEntriesColumns = await all(database, 'PRAGMA table_info(work_entries)');
    const user = (await all(database, 'SELECT email, role FROM users'))[0];
    const workEntry = (
      await all(database, 'SELECT status, submitted_at, reviewed_at, reviewed_by, review_note FROM work_entries')
    )[0];
    const indexes = await all(database, 'PRAGMA index_list(work_entries)');

    expect(usersColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['email', 'role', 'created_at'])
    );
    expect(workEntriesColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'status',
        'submitted_at',
        'reviewed_at',
        'reviewed_by',
        'review_note'
      ])
    );
    expect(user).toEqual({ email: 'legacy@example.com', role: 'member' });
    expect(workEntry).toEqual({
      status: 'draft',
      submitted_at: null,
      reviewed_at: null,
      reviewed_by: null,
      review_note: null
    });
    expect(indexes.map((index) => index.name)).toContain('idx_work_entries_status');
  });

  test('is idempotent on a second initialization', async () => {
    await expect(initializeDatabase()).resolves.toBeUndefined();
  });
});
