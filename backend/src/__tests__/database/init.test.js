const sqlite3 = require('sqlite3');
const { getDatabase, initializeDatabase, closeDatabase } = require('../../database/init');

jest.mock('sqlite3', () => {
  const mockDatabase = {
    serialize: jest.fn((callback) => callback()),
    run: jest.fn((query, callback) => {
      if (typeof callback === 'function') callback(null);
    }),
    close: jest.fn((callback) => callback(null))
  };

  return {
    verbose: jest.fn(() => ({
      Database: jest.fn((path, callback) => {
        callback(null);
        return mockDatabase;
      })
    }))
  };
});

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn()
}));

describe('Database Initialization', () => {
  let consoleLogSpy, consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    jest.resetModules();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.clearAllMocks();
  });

  async function initAndGetQueries() {
    const db = getDatabase();
    await initializeDatabase();
    return db.run.mock.calls.map(call => call[0]);
  }

  describe('getDatabase', () => {
    test('should create and return database instance', () => {
      const db = getDatabase();
      expect(db).toBeDefined();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Connected to SQLite database'));
    });

    test('should return same database instance on multiple calls', () => {
      expect(getDatabase()).toBe(getDatabase());
    });

    test('should handle database connection error', () => {
      jest.resetModules();
      jest.doMock('sqlite3', () => ({
        verbose: jest.fn(() => ({
          Database: jest.fn((path, callback) => {
            callback(new Error('Connection failed'));
            return {};
          })
        }))
      }));
      jest.doMock('fs', () => ({ existsSync: jest.fn().mockReturnValue(true), mkdirSync: jest.fn() }));

      const { getDatabase: getDatabaseWithError } = require('../../database/init');
      expect(() => getDatabaseWithError()).toThrow('Connection failed');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error opening database:', expect.any(Error));
    });
  });

  describe('initializeDatabase', () => {
    test('should create all required tables and indexes', async () => {
      const queries = await initAndGetQueries();
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS clients'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS work_entries'))).toBe(true);
      expect(queries.some(q => q.includes('idx_clients_user_email'))).toBe(true);
      expect(queries.some(q => q.includes('idx_work_entries_client_id'))).toBe(true);
      expect(queries.some(q => q.includes('idx_work_entries_user_email'))).toBe(true);
      expect(queries.some(q => q.includes('idx_work_entries_date'))).toBe(true);
    });

    test('should enable WAL mode, busy timeout, and foreign keys', async () => {
      const queries = await initAndGetQueries();
      expect(queries.some(q => q.includes('PRAGMA journal_mode = WAL'))).toBe(true);
      expect(queries.some(q => q.includes('PRAGMA busy_timeout = 5000'))).toBe(true);
      expect(queries.some(q => q.includes('PRAGMA foreign_keys = ON'))).toBe(true);
    });

    test('should log success message', async () => {
      await initializeDatabase();
      expect(consoleLogSpy).toHaveBeenCalledWith('Database tables created successfully');
    });

    test('should resolve promise on success', async () => {
      await expect(initializeDatabase()).resolves.toBeUndefined();
    });
  });

  describe('closeDatabase', () => {
    test('should close database connection', () => {
      const db = getDatabase();
      closeDatabase();
      expect(db.close).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('Database connection closed');
    });

    test('should handle close error gracefully', () => {
      const db = getDatabase();
      db.close.mockImplementation((callback) => callback(new Error('Close error')));
      closeDatabase();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error closing database:', expect.any(Error));
    });

    test('should handle multiple close calls safely', () => {
      const db = getDatabase();
      db.close.mockImplementation((callback) => callback(null));
      closeDatabase();
      closeDatabase();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('Database Schema', () => {
    test.each([
      ['users', ['email TEXT PRIMARY KEY', 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP']],
      ['clients', ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'name TEXT NOT NULL', 'user_email TEXT NOT NULL', 'FOREIGN KEY (user_email) REFERENCES users (email)']],
      ['work_entries', ['client_id INTEGER NOT NULL', 'hours DECIMAL(5,2) NOT NULL', 'FOREIGN KEY (client_id) REFERENCES clients (id)']],
    ])('%s table should have correct structure', async (tableName, expectedColumns) => {
      const queries = await initAndGetQueries();
      const tableQuery = queries.find(q => q.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`));
      expect(tableQuery).toBeDefined();
      expectedColumns.forEach(col => expect(tableQuery).toContain(col));
    });
  });
});
