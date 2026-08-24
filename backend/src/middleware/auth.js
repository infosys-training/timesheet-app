const { getDatabase } = require('../database/init');

// Approvers are configured through the APPROVER_EMAILS environment variable
// (comma separated list of emails)
function isApproverEmail(email) {
  return (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((candidate) => candidate.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
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
      db.run('INSERT INTO users (email) VALUES (?)', [userEmail], (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        req.isApprover = isApproverEmail(userEmail);
        next();
      });
    } else {
      req.userEmail = userEmail;
      req.isApprover = isApproverEmail(userEmail);
      next();
    }
  });
}

// Restricts a route to configured approvers, must run after authenticateUser
function requireApprover(req, res, next) {
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver role required' });
  }

  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  isApproverEmail
};
