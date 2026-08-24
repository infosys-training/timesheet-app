const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
// Keep the real approver rule, only the identity of the caller is faked
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');

  return {
    authenticateUser: (req, res, next) => {
      req.userEmail = process.env.TEST_USER_EMAIL;
      next();
    },
    requireApprover: actual.requireApprover,
    isApprover: actual.isApprover
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

const OWNER = 'owner@example.com';
const APPROVER = 'approver@example.com';

describe('Work Entry Approval Workflow', () => {
  let mockDb;

  beforeEach(() => {
    process.env.APPROVER_EMAILS = APPROVER;
    process.env.TEST_USER_EMAIL = OWNER;

    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    delete process.env.APPROVER_EMAILS;
    delete process.env.TEST_USER_EMAIL;
    jest.clearAllMocks();
  });

  // Returns the stored status on lookup, the joined row on the final select
  function mockEntry(status) {
    mockDb.get.mockImplementation((query, params, callback) => {
      if (query.includes('work_entries we')) {
        callback(null, { id: 1, status, client_name: 'Client A', user_email: OWNER });
      } else {
        callback(null, { id: 1, status });
      }
    });
    mockDb.run.mockImplementation((query, params, callback) => {
      callback(null);
    });
  }

  describe('Valid transitions', () => {
    test('draft submitted by owner becomes submitted', async () => {
      mockEntry('draft');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('submitted_at = CURRENT_TIMESTAMP'),
        ['submitted', 1],
        expect.any(Function)
      );
    });

    test('entry with no status yet is treated as draft and can be submitted', async () => {
      mockEntry(null);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
    });

    test('rejected entry can be resubmitted by owner', async () => {
      mockEntry('rejected');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('rejection_reason = NULL'),
        ['submitted', 1],
        expect.any(Function)
      );
    });

    test('submitted entry is approved by an approver', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = ?'),
        ['approved', APPROVER, null, 1],
        expect.any(Function)
      );
    });

    test('submitted entry is rejected by an approver with a reason', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockEntry('submitted');

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'Hours look wrong' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = ?'),
        ['rejected', APPROVER, 'Hours look wrong', 1],
        expect.any(Function)
      );
    });
  });

  describe('Rejected transitions', () => {
    test.each(['submitted', 'approved'])('submit is rejected from %s', async (status) => {
      mockEntry(status);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(
        `Cannot submit a work entry with status '${status}', expected status draft or rejected`
      );
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['draft', 'approved', 'rejected'])('approve is rejected from %s', async (status) => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockEntry(status);

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(
        `Cannot approve a work entry with status '${status}', expected status submitted`
      );
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['draft', 'approved', 'rejected'])('reject is rejected from %s', async (status) => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockEntry(status);

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'Not enough detail' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(
        `Cannot reject a work entry with status '${status}', expected status submitted`
      );
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('Authorization', () => {
    test('non approver cannot approve', async () => {
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('non approver cannot reject', async () => {
      mockEntry('submitted');

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'Nope' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('non approver cannot list pending approvals', async () => {
      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('submit only looks at entries owned by the caller', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        expect(params).toEqual([1, OWNER]);
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('approve looks up entries of any user', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockDb.get.mockImplementation((query, params, callback) => {
        expect(params).toEqual([1]);
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(404);
    });
  });

  describe('Approved entries are immutable', () => {
    test('update is refused', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'An approved work entry can no longer be edited' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('delete is refused', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'An approved work entry can no longer be deleted' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['draft', 'submitted', 'rejected'])('update is allowed while %s', async (status) => {
      mockEntry(status);

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    test('returns every submitted entry for an approver', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      const pending = [
        { id: 1, status: 'submitted', user_email: OWNER, client_name: 'Client A' }
      ];
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(params).toEqual(['submitted']);
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
    });

    test('handles database error', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries status filter', () => {
    test('filters by status', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, []);
      });

      const response = await request(app).get('/api/work-entries?status=approved');

      expect(response.status).toBe(200);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('AND we.status = ?'),
        [OWNER, 'approved'],
        expect.any(Function)
      );
    });

    test('returns 400 for an unknown status', async () => {
      const response = await request(app).get('/api/work-entries?status=pending');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid status filter' });
    });
  });

  describe('Request validation and error handling', () => {
    test('reject requires a reason', async () => {
      process.env.TEST_USER_EMAIL = APPROVER;
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/reject').send({});

      expect(response.status).toBe(400);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('returns 400 for an invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/abc/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('handles database error while looking up the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('handles database error while updating the status', async () => {
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

    test('handles database error while re-reading the updated entry', async () => {
      let getCallCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCallCount++;
        if (getCallCount === 1) {
          callback(null, { id: 1, status: 'draft' });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry submitted but failed to retrieve' });
    });
  });
});
