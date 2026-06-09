const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authRoutes = require('../../routes/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use((err, req, res, next) => {
    if (err.isJoi) return res.status(400).json({ error: 'Validation error' });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

const app = buildApp();

function createMockDb(overrides = {}) {
  return { get: jest.fn(), run: jest.fn(), ...overrides };
}

function mockDbGetError(mockDb) {
  mockDb.get.mockImplementation((q, p, cb) => cb(new Error('Database error'), null));
}

function postAuth(endpoint, body) {
  return request(app).post(endpoint).send(body);
}

describe('Auth Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => { jest.clearAllMocks(); });

  // Shared validation and db-error tests for both endpoints
  describe.each([
    { endpoint: '/api/auth/register', invalidCases: [
      { desc: 'missing password', body: { email: 'test@example.com' } },
      { desc: 'short password', body: { email: 'test@example.com', password: 'short' } },
      { desc: 'invalid email', body: { email: 'invalid-email', password: 'securepassword123' } },
    ]},
    { endpoint: '/api/auth/login', invalidCases: [
      { desc: 'missing password', body: { email: 'test@example.com' } },
      { desc: 'invalid email', body: { email: 'invalid-email', password: 'somepassword' } },
    ]},
  ])('$endpoint shared behavior', ({ endpoint, invalidCases }) => {
    test.each(invalidCases)('should return 400 for $desc', async ({ body }) => {
      const response = await postAuth(endpoint, body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation error');
    });

    test('should return 500 on database error', async () => {
      mockDbGetError(mockDb);
      const response = await postAuth(endpoint, { email: 'test@example.com', password: 'securepassword123' });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/auth/register', () => {
    test('should register a new user and return JWT', async () => {
      mockDb.get.mockImplementation((q, p, cb) => cb(null, null));
      mockDb.run.mockImplementation(function(q, p, cb) { cb.call(this, null); });

      const response = await postAuth('/api/auth/register', { email: 'newuser@example.com', password: 'securepassword123' });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('User created and logged in successfully');
      expect(response.body.user.email).toBe('newuser@example.com');
      expect(jwt.verify(response.body.token, JWT_SECRET).email).toBe('newuser@example.com');
    });

    test('should return 409 if user already exists', async () => {
      mockDb.get.mockImplementation((q, p, cb) => cb(null, { email: 'existing@example.com' }));

      const response = await postAuth('/api/auth/register', { email: 'existing@example.com', password: 'securepassword123' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('User already exists');
    });

    test('should handle database error when inserting user', async () => {
      mockDb.get.mockImplementation((q, p, cb) => cb(null, null));
      mockDb.run.mockImplementation((q, p, cb) => cb(new Error('Insert failed')));

      const response = await postAuth('/api/auth/register', { email: 'newuser@example.com', password: 'securepassword123' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to create user' });
    });
  });

  describe('POST /api/auth/login', () => {
    function mockUserWithPassword(password) {
      return bcrypt.hash(password, 10).then(hash => {
        mockDb.get.mockImplementation((q, p, cb) => {
          cb(null, { email: 'existing@example.com', password_hash: hash, created_at: '2024-01-01T00:00:00.000Z' });
        });
      });
    }

    test('should login existing user with correct password', async () => {
      await mockUserWithPassword('correctpassword');

      const response = await postAuth('/api/auth/login', { email: 'existing@example.com', password: 'correctpassword' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Login successful');
      expect(response.body.user.email).toBe('existing@example.com');
      expect(jwt.verify(response.body.token, JWT_SECRET).email).toBe('existing@example.com');
    });

    test('should return 401 for wrong password', async () => {
      await mockUserWithPassword('correctpassword');

      const response = await postAuth('/api/auth/login', { email: 'existing@example.com', password: 'wrongpassword' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid email or password');
    });

    test('should return 401 for non-existent user', async () => {
      mockDb.get.mockImplementation((q, p, cb) => cb(null, null));

      const response = await postAuth('/api/auth/login', { email: 'nonexistent@example.com', password: 'somepassword' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid email or password');
    });

    test('should handle unexpected errors', async () => {
      getDatabase.mockImplementation(() => { throw new Error('Unexpected error'); });

      const response = await postAuth('/api/auth/login', { email: 'test@example.com', password: 'somepassword' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/auth/me', () => {
    const authHeader = `Bearer ${jwt.sign({ email: 'test@example.com' }, JWT_SECRET, { expiresIn: '1h' })}`;

    function getMe() {
      return request(app).get('/api/auth/me').set('Authorization', authHeader);
    }

    test('should return current user info with valid token', async () => {
      mockDb.get.mockImplementation((q, p, cb) => {
        cb(null, { email: 'test@example.com', created_at: '2024-01-01T00:00:00.000Z' });
      });

      const response = await getMe();
      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe('test@example.com');
    });

    test('should return 401 if no token provided', async () => {
      const response = await request(app).get('/api/auth/me');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authorization token required' });
    });

    test('should return 404 if user not found', async () => {
      mockDb.get.mockImplementation((q, p, cb) => cb(null, null));
      const response = await getMe();
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'User not found' });
    });

    test('should handle database error', async () => {
      mockDbGetError(mockDb);
      const response = await getMe();
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });
});
