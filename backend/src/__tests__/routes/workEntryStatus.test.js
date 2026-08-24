const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

const mockCurrentUser = { email: 'employee@example.com', isApprover: false };

jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = mockCurrentUser.email;
    req.isApprover = mockCurrentUser.isApprover;
    next();
  },
  requireApprover: (req, res, next) => {
    if (!req.isApprover) {
      return res.status(403).json({ error: 'Approver role required' });
    }
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
  res.status(500).json({ error: 'Internal server error' });
});

const EMPLOYEE = 'employee@example.com';
const APPROVER = 'approver@example.com';

describe('Work Entry Status Workflow', () => {
  let mockDb;

  // Lookup returns the entry in `status`, the follow-up read returns the stored row
  const mockEntryWithStatus = (status, storedRow = {}) => {
    mockDb.get.mockImplementation((query, params, callback) => {
      if (query.includes('SELECT id, status FROM work_entries')) {
        return callback(null, status === null ? null : { id: 1, status });
      }
      callback(null, { id: 1, client_name: 'Client A', ...storedRow });
    });
    mockDb.run.mockImplementation(function(query, params, callback) {
      callback.call(this, null);
    });
  };

  const lastRunCall = () => mockDb.run.mock.calls[mockDb.run.mock.calls.length - 1];

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    mockCurrentUser.email = EMPLOYEE;
    mockCurrentUser.isApprover = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/work-entries/:id/submit', () => {
    test('should move a draft entry to submitted', async () => {
      mockEntryWithStatus('draft', { status: 'submitted' });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted for approval');
      expect(response.body.workEntry.status).toBe('submitted');

      const [query, values] = lastRunCall();
      expect(query).toContain('status = ?');
      expect(query).toContain('submitted_at = CURRENT_TIMESTAMP');
      expect(values).toEqual(['submitted', 1]);
    });

    test('should allow resubmitting a rejected entry and clear the review fields', async () => {
      mockEntryWithStatus('rejected', { status: 'submitted', rejection_reason: null });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      const [query] = lastRunCall();
      expect(query).toContain('rejection_reason = NULL');
      expect(query).toContain('reviewed_by = NULL');
    });

    test('should reject submitting an already submitted entry', async () => {
      mockEntryWithStatus('submitted');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot submit a work entry with status 'submitted'"
      });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should reject submitting an approved entry', async () => {
      mockEntryWithStatus('approved');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot submit a work entry with status 'approved'"
      });
    });

    test('should only look up entries owned by the caller', async () => {
      mockEntryWithStatus('draft', { status: 'submitted' });

      await request(app).post('/api/work-entries/1/submit');

      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
        [1, EMPLOYEE],
        expect.any(Function)
      );
    });

    test('should return 404 if entry does not exist for the caller', async () => {
      mockEntryWithStatus(null);

      const response = await request(app).post('/api/work-entries/999/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for an invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/invalid/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database error during the status update', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to submit work entry' });
    });

    test('should handle database error during the entry lookup', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/work-entries/:id/approve', () => {
    beforeEach(() => {
      mockCurrentUser.email = APPROVER;
      mockCurrentUser.isApprover = true;
    });

    test('should approve a submitted entry and record the approver', async () => {
      mockEntryWithStatus('submitted', { status: 'approved', reviewed_by: APPROVER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved successfully');
      expect(response.body.workEntry.status).toBe('approved');

      const [query, values] = lastRunCall();
      expect(query).toContain('reviewed_by = ?');
      expect(values).toEqual(['approved', APPROVER, 1]);
    });

    test('should look up entries across all users', async () => {
      mockEntryWithStatus('submitted', { status: 'approved' });

      await request(app).post('/api/work-entries/1/approve');

      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ?',
        [1],
        expect.any(Function)
      );
    });

    test('should reject approving a draft entry', async () => {
      mockEntryWithStatus('draft');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot approve a work entry with status 'draft'"
      });
    });

    test('should reject approving a rejected entry', async () => {
      mockEntryWithStatus('rejected');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot approve a work entry with status 'rejected'"
      });
    });

    test('should reject approving an already approved entry', async () => {
      mockEntryWithStatus('approved');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot approve a work entry with status 'approved'"
      });
    });

    test('should return 404 if the entry does not exist', async () => {
      mockEntryWithStatus(null);

      const response = await request(app).post('/api/work-entries/999/approve');

      expect(response.status).toBe(404);
    });

    test('should return 403 when the caller is not an approver', async () => {
      mockCurrentUser.email = EMPLOYEE;
      mockCurrentUser.isApprover = false;
      mockEntryWithStatus('submitted');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/work-entries/:id/reject', () => {
    beforeEach(() => {
      mockCurrentUser.email = APPROVER;
      mockCurrentUser.isApprover = true;
    });

    test('should reject a submitted entry with a reason', async () => {
      mockEntryWithStatus('submitted', { status: 'rejected', rejection_reason: 'Missing detail' });

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'Missing detail' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected');
      expect(response.body.workEntry.rejection_reason).toBe('Missing detail');

      const [, values] = lastRunCall();
      expect(values).toEqual(['rejected', APPROVER, 'Missing detail', 1]);
    });

    test('should store a null reason when none is provided', async () => {
      mockEntryWithStatus('submitted', { status: 'rejected' });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(200);
      const [, values] = lastRunCall();
      expect(values).toEqual(['rejected', APPROVER, null, 1]);
    });

    test('should return 400 for an invalid rejection reason', async () => {
      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'x'.repeat(1001) });

      expect(response.status).toBe(400);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should reject rejecting a draft entry', async () => {
      mockEntryWithStatus('draft');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot reject a work entry with status 'draft'"
      });
    });

    test('should reject rejecting an already rejected entry', async () => {
      mockEntryWithStatus('rejected');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot reject a work entry with status 'rejected'"
      });
    });

    test('should reject rejecting an approved entry', async () => {
      mockEntryWithStatus('approved');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot reject a work entry with status 'approved'"
      });
    });

    test('should return 403 when the caller is not an approver', async () => {
      mockCurrentUser.email = EMPLOYEE;
      mockCurrentUser.isApprover = false;

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'nope' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });
  });

  describe('Approved entries are locked', () => {
    test('should refuse to update an approved entry', async () => {
      mockEntryWithStatus('approved');

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot update a work entry with status 'approved'"
      });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should refuse to delete an approved entry', async () => {
      mockEntryWithStatus('approved');

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Cannot delete a work entry with status 'approved'"
      });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['draft', 'submitted', 'rejected'])('should allow updating a %s entry', async (status) => {
      mockEntryWithStatus(status, { status });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test.each(['draft', 'submitted', 'rejected'])('should allow deleting a %s entry', async (status) => {
      mockEntryWithStatus(status);

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Work entry deleted successfully' });
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    beforeEach(() => {
      mockCurrentUser.email = APPROVER;
      mockCurrentUser.isApprover = true;
    });

    test('should return all submitted entries across users', async () => {
      const pending = [
        { id: 1, status: 'submitted', user_email: EMPLOYEE, client_name: 'Client A' }
      ];
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('WHERE we.status = ?'),
        ['submitted'],
        expect.any(Function)
      );
    });

    test('should return 403 when the caller is not an approver', async () => {
      mockCurrentUser.isApprover = false;

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('should handle database error', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries?status=', () => {
    test('should filter by status', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, []);
      });

      const response = await request(app).get('/api/work-entries?status=approved');

      expect(response.status).toBe(200);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('AND we.status = ?'),
        [EMPLOYEE, 'approved'],
        expect.any(Function)
      );
    });

    test('should return 400 for an unknown status', async () => {
      const response = await request(app).get('/api/work-entries?status=pending');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid status filter');
    });
  });
});
