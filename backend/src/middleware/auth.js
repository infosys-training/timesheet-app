const { getDatabase } = require('../database/init');

function isApproverEmail(email) {
  return (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

function reconcileUserRole(db, email, currentRole, callback) {
  const role = isApproverEmail(email) ? 'approver' : 'member';
  if (currentRole === role) {
    return callback(null, role);
  }

  db.run('UPDATE users SET role = ? WHERE email = ?', [role, email], (err) => {
    callback(err, role);
  });
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
      db.run('INSERT INTO users (email) VALUES (?)', [userEmail], (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        reconcileUserRole(db, userEmail, null, (roleError, role) => {
          if (roleError) {
            console.error('Error reconciling user role:', roleError);
            return res.status(500).json({ error: 'Internal server error' });
          }
          req.userEmail = userEmail;
          req.role = role;
          next();
        });
      });
    } else {
      reconcileUserRole(db, userEmail, row.role || 'member', (roleError, role) => {
        if (roleError) {
          console.error('Error reconciling user role:', roleError);
          return res.status(500).json({ error: 'Internal server error' });
        }
        req.userEmail = userEmail;
        req.role = role;
        next();
      });
    }
  });
}

function requireApprover(req, res, next) {
  if (req.role !== 'approver') {
    return res.status(403).json({ error: 'Approver access required' });
  }
  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  isApproverEmail
};
