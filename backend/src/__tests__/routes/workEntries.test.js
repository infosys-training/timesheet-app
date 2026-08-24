const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

let mockCurrentUser = { email: 'test@example.com', isApprover: false };

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
// Add error handler for Joi validation
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

describe('Work Entry Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockCurrentUser = { email: 'test@example.com', isApprover: false };
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

  describe('GET /api/work-entries', () => {
    test('should return all work entries for user', async () => {
      const mockEntries = [
        { id: 1, client_id: 1, hours: 5, description: 'Work 1', date: '2024-01-01', client_name: 'Client A' },
        { id: 2, client_id: 2, hours: 3, description: 'Work 2', date: '2024-01-02', client_name: 'Client B' }
      ];

      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, mockEntries);
      });

      const response = await request(app).get('/api/work-entries');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: mockEntries });
    });

    test('should filter by client ID when provided', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(params).toEqual(['test@example.com', 1]);
        callback(null, []);
      });

      await request(app).get('/api/work-entries?clientId=1');

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('AND we.client_id = ?'),
        ['test@example.com', 1],
        expect.any(Function)
      );
    });

    test('should return 400 for invalid client ID filter', async () => {
      const response = await request(app).get('/api/work-entries?clientId=invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid client ID' });
    });

    test('should handle database error', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries/:id', () => {
    test('should return specific work entry', async () => {
      const mockEntry = { id: 1, client_id: 1, hours: 5, description: 'Work', client_name: 'Client A' };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, mockEntry);
      });

      const response = await request(app).get('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntry: mockEntry });
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).get('/api/work-entries/999');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).get('/api/work-entries/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });
  });

  describe('POST /api/work-entries', () => {
    test('should create work entry with valid data', async () => {
      const newEntry = {
        clientId: 1,
        hours: 5.5,
        description: 'Development work',
        date: '2024-01-15'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('clients')) {
          callback(null, { id: 1, status: 'draft' }); // Client exists
        } else {
          callback(null, { id: 1, ...newEntry, client_name: 'Client A' });
        }
      });

      mockDb.run.mockImplementation(function(query, params, callback) {
        this.lastID = 1;
        callback.call(this, null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send(newEntry);

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('Work entry created successfully');
    });

    test('should return 400 if client not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // Client doesn't exist
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 999,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Client not found or does not belong to user' });
    });

    test('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({ hours: 5 });

      expect(response.status).toBe(400);
    });

    test('should return 400 for invalid hours', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: -5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
    });

    test('should return 400 for hours exceeding 24', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 25,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
    });

    test('should handle database error on insert', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Insert failed'));
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to create work entry' });
    });
  });

  describe('PUT /api/work-entries/:id', () => {
    test('should update work entry hours', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, hours: 8, client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status: 'draft' });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test('should update work entry client', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 2 });

      expect(response.status).toBe(200);
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app)
        .put('/api/work-entries/999')
        .send({ hours: 8 });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app)
        .put('/api/work-entries/invalid')
        .send({ hours: 8 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should return 400 for empty update', async () => {
      const response = await request(app)
        .put('/api/work-entries/1')
        .send({});

      expect(response.status).toBe(400);
    });

    test('should return 400 if new client not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries')) {
          callback(null, { id: 1, status: 'draft' });
        } else {
          callback(null, null); // Client doesn't exist
        }
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 999 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Client not found or does not belong to user' });
    });
  });

  describe('DELETE /api/work-entries/:id', () => {
    test('should delete existing work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Work entry deleted successfully' });
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).delete('/api/work-entries/999');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).delete('/api/work-entries/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database delete error', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Delete failed'));
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to delete work entry' });
    });

    test('should handle database error when checking work entry existence', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries/:id - Error Handling', () => {
    test('should handle database error when fetching single work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/work-entries - Error Handling', () => {
    test('should handle database error when verifying client', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle error retrieving work entry after creation', async () => {
      let getCallCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCallCount++;
        if (getCallCount === 1) {
          callback(null, { id: 1, status: 'draft' });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });

      mockDb.run.mockImplementation(function(query, params, callback) {
        this.lastID = 1;
        callback.call(this, null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry created but failed to retrieve' });
    });
  });

  describe('PUT /api/work-entries/:id - Error Handling', () => {
    test('should handle database error when checking work entry existence', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error when verifying new client in update', async () => {
      let callCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        callCount++;
        if (callCount === 1) {
          callback(null, { id: 1, status: 'draft' });
        } else {
          callback(new Error('Database error'), null);
        }
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 2 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error during update', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to update work entry' });
    });

    test('should handle error retrieving work entry after update', async () => {
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

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry updated but failed to retrieve' });
    });

    test('should update work entry date', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, date: '2024-02-01', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status: 'draft' });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ date: '2024-02-01' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test('should update work entry description', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, description: 'New description', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status: 'draft' });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ description: 'New description' });

      expect(response.status).toBe(200);
    });

    test('should update description to null when empty string provided', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, description: null, client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status: 'draft' });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ description: '' });

      expect(response.status).toBe(200);
    });

    test('should update multiple fields at once', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, hours: 10, description: 'Updated', date: '2024-03-01', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status: 'draft' });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 10, description: 'Updated', date: '2024-03-01' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });
  });

  describe('Approval workflow', () => {
    // Returns the stored status on lookup and the persisted row after the update
    const mockEntryWithStatus = (status, updatedRow = {}) => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, client_name: 'Client A', ...updatedRow });
        } else {
          callback(null, { id: 1, status });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });
    };

    describe('Valid transitions', () => {
      test('submit moves a draft entry to submitted', async () => {
        mockEntryWithStatus('draft', { status: 'submitted' });

        const response = await request(app).post('/api/work-entries/1/submit');

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Work entry submitted successfully');
        expect(response.body.workEntry.status).toBe('submitted');
        expect(mockDb.run).toHaveBeenCalledWith(
          expect.stringContaining('submitted_at = CURRENT_TIMESTAMP'),
          ['submitted', 1],
          expect.any(Function)
        );
      });

      test('submit moves a rejected entry back to submitted and clears the review', async () => {
        mockEntryWithStatus('rejected', { status: 'submitted' });

        const response = await request(app).post('/api/work-entries/1/submit');

        expect(response.status).toBe(200);
        expect(mockDb.run).toHaveBeenCalledWith(
          expect.stringContaining('reviewed_by = NULL'),
          ['submitted', 1],
          expect.any(Function)
        );
      });

      test('approver approves a submitted entry', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        mockEntryWithStatus('submitted', { status: 'approved', reviewed_by: 'approver@example.com' });

        const response = await request(app)
          .post('/api/work-entries/1/approve')
          .send({ note: 'Looks good' });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Work entry approved successfully');
        expect(mockDb.run).toHaveBeenCalledWith(
          expect.stringContaining('reviewed_by = ?'),
          ['approved', 'approver@example.com', 'Looks good', 1],
          expect.any(Function)
        );
      });

      test('approver rejects a submitted entry', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        mockEntryWithStatus('submitted', { status: 'rejected' });

        const response = await request(app)
          .post('/api/work-entries/1/reject')
          .send({ note: 'Missing detail' });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Work entry rejected successfully');
        expect(mockDb.run).toHaveBeenCalledWith(
          expect.any(String),
          ['rejected', 'approver@example.com', 'Missing detail', 1],
          expect.any(Function)
        );
      });

      test('review note is optional', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        mockEntryWithStatus('submitted', { status: 'rejected' });

        const response = await request(app).post('/api/work-entries/1/reject');

        expect(response.status).toBe(200);
        expect(mockDb.run).toHaveBeenCalledWith(
          expect.any(String),
          ['rejected', 'approver@example.com', null, 1],
          expect.any(Function)
        );
      });
    });

    describe('Rejected transitions', () => {
      const invalidTransitions = [
        { action: 'submit', from: 'submitted', allowed: 'draft, rejected' },
        { action: 'submit', from: 'approved', allowed: 'draft, rejected' },
        { action: 'approve', from: 'draft', allowed: 'submitted' },
        { action: 'approve', from: 'rejected', allowed: 'submitted' },
        { action: 'approve', from: 'approved', allowed: 'submitted' },
        { action: 'reject', from: 'draft', allowed: 'submitted' },
        { action: 'reject', from: 'rejected', allowed: 'submitted' },
        { action: 'reject', from: 'approved', allowed: 'submitted' }
      ];

      invalidTransitions.forEach(({ action, from, allowed }) => {
        test(`${action} is rejected for a ${from} entry`, async () => {
          mockCurrentUser = { email: 'approver@example.com', isApprover: true };
          mockEntryWithStatus(from);

          const response = await request(app).post(`/api/work-entries/1/${action}`);

          expect(response.status).toBe(409);
          expect(response.body).toEqual({
            error: `Cannot ${action} a work entry with status '${from}'. Allowed statuses: ${allowed}`
          });
          expect(mockDb.run).not.toHaveBeenCalled();
        });
      });

      test('editing an approved entry is rejected', async () => {
        mockEntryWithStatus('approved');

        const response = await request(app)
          .put('/api/work-entries/1')
          .send({ hours: 8 });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({ error: "Cannot edit a work entry with status 'approved'" });
        expect(mockDb.run).not.toHaveBeenCalled();
      });

      test('deleting an approved entry is rejected', async () => {
        mockEntryWithStatus('approved');

        const response = await request(app).delete('/api/work-entries/1');

        expect(response.status).toBe(409);
        expect(response.body).toEqual({ error: "Cannot delete a work entry with status 'approved'" });
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
        expect(response.body).toEqual({ error: 'Approver role required' });
      });

      test('submit only matches entries owned by the caller', async () => {
        mockDb.get.mockImplementation((query, params, callback) => {
          expect(params).toEqual([1, 'test@example.com']);
          callback(null, null);
        });

        const response = await request(app).post('/api/work-entries/1/submit');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Work entry not found' });
      });

      test('approve looks up entries across users', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        mockDb.get.mockImplementation((query, params, callback) => {
          expect(params).toEqual([1]);
          callback(null, null);
        });

        const response = await request(app).post('/api/work-entries/1/approve');

        expect(response.status).toBe(404);
      });
    });

    describe('Transition error handling', () => {
      test('returns 400 for an invalid work entry ID', async () => {
        const response = await request(app).post('/api/work-entries/invalid/submit');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid work entry ID' });
      });

      test('returns 400 for an invalid review note', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };

        const response = await request(app)
          .post('/api/work-entries/1/approve')
          .send({ note: 'x'.repeat(1001) });

        expect(response.status).toBe(400);
      });

      test('handles database error on lookup', async () => {
        mockDb.get.mockImplementation((query, params, callback) => {
          callback(new Error('Database error'), null);
        });

        const response = await request(app).post('/api/work-entries/1/submit');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Internal server error' });
      });

      test('handles database error on update', async () => {
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

      test('handles database error when retrieving the updated entry', async () => {
        mockDb.get.mockImplementation((query, params, callback) => {
          if (query.includes('work_entries we')) {
            callback(new Error('Retrieval failed'), null);
          } else {
            callback(null, { id: 1, status: 'draft' });
          }
        });
        mockDb.run.mockImplementation((query, params, callback) => {
          callback(null);
        });

        const response = await request(app).post('/api/work-entries/1/submit');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Work entry updated but failed to retrieve' });
      });
    });

    describe('GET /api/work-entries/pending-approvals', () => {
      test('returns submitted entries for approvers', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        const pending = [
          { id: 1, status: 'submitted', user_email: 'employee@example.com', client_name: 'Client A' }
        ];
        mockDb.all.mockImplementation((query, params, callback) => {
          callback(null, pending);
        });

        const response = await request(app).get('/api/work-entries/pending-approvals');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ workEntries: pending });
        expect(mockDb.all).toHaveBeenCalledWith(
          expect.stringContaining("we.status = 'submitted'"),
          [],
          expect.any(Function)
        );
      });

      test('returns 403 for non-approvers', async () => {
        const response = await request(app).get('/api/work-entries/pending-approvals');

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Approver role required' });
      });

      test('handles database error', async () => {
        mockCurrentUser = { email: 'approver@example.com', isApprover: true };
        mockDb.all.mockImplementation((query, params, callback) => {
          callback(new Error('Database error'), null);
        });

        const response = await request(app).get('/api/work-entries/pending-approvals');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Internal server error' });
      });
    });

    describe('Status filter on GET /api/work-entries', () => {
      test('filters by status', async () => {
        mockDb.all.mockImplementation((query, params, callback) => {
          callback(null, []);
        });

        await request(app).get('/api/work-entries?status=submitted');

        expect(mockDb.all).toHaveBeenCalledWith(
          expect.stringContaining('AND we.status = ?'),
          ['test@example.com', 'submitted'],
          expect.any(Function)
        );
      });

      test('returns 400 for an unknown status', async () => {
        const response = await request(app).get('/api/work-entries?status=pending');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid status filter' });
      });
    });
  });
});
