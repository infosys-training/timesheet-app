function initializeSchema(database) {
  // Create users table
  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'approver')),
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

  // Create work_entries table
  database.run(`
    CREATE TABLE IF NOT EXISTS work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      hours DECIMAL(5,2) NOT NULL,
      description TEXT,
      date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewed_by TEXT,
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
      FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
    )
  `);

  // Create indexes for better performance
  database.run(`CREATE INDEX IF NOT EXISTS idx_clients_user_email ON clients (user_email)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_client_id ON work_entries (client_id)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_user_email ON work_entries (user_email)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_date ON work_entries (date)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_status ON work_entries (status)`);
}

module.exports = {
  initializeSchema
};
