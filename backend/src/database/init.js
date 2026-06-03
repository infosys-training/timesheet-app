const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let db = null;
let isClosing = false;
let isClosed = false;

function getDatabase() {
  if (!db) {
    // Reset state when creating a new database connection
    isClosing = false;
    isClosed = false;
    // Use in-memory database as specified in requirements
    db = new sqlite3.Database(':memory:', (err) => {
      if (err) {
        console.error('Error opening database:', err);
        throw err;
      }
      console.log('Connected to SQLite in-memory database');
    });
  }
  return db;
}

async function initializeDatabase() {
  const database = getDatabase();
  
  return new Promise((resolve, reject) => {
    database.serialize(() => {
      // Create users table
      database.run(`
        CREATE TABLE IF NOT EXISTS users (
          email TEXT PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create clients table
      database.run(`
        CREATE TABLE IF NOT EXISTS clients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          department TEXT,
          email TEXT,
          user_email TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
        )
      `);

      // Create activity_codes table
      database.run(`
        CREATE TABLE IF NOT EXISTS activity_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create work_entries table
      database.run(`
        CREATE TABLE IF NOT EXISTS work_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id INTEGER NOT NULL,
          user_email TEXT NOT NULL,
          hours DECIMAL(5,2) NOT NULL,
          description TEXT,
          date DATE NOT NULL,
          activity_code_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
          FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE,
          FOREIGN KEY (activity_code_id) REFERENCES activity_codes (id) ON DELETE SET NULL
        )
      `);

      // Create indexes for better performance
      database.run(`CREATE INDEX IF NOT EXISTS idx_clients_user_email ON clients (user_email)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_client_id ON work_entries (client_id)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_user_email ON work_entries (user_email)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_date ON work_entries (date)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_activity_code ON work_entries (activity_code_id)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_activity_codes_category ON activity_codes (category)`);

      // Seed default activity codes
      const defaultActivityCodes = [
        ['DEV', 'Development', 'Engineering', 'Software development and coding'],
        ['QA', 'Quality Assurance', 'Engineering', 'Testing and quality assurance'],
        ['DESIGN', 'Design', 'Engineering', 'UI/UX and graphic design'],
        ['MEETING', 'Meetings', 'Management', 'Internal and external meetings'],
        ['PLAN', 'Planning', 'Management', 'Project planning and estimation'],
        ['REVIEW', 'Code Review', 'Engineering', 'Reviewing pull requests and code'],
        ['DOCS', 'Documentation', 'Support', 'Writing and updating documentation'],
        ['SUPPORT', 'Client Support', 'Support', 'Client communication and support'],
        ['DEPLOY', 'Deployment', 'Operations', 'Release and deployment activities'],
        ['MAINT', 'Maintenance', 'Operations', 'Bug fixes and system maintenance'],
        ['TRAIN', 'Training', 'Management', 'Training and knowledge sharing'],
        ['ADMIN', 'Administration', 'Management', 'Administrative tasks'],
      ];

      for (const [code, name, category, description] of defaultActivityCodes) {
        database.run(
          `INSERT OR IGNORE INTO activity_codes (code, name, category, description) VALUES (?, ?, ?, ?)`,
          [code, name, category, description]
        );
      }

      console.log('Database tables created successfully');
      resolve();
    });
  });
}

function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (isClosed) {
      // Already closed, resolve immediately
      resolve();
      return;
    }
    
    if (isClosing) {
      // Currently closing, wait for it to complete
      const checkClosed = setInterval(() => {
        if (isClosed) {
          clearInterval(checkClosed);
          resolve();
        }
      }, 10);
      return;
    }
    
    if (!db) {
      // No database connection, resolve immediately
      resolve();
      return;
    }
    
    isClosing = true;
    db.close((err) => {
      isClosed = true;
      isClosing = false;
      db = null;
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
      resolve();
    });
  });
}

module.exports = {
  getDatabase,
  initializeDatabase,
  closeDatabase
};
