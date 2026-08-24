const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

let mockIsApprover = false;
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = mockIsApprover ? 'approver@example.com' : 'owner@example.com';
    req.userRole = mockIsApprover ? 'approver' : 'user';
    req.isApprover = mockIsApprover;
    next();
  }
}));

const app = express();
app.use(express.json());
app.use('/api/work-entries', workEntryRoutes);
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  return res.status(500).json({ error: 'Internal server error' });
});

describe('Work Entry Approval Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockIsApprover = false;
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const workEntry = (status, userEmail = 'owner@example.com') => ({
    id: 1,
    user_email: userEmail,
    status
  });

  test.each(['draft', 'rejected'])('submits a %s entry', async (status) => {
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry(status)));
    mockDb.run.mockImplementation((query, params, callback) => callback(null));

    const response = await request(app).post('/api/work-entries/1/submit');

    expect(response.status).toBe(200);
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining("status = 'submitted'"),
      [1, 'owner@example.com'],
      expect.any(Function)
    );
  });

  test.each(['submitted', 'approved'])('refuses submit from %s', async (status) => {
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry(status)));

    const response = await request(app).post('/api/work-entries/1/submit');

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(`Cannot submit a work entry with status ${status}`);
  });

  test('approves a submitted entry', async () => {
    mockIsApprover = true;
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry('submitted')));
    mockDb.run.mockImplementation((query, params, callback) => callback(null));

    const response = await request(app).post('/api/work-entries/1/approve');

    expect(response.status).toBe(200);
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining("status = 'approved'"),
      ['approver@example.com', 1],
      expect.any(Function)
    );
  });

  test.each(['draft', 'approved', 'rejected'])('refuses approve from %s', async (status) => {
    mockIsApprover = true;
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry(status)));

    const response = await request(app).post('/api/work-entries/1/approve');

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(`Cannot approve a work entry with status ${status}`);
  });

  test('rejects a submitted entry with a reason', async () => {
    mockIsApprover = true;
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry('submitted')));
    mockDb.run.mockImplementation((query, params, callback) => callback(null));

    const response = await request(app)
      .post('/api/work-entries/1/reject')
      .send({ reason: 'Please add more detail' });

    expect(response.status).toBe(200);
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining("status = 'rejected'"),
      ['approver@example.com', 'Please add more detail', 1],
      expect.any(Function)
    );
  });

  test.each(['draft', 'approved', 'rejected'])('refuses reject from %s', async (status) => {
    mockIsApprover = true;
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry(status)));

    const response = await request(app).post('/api/work-entries/1/reject').send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(`Cannot reject a work entry with status ${status}`);
  });

  test.each(['/approve', '/reject'])('refuses %s for non-approver', async (path) => {
    const response = await request(app).post(`/api/work-entries/1${path}`);
    expect(response.status).toBe(403);
  });

  test('prevents an approver from reviewing their own entry', async () => {
    mockIsApprover = true;
    mockDb.get.mockImplementation((query, params, callback) => {
      callback(null, workEntry('submitted', 'approver@example.com'));
    });

    const response = await request(app).post('/api/work-entries/1/approve');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Approvers cannot review their own work entries');
  });

  test.each(['put', 'delete'])('%s refuses approved entries', async (method) => {
    mockDb.get.mockImplementation((query, params, callback) => callback(null, workEntry('approved')));

    const response = method === 'put'
      ? await request(app).put('/api/work-entries/1').send({ hours: 4 })
      : await request(app).delete('/api/work-entries/1');

    expect(response.status).toBe(409);
  });

  test('returns pending approvals to approvers', async () => {
    mockIsApprover = true;
    const entries = [workEntry('submitted')];
    mockDb.all.mockImplementation((query, params, callback) => callback(null, entries));

    const response = await request(app).get('/api/work-entries/pending-approvals');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ workEntries: entries });
    expect(mockDb.all).toHaveBeenCalledWith(expect.stringContaining("we.status = 'submitted'"), [], expect.any(Function));
  });

  test('refuses pending approvals for non-approvers', async () => {
    const response = await request(app).get('/api/work-entries/pending-approvals');
    expect(response.status).toBe(403);
    expect(mockDb.all).not.toHaveBeenCalled();
  });

  test('supports a valid status filter', async () => {
    mockDb.all.mockImplementation((query, params, callback) => callback(null, []));

    const response = await request(app).get('/api/work-entries?status=rejected');

    expect(response.status).toBe(200);
    expect(mockDb.all).toHaveBeenCalledWith(
      expect.stringContaining('AND we.status = ?'),
      ['owner@example.com', 'rejected'],
      expect.any(Function)
    );
  });

  test('rejects an invalid status filter', async () => {
    const response = await request(app).get('/api/work-entries?status=invalid');
    expect(response.status).toBe(400);
    expect(mockDb.all).not.toHaveBeenCalled();
  });
});
