const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
// Only the authentication step is faked; the real approver check is exercised
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');

  return {
    ...actual,
    authenticateUser: (req, res, next) => {
      req.userEmail = global.__testUser.email;
      req.userRole = global.__testUser.role;
      next();
    }
  };
});

const app = express();
app.use(express.json());
app.use('/api/work-entries', workEntryRoutes);
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const EMPLOYEE = { email: 'employee@example.com', role: 'employee' };
const APPROVER = { email: 'approver@example.com', role: 'approver' };

describe('Work Entry Approval', () => {
  let mockDb;

  // Serves the status lookup with the given entry (null = not found) and the
  // post-update re-read with the stored entry
  function mockEntry(entry) {
    mockDb.get.mockImplementation((query, params, callback) => {
      if (query.includes('work_entries we')) {
        return callback(null, { id: 1, client_name: 'Client A', ...(entry || {}) });
      }
      callback(null, entry);
    });
    mockDb.run.mockImplementation((query, params, callback) => callback(null));
  }

  function lastRun() {
    return mockDb.run.mock.calls[mockDb.run.mock.calls.length - 1];
  }

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    global.__testUser = EMPLOYEE;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete global.__testUser;
  });

  describe('valid transitions', () => {
    test('draft -> submitted via submit', async () => {
      mockEntry({ id: 1, status: 'draft' });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted for approval');
      expect(lastRun()[0]).toContain("status = 'submitted'");
      expect(lastRun()[0]).toContain('submitted_at = CURRENT_TIMESTAMP');
      expect(lastRun()[1]).toEqual([1, EMPLOYEE.email]);
    });

    test('rejected -> submitted via submit clears the previous review', async () => {
      mockEntry({ id: 1, status: 'rejected' });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(lastRun()[0]).toContain('reviewed_at = NULL');
      expect(lastRun()[0]).toContain('reviewed_by = NULL');
      expect(lastRun()[0]).toContain('review_note = NULL');
    });

    test('submitted -> approved via approve records the reviewer', async () => {
      global.__testUser = APPROVER;
      mockEntry({ id: 1, status: 'submitted' });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved');
      expect(lastRun()[1]).toEqual(['approved', APPROVER.email, null, 1]);
    });

    test('submitted -> rejected via reject stores the review note', async () => {
      global.__testUser = APPROVER;
      mockEntry({ id: 1, status: 'submitted' });

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ note: 'Hours look too high' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected');
      expect(lastRun()[1]).toEqual(['rejected', APPROVER.email, 'Hours look too high', 1]);
    });
  });

  describe('rejected transitions', () => {
    const cases = [
      { action: 'submit', from: 'submitted', user: EMPLOYEE, error: "Cannot submit a work entry with status 'submitted'" },
      { action: 'submit', from: 'approved', user: EMPLOYEE, error: "Cannot submit a work entry with status 'approved'" },
      { action: 'approve', from: 'draft', user: APPROVER, error: "Cannot approve a work entry with status 'draft'" },
      { action: 'approve', from: 'rejected', user: APPROVER, error: "Cannot approve a work entry with status 'rejected'" },
      { action: 'approve', from: 'approved', user: APPROVER, error: "Cannot approve a work entry with status 'approved'" },
      { action: 'reject', from: 'draft', user: APPROVER, error: "Cannot reject a work entry with status 'draft'" },
      { action: 'reject', from: 'rejected', user: APPROVER, error: "Cannot reject a work entry with status 'rejected'" },
      { action: 'reject', from: 'approved', user: APPROVER, error: "Cannot reject a work entry with status 'approved'" }
    ];

    test.each(cases)('rejects $action from $from with 409', async ({ action, from, user, error }) => {
      global.__testUser = user;
      mockEntry({ id: 1, status: from });

      const response = await request(app).post(`/api/work-entries/1/${action}`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error });
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    test.each(['approve', 'reject'])('employees cannot %s', async (action) => {
      mockEntry({ id: 1, status: 'submitted' });

      const response = await request(app).post(`/api/work-entries/1/${action}`);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('employees cannot list pending approvals', async () => {
      const response = await request(app).get('/api/work-entries/pending');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('submit is scoped to the owner of the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        expect(params).toEqual([1, EMPLOYEE.email]);
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('approvers review entries owned by other users', async () => {
      global.__testUser = APPROVER;
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          return callback(null, { id: 1, status: 'approved' });
        }
        expect(params).toEqual([1]);
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/work-entries/pending', () => {
    test('returns submitted entries for approvers', async () => {
      global.__testUser = APPROVER;
      const pending = [{ id: 1, status: 'submitted', user_email: EMPLOYEE.email, client_name: 'Client A' }];

      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain("we.status = 'submitted'");
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
    });

    test('handles database errors', async () => {
      global.__testUser = APPROVER;
      mockDb.all.mockImplementation((query, params, callback) => callback(new Error('boom'), null));

      const response = await request(app).get('/api/work-entries/pending');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('status filter on GET /api/work-entries', () => {
    test('filters by status', async () => {
      mockDb.all.mockImplementation((query, params, callback) => callback(null, []));

      const response = await request(app).get('/api/work-entries?status=approved');

      expect(response.status).toBe(200);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('AND we.status = ?'),
        [EMPLOYEE.email, 'approved'],
        expect.any(Function)
      );
    });

    test('rejects unknown statuses', async () => {
      const response = await request(app).get('/api/work-entries?status=archived');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Status must be one of: draft, submitted, approved, rejected'
      });
    });
  });

  describe('approved entries are locked', () => {
    test('PUT returns 409 for approved entries', async () => {
      mockEntry({ id: 1, status: 'approved' });

      const response = await request(app).put('/api/work-entries/1').send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries can no longer be edited' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('DELETE returns 409 for approved entries', async () => {
      mockEntry({ id: 1, status: 'approved' });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries can no longer be deleted' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['draft', 'submitted', 'rejected'])('PUT is allowed for %s entries', async (status) => {
      mockEntry({ id: 1, status });

      const response = await request(app).put('/api/work-entries/1').send({ hours: 8 });

      expect(response.status).toBe(200);
    });
  });

  describe('input validation and error handling', () => {
    test.each(['submit', 'approve', 'reject'])('%s returns 400 for an invalid id', async (action) => {
      global.__testUser = APPROVER;

      const response = await request(app).post(`/api/work-entries/invalid/${action}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('reject returns 400 for an over-long note', async () => {
      global.__testUser = APPROVER;
      mockEntry({ id: 1, status: 'submitted' });

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ note: 'x'.repeat(1001) });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Validation error' });
    });

    test('approve returns 404 for a missing entry', async () => {
      global.__testUser = APPROVER;
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('submit surfaces lookup errors', async () => {
      mockDb.get.mockImplementation((query, params, callback) => callback(new Error('boom'), null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('submit surfaces update errors', async () => {
      mockEntry({ id: 1, status: 'draft' });
      mockDb.run.mockImplementation((query, params, callback) => callback(new Error('boom')));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to submit work entry' });
    });

    test('approve surfaces update errors', async () => {
      global.__testUser = APPROVER;
      mockEntry({ id: 1, status: 'submitted' });
      mockDb.run.mockImplementation((query, params, callback) => callback(new Error('boom')));

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to approve work entry' });
    });

    test('reject surfaces update errors', async () => {
      global.__testUser = APPROVER;
      mockEntry({ id: 1, status: 'submitted' });
      mockDb.run.mockImplementation((query, params, callback) => callback(new Error('boom')));

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to reject work entry' });
    });

    test('submit surfaces errors when re-reading the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          return callback(new Error('boom'), null);
        }
        callback(null, { id: 1, status: 'draft' });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry submitted but failed to retrieve' });
    });

    test('approve surfaces errors when re-reading the entry', async () => {
      global.__testUser = APPROVER;
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          return callback(new Error('boom'), null);
        }
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry reviewed but failed to retrieve' });
    });
  });
});
