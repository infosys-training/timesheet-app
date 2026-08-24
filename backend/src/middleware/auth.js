const { getDatabase } = require('../database/init');

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
  db.get('SELECT email, is_approver FROM users WHERE email = ?', [userEmail], (err, row) => {
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
        
        req.userEmail = userEmail;
        req.isApprover = false;
        next();
      });
    } else {
      req.userEmail = userEmail;
      req.isApprover = !!row.is_approver;
      next();
    }
  });
}

// Restricts a route to users flagged as approvers
function requireApprover(req, res, next) {
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver role required' });
  }

  next();
}

module.exports = {
  authenticateUser,
  requireApprover
};
