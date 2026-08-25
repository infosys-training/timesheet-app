const usersTable = `
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'approver')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const workEntriesTable = `
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
    review_note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users (email)
  )
`;

const workEntriesStatusIndex = 'CREATE INDEX IF NOT EXISTS idx_work_entries_status ON work_entries (status)';

const usersAddedColumns = [
  { name: 'role', definition: "TEXT NOT NULL DEFAULT 'member'" }
];

const workEntriesAddedColumns = [
  { name: 'status', definition: "TEXT NOT NULL DEFAULT 'draft'" },
  { name: 'submitted_at', definition: 'DATETIME' },
  { name: 'reviewed_at', definition: 'DATETIME' },
  { name: 'reviewed_by', definition: 'TEXT' },
  { name: 'review_note', definition: 'TEXT' }
];

module.exports = {
  usersTable,
  workEntriesTable,
  workEntriesStatusIndex,
  usersAddedColumns,
  workEntriesAddedColumns
};
