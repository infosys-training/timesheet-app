const { getDatabase } = require('../database/init');

function parseApproverEmails(value = process.env.APPROVER_EMAILS || '') {
  return new Set(
    value
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
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
  const approverEmails = parseApproverEmails();
  const isConfiguredApprover = approverEmails.has(userEmail.toLowerCase());
  
  // Check if user exists, create if not
  db.get('SELECT email, role FROM users WHERE email = ?', [userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!row) {
      // Create new user
      const insertQuery = isConfiguredApprover
        ? 'INSERT INTO users (email, role) VALUES (?, ?)'
        : 'INSERT INTO users (email) VALUES (?)';
      const insertParams = isConfiguredApprover ? [userEmail, 'approver'] : [userEmail];
      db.run(insertQuery, insertParams, (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        req.userRole = isConfiguredApprover ? 'approver' : 'user';
        req.isApprover = isConfiguredApprover;
        next();
      });
    } else {
      const storedRole = row.role || 'user';
      if (isConfiguredApprover && storedRole !== 'approver') {
        db.run(
          'UPDATE users SET role = ? WHERE email = ?',
          ['approver', userEmail],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating user role:', updateErr);
              return res.status(500).json({ error: 'Failed to update user role' });
            }
            req.userEmail = userEmail;
            req.userRole = 'approver';
            req.isApprover = true;
            next();
          }
        );
      } else {
        req.userEmail = userEmail;
        req.userRole = storedRole;
        req.isApprover = storedRole === 'approver';
        next();
      }
    }
  });
}

module.exports = {
  authenticateUser,
  parseApproverEmails
};
