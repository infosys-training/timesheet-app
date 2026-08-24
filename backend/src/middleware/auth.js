const { getDatabase } = require('../database/init');

function getApproverEmails() {
  return new Set(
    (process.env.APPROVER_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getRoleForEmail(email) {
  return getApproverEmails().has(email.trim().toLowerCase()) ? 'approver' : 'employee';
}

function syncUserRole(db, email, row, callback) {
  const role = row.role || 'employee';
  const configuredRole = getRoleForEmail(email);

  if (configuredRole === 'approver' && role !== configuredRole) {
    return db.run(
      'UPDATE users SET role = ? WHERE email = ?',
      [configuredRole, email],
      (err) => callback(err, configuredRole)
    );
  }

  callback(null, role);
}

// Simple email-based authentication middleware
function authenticateUser(req, res, next) {
  const userEmail = req.headers['x-user-email'];
  
  if (!userEmail) {
    return res.status(401).json({ error: 'User email required in x-user-email header' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(userEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const db = getDatabase();
  
  // Check if user exists, create if not
  db.get('SELECT email, role FROM users WHERE email = ?', [userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!row) {
      // Create new user
      const role = getRoleForEmail(userEmail);
      db.run('INSERT INTO users (email, role) VALUES (?, ?)', [userEmail, role], (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        req.userRole = role;
        next();
      });
    } else {
      syncUserRole(db, userEmail, row, (syncError, role) => {
        if (syncError) {
          console.error('Error syncing user role:', syncError);
          return res.status(500).json({ error: 'Internal server error' });
        }

        req.userEmail = userEmail;
        req.userRole = role;
        next();
      });
    }
  });
}

function requireApprover(req, res, next) {
  if (req.userRole !== 'approver') {
    return res.status(403).json({ error: 'Approver role required' });
  }
  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  getApproverEmails,
  getRoleForEmail,
  syncUserRole
};
