const jwt = require('jsonwebtoken');
const { authenticateUser } = require('../../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

function createToken(email, expiresIn = '1h') {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn });
}

describe('Authentication Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  afterEach(() => { jest.clearAllMocks(); });

  const unauthorizedCases = [
    { desc: 'missing Authorization header', header: undefined, error: 'Authorization token required' },
    { desc: 'wrong auth scheme', header: 'Basic some-token', error: 'Authorization token required' },
    { desc: 'invalid token', header: 'Bearer invalid-token', error: 'Invalid token' },
  ];

  test.each(unauthorizedCases)('should return 401 for $desc', ({ header, error }) => {
    if (header) req.headers['authorization'] = header;
    authenticateUser(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error });
    expect(next).not.toHaveBeenCalled();
  });

  test('should return 401 for expired token', () => {
    req.headers['authorization'] = `Bearer ${createToken('test@example.com', '-1s')}`;
    authenticateUser(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token expired' });
  });

  test.each([
    'test@example.com',
    'another@example.com',
  ])('should authenticate and extract email %s from valid token', (email) => {
    req.headers['authorization'] = `Bearer ${createToken(email)}`;
    authenticateUser(req, res, next);
    expect(req.userEmail).toBe(email);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
