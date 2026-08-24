const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    req.isApprover = req.headers['x-user-approver'] !== 'false';
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
          callback(null, { id: 1 }); // Client exists
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
        callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
        callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
        callback(null, { id: 1 });
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
        callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
        callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
          callback(null, { id: 1 });
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
    const submittedEntry = {
      id: 1,
      client_id: 1,
      user_email: 'test@example.com',
      hours: 5,
      description: 'Work',
      date: '2024-01-01',
      status: 'submitted',
      submitted_at: '2024-01-02 10:00:00',
      reviewed_at: null,
      reviewed_by: null,
      rejection_reason: null,
      client_name: 'Client A'
    };

    test.each(['draft', 'rejected'])('should submit a %s work entry', async (status) => {
      const submitted = { ...submittedEntry, status };
      const refreshed = { ...submittedEntry, status: 'submitted', submitted_at: '2024-01-03 10:00:00' };
      mockDb.get
        .mockImplementationOnce((query, params, callback) => callback(null, { id: 1, status }))
        .mockImplementationOnce((query, params, callback) => callback(null, refreshed));
      mockDb.run.mockImplementation((query, params, callback) => {
        expect(query).toContain("status = 'submitted'");
        expect(query).toContain('submitted_at = CURRENT_TIMESTAMP');
        callback(null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Work entry submitted successfully',
        workEntry: refreshed
      });
    });

    test('should approve a submitted work entry', async () => {
      const approved = {
        ...submittedEntry,
        status: 'approved',
        reviewed_at: '2024-01-03 10:00:00',
        reviewed_by: 'test@example.com'
      };
      mockDb.get
        .mockImplementationOnce((query, params, callback) => callback(null, { id: 1, status: 'submitted' }))
        .mockImplementationOnce((query, params, callback) => callback(null, approved));
      mockDb.run.mockImplementation((query, params, callback) => {
        expect(query).toContain("status = 'approved'");
        expect(query).toContain('reviewed_at = CURRENT_TIMESTAMP');
        expect(params).toEqual(['test@example.com', 1]);
        callback(null);
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.workEntry).toEqual(approved);
    });

    test('should reject a submitted work entry with a reason', async () => {
      const rejected = {
        ...submittedEntry,
        status: 'rejected',
        reviewed_at: '2024-01-03 10:00:00',
        reviewed_by: 'test@example.com',
        rejection_reason: 'Please add more detail'
      };
      mockDb.get
        .mockImplementationOnce((query, params, callback) => callback(null, { id: 1, status: 'submitted' }))
        .mockImplementationOnce((query, params, callback) => callback(null, rejected));
      mockDb.run.mockImplementation((query, params, callback) => {
        expect(query).toContain("status = 'rejected'");
        expect(query).toContain('reviewed_at = CURRENT_TIMESTAMP');
        expect(params).toEqual(['test@example.com', 'Please add more detail', 1]);
        callback(null);
      });

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: '  Please add more detail  ' });

      expect(response.status).toBe(200);
      expect(response.body.workEntry).toEqual(rejected);
    });

    test.each([
      ['/api/work-entries/1/submit', 'submitted', 'submit'],
      ['/api/work-entries/1/submit', 'approved', 'submit'],
      ['/api/work-entries/1/approve', 'draft', 'approve'],
      ['/api/work-entries/1/approve', 'approved', 'approve'],
      ['/api/work-entries/1/approve', 'rejected', 'approve'],
      ['/api/work-entries/1/reject', 'draft', 'reject'],
      ['/api/work-entries/1/reject', 'approved', 'reject'],
      ['/api/work-entries/1/reject', 'rejected', 'reject']
    ])('should reject %s from %s status', async (path, status, action) => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, { id: 1, status }));

      const response = await request(app)
        .post(path)
        .send(path.includes('/reject') ? {} : undefined);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: `Cannot ${action} a work entry with status ${status}` });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 404 when submitting another user entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test.each(['/approve', '/reject', '/pending'])('should deny non-approver access to %s', async (path) => {
      const requestPath = `/api/work-entries/1${path}`;
      const response = path === '/pending'
        ? await request(app).get('/api/work-entries/pending').set('x-user-approver', 'false')
        : await request(app).post(requestPath).set('x-user-approver', 'false');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.get).not.toHaveBeenCalled();
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test.each(['put', 'delete'])('should not allow %s on approved entries', async (method) => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, { id: 1, status: 'approved' }));

      const response = await request(app)[method]('/api/work-entries/1')
        .send(method === 'put' ? { hours: 8 } : undefined);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: `Cannot ${method === 'put' ? 'edit' : 'delete'} a work entry with status approved` });
    });

    test('should filter work entries by status', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain('AND we.status = ?');
        expect(params).toEqual(['test@example.com', 'submitted']);
        callback(null, []);
      });

      const response = await request(app).get('/api/work-entries?status=submitted');

      expect(response.status).toBe(200);
    });

    test('should return 400 for invalid status filter', async () => {
      const response = await request(app).get('/api/work-entries?status=unknown');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid status' });
    });

    test.each(['/submit', '/approve', '/reject'])('should return 400 for invalid action ID %s', async (action) => {
      const response = await request(app).post(`/api/work-entries/not-an-id${action}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test.each(['/submit', '/approve', '/reject'])('should return 404 when action entry is missing %s', async (action) => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));

      const response = await request(app).post(`/api/work-entries/999${action}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test.each(['/submit', '/approve', '/reject'])('should handle database errors for %s', async (action) => {
      mockDb.get.mockImplementation((query, params, callback) => callback(new Error('Database error'), null));

      const response = await request(app).post(`/api/work-entries/1${action}`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });
});
