module.exports = {
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    next();
  }
};
