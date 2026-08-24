const { getDatabase } = require('../database/init');
const { isApproverEmail } = require('../config/approvers');

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
  const expectedRole = isApproverEmail(userEmail) ? 'approver' : 'user';

  db.get('SELECT email, role FROM users WHERE email = ?', [userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!row) {
      // Create new user
      const insertQuery = expectedRole === 'user'
        ? 'INSERT INTO users (email) VALUES (?)'
        : 'INSERT INTO users (email, role) VALUES (?, ?)';
      const insertParams = expectedRole === 'user' ? [userEmail] : [userEmail, expectedRole];
      db.run(insertQuery, insertParams, (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        req.userRole = expectedRole;
        req.isApprover = expectedRole === 'approver';
        next();
      });
    } else {
      const persistedRole = row.role || 'user';
      const finish = () => {
        req.userEmail = userEmail;
        req.userRole = expectedRole;
        req.isApprover = expectedRole === 'approver';
        next();
      };

      if (persistedRole !== expectedRole) {
        db.run(
          'UPDATE users SET role = ? WHERE email = ?',
          [expectedRole, userEmail],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating user role:', updateErr);
              return res.status(500).json({ error: 'Failed to update user role' });
            }
            finish();
          }
        );
      } else {
        finish();
      }
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
  requireApprover
};
