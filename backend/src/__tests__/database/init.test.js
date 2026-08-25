const sqlite3 = require('sqlite3');
const { getDatabase, initializeDatabase, closeDatabase } = require('../../database/init');

// Mock sqlite3
jest.mock('sqlite3', () => {
  const mockDatabase = {
    serialize: jest.fn((callback) => callback()),
    run: jest.fn((query, callback) => {
      if (typeof callback === 'function') callback(null);
    }),
    all: jest.fn((query, callback) => {
      if (typeof callback === 'function') callback(null, []);
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

describe('Database Initialization', () => {
  let consoleLogSpy, consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    
    // Reset the database singleton
    jest.resetModules();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.clearAllMocks();
  });

  describe('getDatabase', () => {
    test('should create and return database instance', () => {
      const db = getDatabase();
      
      expect(db).toBeDefined();
      expect(consoleLogSpy).toHaveBeenCalledWith('Connected to SQLite in-memory database');
    });

    test('should return same database instance on multiple calls', () => {
      const db1 = getDatabase();
      const db2 = getDatabase();
      
      expect(db1).toBe(db2);
    });

    test('should handle database connection error', () => {
      jest.resetModules();
      
      jest.doMock('sqlite3', () => {
        return {
          verbose: jest.fn(() => ({
            Database: jest.fn((path, callback) => {
              callback(new Error('Connection failed'));
              return {};
            })
          }))
        };
      });

      const { getDatabase: getDatabaseWithError } = require('../../database/init');
      
      expect(() => getDatabaseWithError()).toThrow('Connection failed');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error opening database:', expect.any(Error));
    });
  });

  describe('initializeDatabase', () => {
    test('should create all required tables', async () => {
      const db = getDatabase();
      await initializeDatabase();

      expect(db.serialize).toHaveBeenCalled();
      expect(db.run).toHaveBeenCalled();
      
      // Check that run was called for each table and index
      const runCalls = db.run.mock.calls;
      const queries = runCalls.map(call => call[0]);
      
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS clients'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS work_entries'))).toBe(true);
    });

    test('should create indexes for performance', async () => {
      const db = getDatabase();
      await initializeDatabase();

      const runCalls = db.run.mock.calls;
      const queries = runCalls.map(call => call[0]);
      
      expect(queries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_clients_user_email'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_work_entries_client_id'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_work_entries_user_email'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_work_entries_date'))).toBe(true);
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
      // Reset close mock to default behavior (no error)
      db.close.mockImplementation((callback) => callback(null));
      closeDatabase();
      closeDatabase(); // Second call should not throw

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('Database Schema', () => {
    test('users table should have correct structure', async () => {
      const db = getDatabase();
      await initializeDatabase();

      const userTableQuery = db.run.mock.calls.find(call => 
        call[0].includes('CREATE TABLE IF NOT EXISTS users')
      );

      expect(userTableQuery).toBeDefined();
      expect(userTableQuery[0]).toContain('email TEXT PRIMARY KEY');
      expect(userTableQuery[0]).toContain("role TEXT NOT NULL DEFAULT 'member'");
      expect(userTableQuery[0]).toContain("CHECK (role IN ('member', 'approver'))");
      expect(userTableQuery[0]).toContain('created_at DATETIME DEFAULT CURRENT_TIMESTAMP');
    });

    test('clients table should have foreign key to users', async () => {
      const db = getDatabase();
      await initializeDatabase();

      const clientTableQuery = db.run.mock.calls.find(call => 
        call[0].includes('CREATE TABLE IF NOT EXISTS clients')
      );

      expect(clientTableQuery).toBeDefined();
      expect(clientTableQuery[0]).toContain('user_email TEXT NOT NULL');
      expect(clientTableQuery[0]).toContain('FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE');
    });

    test('work_entries table should have foreign keys', async () => {
      const db = getDatabase();
      await initializeDatabase();

      const workEntriesQuery = db.run.mock.calls.find(call => 
        call[0].includes('CREATE TABLE IF NOT EXISTS work_entries')
      );

      expect(workEntriesQuery).toBeDefined();
      expect(workEntriesQuery[0]).toContain('FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE');
      expect(workEntriesQuery[0]).toContain('FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE');
      expect(workEntriesQuery[0]).toContain("status TEXT NOT NULL DEFAULT 'draft'");
      expect(workEntriesQuery[0]).toContain("CHECK (status IN ('draft', 'submitted', 'approved', 'rejected'))");
      expect(workEntriesQuery[0]).toContain('reviewed_by TEXT');
      expect(workEntriesQuery[0]).toContain('review_note TEXT');
    });
  });
});
