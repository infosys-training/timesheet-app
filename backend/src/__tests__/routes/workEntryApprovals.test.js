const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

// Mutated per test to switch between an owner and an approver
const mockAuthState = { email: 'owner@example.com', isApprover: false };

jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = mockAuthState.email;
    req.isApprover = mockAuthState.isApprover;
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

describe('Work Entry Approval Workflow', () => {
  let mockDb;

  // First db.get is the status check, the second returns the refreshed row
  function mockEntryWithStatus(status) {
    let getCount = 0;
    mockDb.get.mockImplementation((query, params, callback) => {
      getCount++;
      if (getCount === 1) {
        callback(null, status === null ? null : { id: 1, status });
      } else {
        callback(null, { id: 1, status, client_name: 'Client A' });
      }
    });
    mockDb.run.mockImplementation((query, params, callback) => callback(null));
  }

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    mockAuthState.email = 'owner@example.com';
    mockAuthState.isApprover = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Valid transitions', () => {
    test('draft -> submitted via submit', async () => {
      mockEntryWithStatus('draft');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted for approval');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("status = 'submitted'"),
        [1, 'owner@example.com'],
        expect.any(Function)
      );
    });

    test('rejected -> submitted via submit (resubmission)', async () => {
      mockEntryWithStatus('rejected');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('review_note = NULL'),
        [1, 'owner@example.com'],
        expect.any(Function)
      );
    });

    test('submitted -> approved via approve', async () => {
      mockAuthState.email = 'approver@example.com';
      mockAuthState.isApprover = true;
      mockEntryWithStatus('submitted');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = ?'),
        ['approved', 'approver@example.com', null, 1],
        expect.any(Function)
      );
    });

    test('submitted -> rejected via reject with a review note', async () => {
      mockAuthState.email = 'approver@example.com';
      mockAuthState.isApprover = true;
      mockEntryWithStatus('submitted');

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reviewNote: 'Hours look too high' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.any(String),
        ['rejected', 'approver@example.com', 'Hours look too high', 1],
        expect.any(Function)
      );
    });

    test('entries with a legacy null status are treated as draft', async () => {
      mockEntryWithStatus(undefined);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
    });
  });

  describe('Rejected transitions', () => {
    test.each([
      ['submitted', "Cannot submit a work entry with status 'submitted'"],
      ['approved', "Cannot submit a work entry with status 'approved'"]
    ])('submit is refused from %s', async (status, expectedError) => {
      mockEntryWithStatus(status);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: expectedError });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each([
      ['draft', "Cannot approve a work entry with status 'draft'"],
      ['approved', "Cannot approve a work entry with status 'approved'"],
      ['rejected', "Cannot approve a work entry with status 'rejected'"]
    ])('approve is refused from %s', async (status, expectedError) => {
      mockAuthState.isApprover = true;
      mockEntryWithStatus(status);

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: expectedError });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each([
      ['draft', "Cannot reject a work entry with status 'draft'"],
      ['approved', "Cannot reject a work entry with status 'approved'"],
      ['rejected', "Cannot reject a work entry with status 'rejected'"]
    ])('reject is refused from %s', async (status, expectedError) => {
      mockAuthState.isApprover = true;
      mockEntryWithStatus(status);

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: expectedError });
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('Authorization', () => {
    test('non-approver cannot approve', async () => {
      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('non-approver cannot reject', async () => {
      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(403);
      expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('non-approver cannot list pending approvals', async () => {
      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('submit only matches entries owned by the caller', async () => {
      mockEntryWithStatus(null);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
        [1, 'owner@example.com'],
        expect.any(Function)
      );
    });

    test('approve returns 404 when the entry does not exist', async () => {
      mockAuthState.isApprover = true;
      mockEntryWithStatus(null);

      const response = await request(app).post('/api/work-entries/999/approve');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });
  });

  describe('Approved entries are immutable', () => {
    test('PUT is refused for an approved entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be modified' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('DELETE is refused for an approved entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be modified' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('PUT is allowed for a rejected entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'rejected', client_name: 'Client A' });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    test('returns every submitted entry for an approver', async () => {
      mockAuthState.isApprover = true;
      const pending = [
        { id: 1, status: 'submitted', user_email: 'owner@example.com', client_name: 'Client A' },
        { id: 2, status: 'submitted', user_email: 'other@example.com', client_name: 'Client B' }
      ];
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain("we.status = 'submitted'");
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
    });

    test('handles a database error', async () => {
      mockAuthState.isApprover = true;
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('Error handling', () => {
    test('submit returns 400 for an invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/invalid/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('approve returns 400 for an invalid work entry ID', async () => {
      mockAuthState.isApprover = true;

      const response = await request(app).post('/api/work-entries/invalid/approve');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('reject returns 400 for an over-long review note', async () => {
      mockAuthState.isApprover = true;

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reviewNote: 'x'.repeat(1001) });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Validation error' });
    });

    test('submit handles a database error on the status lookup', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('submit handles a database error on the update', async () => {
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

    test('approve handles a database error on the status lookup', async () => {
      mockAuthState.isApprover = true;
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('approve handles a database error on the update', async () => {
      mockAuthState.isApprover = true;
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to approve work entry' });
    });

    test('reject handles a database error on the update', async () => {
      mockAuthState.isApprover = true;
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to reject work entry' });
    });

    test('submit handles a failure to reload the entry', async () => {
      let getCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCount++;
        if (getCount === 1) {
          callback(null, { id: 1, status: 'draft' });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry updated but failed to retrieve' });
    });
  });
});
