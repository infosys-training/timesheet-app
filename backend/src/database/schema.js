function run(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.run(query, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function all(database, query, params = []) {
  return new Promise((resolve, reject) => {
    database.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initializeDatabase(database, options) {
  const {
    enableForeignKeys = false,
    getApproverEmails,
    includeClientContactFields = false
  } = options;
  const clientColumns = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'name TEXT NOT NULL',
    'description TEXT',
    ...(includeClientContactFields ? ['department TEXT', 'email TEXT'] : []),
    'user_email TEXT NOT NULL',
    'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
    'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
    'FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE'
  ];

  return new Promise((resolve, reject) => {
    database.serialize(async () => {
      try {
        if (enableForeignKeys) {
          await run(database, 'PRAGMA foreign_keys = ON');
        }

        await run(database, `
        CREATE TABLE IF NOT EXISTS users (
          email TEXT PRIMARY KEY,
          role TEXT NOT NULL DEFAULT 'user',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        await run(database, `
        CREATE TABLE IF NOT EXISTS clients (
          ${clientColumns.join(',\n          ')}
        )
        `);

        await run(database, `
        CREATE TABLE IF NOT EXISTS work_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id INTEGER NOT NULL,
          user_email TEXT NOT NULL,
          hours DECIMAL(5,2) NOT NULL,
          description TEXT,
          date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
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

        const usersColumns = await all(database, 'PRAGMA table_info(users)');
        if (!usersColumns.some((column) => column.name === 'role')) {
          await run(database, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
        }

        const workEntryColumns = await all(database, 'PRAGMA table_info(work_entries)');
        const missingWorkEntryColumns = [
          ['status', "TEXT NOT NULL DEFAULT 'draft'"],
          ['submitted_at', 'DATETIME'],
          ['reviewed_at', 'DATETIME'],
          ['reviewed_by', 'TEXT'],
          ['rejection_reason', 'TEXT']
        ];
        for (const [name, definition] of missingWorkEntryColumns) {
          if (!workEntryColumns.some((column) => column.name === name)) {
            await run(database, `ALTER TABLE work_entries ADD COLUMN ${name} ${definition}`);
          }
        }

        await run(database, `CREATE INDEX IF NOT EXISTS idx_clients_user_email ON clients (user_email)`);
        await run(database, `CREATE INDEX IF NOT EXISTS idx_work_entries_client_id ON work_entries (client_id)`);
        await run(database, `CREATE INDEX IF NOT EXISTS idx_work_entries_user_email ON work_entries (user_email)`);
        await run(database, `CREATE INDEX IF NOT EXISTS idx_work_entries_date ON work_entries (date)`);
        await run(database, `CREATE INDEX IF NOT EXISTS idx_work_entries_status ON work_entries (status)`);

        for (const email of getApproverEmails()) {
          await run(
            database,
            `INSERT INTO users (email, role) VALUES (?, 'approver')
             ON CONFLICT(email) DO UPDATE SET role = 'approver'`,
            [email]
          );
        }

        console.log('Database tables created successfully');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  initializeDatabase
};
