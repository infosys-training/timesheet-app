const { getDatabase } = require('../database/init');

const APPROVER_ROLE = 'approver';
const EMPLOYEE_ROLE = 'employee';

// Approvers are configured out of band, since accounts are created on first request
function roleForEmail(email) {
  const approvers = (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return approvers.includes(email.toLowerCase()) ? APPROVER_ROLE : EMPLOYEE_ROLE;
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
      const role = roleForEmail(userEmail);

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
      req.userRole = row.role || EMPLOYEE_ROLE;
      next();
    }
  });
}

// Restricts a route to users with the approver role
function requireApprover(req, res, next) {
  if (req.userRole !== APPROVER_ROLE) {
    return res.status(403).json({ error: 'Approver role required' });
  }

  next();
}

module.exports = {
  authenticateUser,
  requireApprover,
  roleForEmail,
  APPROVER_ROLE,
  EMPLOYEE_ROLE
};
