const { authenticateUser, requireApprover, isApprover } = require('../../middleware/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

describe('Authentication Middleware', () => {
  let req, res, next, mockDb;

  beforeEach(() => {
    req = {
      headers: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    
    mockDb = {
      get: jest.fn(),
      run: jest.fn()
    };
    
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Email Header Validation', () => {
    test('should return 401 if x-user-email header is missing', () => {
      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'User email required in x-user-email header'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 400 if email format is invalid', () => {
      req.headers['x-user-email'] = 'invalid-email';

      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid email format'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should accept valid email format', () => {
      req.headers['x-user-email'] = 'test@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'test@example.com' });
      });

      authenticateUser(req, res, next);

      expect(mockDb.get).toHaveBeenCalled();
    });
  });

  describe('Existing User Authentication', () => {
    test('should authenticate existing user and call next()', (done) => {
      req.headers['x-user-email'] = 'existing@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'existing@example.com' });
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.userEmail).toBe('existing@example.com');
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        done();
      });
    });

    test('should handle database error when checking user', (done) => {
      req.headers['x-user-email'] = 'test@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Internal server error'
        });
        expect(next).not.toHaveBeenCalled();
        done();
      });
    });
  });

  describe('New User Creation', () => {
    test('should create new user if not exists and call next()', (done) => {
      req.headers['x-user-email'] = 'newuser@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // User doesn't exist
      });
      
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (email) VALUES (?)',
          ['newuser@example.com'],
          expect.any(Function)
        );
        expect(req.userEmail).toBe('newuser@example.com');
        expect(next).toHaveBeenCalled();
        done();
      });
    });

    test('should handle error when creating new user', (done) => {
      req.headers['x-user-email'] = 'newuser@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });
      
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Insert failed'));
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Failed to create user'
        });
        expect(next).not.toHaveBeenCalled();
        done();
      });
    });
  });

  describe('Email Format Edge Cases', () => {
    test('should reject email without @', () => {
      req.headers['x-user-email'] = 'notanemail';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should reject email without domain', () => {
      req.headers['x-user-email'] = 'test@';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should reject email without TLD', () => {
      req.headers['x-user-email'] = 'test@domain';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should accept email with subdomain', () => {
      req.headers['x-user-email'] = 'test@mail.example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'test@mail.example.com' });
      });

      authenticateUser(req, res, next);
      expect(mockDb.get).toHaveBeenCalled();
    });
  });

  describe('Approver Role', () => {
    afterEach(() => {
      delete process.env.APPROVER_EMAILS;
    });

    test('isApprover recognises a configured approver', () => {
      process.env.APPROVER_EMAILS = 'lead@example.com, manager@example.com';

      expect(isApprover('manager@example.com')).toBe(true);
    });

    test('isApprover ignores casing', () => {
      process.env.APPROVER_EMAILS = 'Lead@Example.com';

      expect(isApprover('lead@example.com')).toBe(true);
    });

    test('isApprover rejects a user that is not configured', () => {
      process.env.APPROVER_EMAILS = 'lead@example.com';

      expect(isApprover('test@example.com')).toBe(false);
    });

    test('isApprover returns false when no approvers are configured', () => {
      expect(isApprover('lead@example.com')).toBe(false);
    });

    test('isApprover returns false without an email', () => {
      process.env.APPROVER_EMAILS = 'lead@example.com';

      expect(isApprover(undefined)).toBe(false);
    });

    test('authenticateUser exposes the approver flag on the request', (done) => {
      process.env.APPROVER_EMAILS = 'lead@example.com';
      req.headers['x-user-email'] = 'lead@example.com';

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'lead@example.com' });
      });
      next.mockImplementation(() => {
        expect(req.isApprover).toBe(true);
        done();
      });

      authenticateUser(req, res, next);
    });

    test('requireApprover allows an approver through', () => {
      process.env.APPROVER_EMAILS = 'lead@example.com';
      req.userEmail = 'lead@example.com';

      requireApprover(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('requireApprover returns 403 for a non approver', () => {
      process.env.APPROVER_EMAILS = 'lead@example.com';
      req.userEmail = 'test@example.com';

      requireApprover(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Approver role required' });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
