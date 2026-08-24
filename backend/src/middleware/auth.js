const { getDatabase } = require('../database/init');

function isApproverEmail(email) {
  const approverEmails = (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return approverEmails.includes(String(email).toLowerCase());
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
      const role = isApproverEmail(userEmail) ? 'approver' : 'user';
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
      req.userEmail = userEmail;
      req.userRole = row.role || 'user';

      if (isApproverEmail(userEmail) && req.userRole !== 'approver') {
        db.run(
          'UPDATE users SET role = ? WHERE email = ?',
          ['approver', userEmail],
          (updateErr) => {
            if (updateErr) {
              console.error('Database error:', updateErr);
              return res.status(500).json({ error: 'Internal server error' });
            }

            req.userRole = 'approver';
            next();
          }
        );
      } else {
        next();
      }
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
  isApproverEmail
};
