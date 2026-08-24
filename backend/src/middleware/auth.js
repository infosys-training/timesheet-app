const { getDatabase } = require('../database/init');

function getApproverEmails() {
  return new Set(
    (process.env.APPROVER_EMAILS || '')
      .split(',')
      .map(email => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isConfiguredApprover(email) {
  return getApproverEmails().has(email.toLowerCase());
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
  db.get('SELECT email FROM users WHERE email = ?', [userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!row) {
      // Create new user
      const role = isConfiguredApprover(userEmail) ? 'approver' : 'user';
      const insert = role === 'approver'
        ? ['INSERT INTO users (email, role) VALUES (?, ?)', [userEmail, role]]
        : ['INSERT INTO users (email) VALUES (?)', [userEmail]];
      db.run(insert[0], insert[1], (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        req.userRole = role;
        req.isApprover = role === 'approver';
        next();
      });
    } else {
      db.get('SELECT role FROM users WHERE email = ?', [userEmail], (roleErr, roleRow) => {
        if (roleErr) {
          console.error('Database error:', roleErr);
          return res.status(500).json({ error: 'Internal server error' });
        }
        req.userEmail = userEmail;
        req.userRole = isConfiguredApprover(userEmail) ? 'approver' : (roleRow?.role || 'user');
        req.isApprover = req.userRole === 'approver';
        next();
      });
    }
  });
}

function requireApprover(req, res, next) {
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver access required' });
  }
  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  isConfiguredApprover
};
