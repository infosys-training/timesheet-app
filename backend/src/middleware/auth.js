const { getDatabase } = require('../database/init');

function isApproverEmail(email) {
  const approverEmails = (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return approverEmails.includes(email.toLowerCase());
}

function getRoleForEmail(email) {
  return isApproverEmail(email) ? 'approver' : 'employee';
}

function setAuthenticatedUser(req, userEmail, role, next) {
  req.userEmail = userEmail;
  req.userRole = role;
  req.isApprover = role === 'approver';
  next();
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
        
        setAuthenticatedUser(req, userEmail, role, next);
      });
    } else {
      const role = getRoleForEmail(userEmail);
      if (row.role !== undefined && row.role !== role) {
        db.run(
          'UPDATE users SET role = ? WHERE email = ?',
          [role, userEmail],
          (updateErr) => {
            if (updateErr) {
              console.error('Database error:', updateErr);
              return res.status(500).json({ error: 'Internal server error' });
            }
            setAuthenticatedUser(req, userEmail, role, next);
          }
        );
      } else {
        setAuthenticatedUser(req, userEmail, role, next);
      }
    }
  });
}

function requireApprover(req, res, next) {
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver role required' });
  }
  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  getRoleForEmail
};
