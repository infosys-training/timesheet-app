const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, reviewSchema } = require('../validation/schemas');

const router = express.Router();
const entryProjection = `
  we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.review_note,
  we.created_at, we.updated_at, c.name as client_name
`;

router.use(authenticateUser);

function invalidState(res, action) {
  return res.status(409).json({ error: `Cannot ${action} work entry in its current state` });
}

function getEntry(db, id, userEmail, callback) {
  db.get(
    `SELECT ${entryProjection}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ? AND we.user_email = ?`,
    [id, userEmail],
    callback
  );
}

function getAnyEntry(db, id, callback) {
  db.get(
    `SELECT ${entryProjection}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ?`,
    [id],
    callback
  );
}

function returnEntry(db, id, res, message, errorMessage) {
  getAnyEntry(db, id, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: errorMessage });
    }
    res.json({ message, workEntry: row });
  });
}

// Pending approvals must precede /:id.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  db.all(
    `SELECT ${entryProjection}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted'
     ORDER BY we.date DESC, we.created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ workEntries: rows });
    }
  );
});

// Get all work entries for authenticated user (with optional client/status filters).
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  const validStatuses = ['draft', 'submitted', 'approved', 'rejected'];
  let query = `
    SELECT ${entryProjection}
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    WHERE we.user_email = ?
  `;
  const params = [req.userEmail];

  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
  }
  if (status) {
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    query += ' AND we.status = ?';
    params.push(status);
  }

  query += ' ORDER BY we.date DESC, we.created_at DESC';
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json({ workEntries: rows });
  });
});

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  getEntry(getDatabase(), workEntryId, req.userEmail, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) return res.status(404).json({ error: 'Work entry not found' });
    res.json({ workEntry: row });
  });
});

// Create new work entry
router.post('/', (req, res, next) => {
  try {
    const { error, value } = workEntrySchema.validate(req.body);
    if (error) return next(error);
    const { clientId, hours, description, date } = value;
    const db = getDatabase();

    db.get(
      'SELECT id FROM clients WHERE id = ? AND user_email = ?',
      [clientId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (!row) {
          return res.status(400).json({ error: 'Client not found or does not belong to user' });
        }
        db.run(
          'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
          [clientId, req.userEmail, hours, description || null, date],
          function(insertError) {
            if (insertError) {
              console.error('Database error:', insertError);
              return res.status(500).json({ error: 'Failed to create work entry' });
            }
            getAnyEntry(db, this.lastID, (fetchError, entry) => {
              if (fetchError) {
                console.error('Database error:', fetchError);
                return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
              }
              res.status(201).json({ message: 'Work entry created successfully', workEntry: entry });
            });
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submit', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  const db = getDatabase();
  getEntry(db, workEntryId, req.userEmail, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) return res.status(404).json({ error: 'Work entry not found' });
    if (!['draft', 'rejected'].includes(row.status)) {
      return invalidState(res, 'submit');
    }
    db.run(
      `UPDATE work_entries
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
           reviewed_at = NULL, reviewed_by = NULL, review_note = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_email = ?`,
      [workEntryId, req.userEmail],
      (updateError) => {
        if (updateError) {
          console.error('Database error:', updateError);
          return res.status(500).json({ error: 'Failed to submit work entry' });
        }
        returnEntry(db, workEntryId, res, 'Work entry submitted successfully', 'Work entry submitted but failed to retrieve');
      }
    );
  });
});

function reviewEntry(action, status) {
  return (req, res, next) => {
    try {
      const { error, value } = reviewSchema.validate(req.body || {});
      if (error) return next(error);
      const workEntryId = parseInt(req.params.id);
      if (isNaN(workEntryId)) {
        return res.status(400).json({ error: 'Invalid work entry ID' });
      }
      const db = getDatabase();
      getAnyEntry(db, workEntryId, (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (!row) return res.status(404).json({ error: 'Work entry not found' });
        if (row.status !== 'submitted') return invalidState(res, action);
        db.run(
          `UPDATE work_entries
           SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
               review_note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitted'`,
          [status, req.userEmail, value.note || null, workEntryId],
          (updateError) => {
            if (updateError) {
              console.error('Database error:', updateError);
              return res.status(500).json({ error: `Failed to ${action} work entry` });
            }
            returnEntry(db, workEntryId, res, `Work entry ${status} successfully`, `Work entry ${status} but failed to retrieve`);
          }
        );
      });
    } catch (error) {
      next(error);
    }
  };
}

router.post('/:id/approve', requireApprover, reviewEntry('approve', 'approved'));
router.post('/:id/reject', requireApprover, reviewEntry('reject', 'rejected'));

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseInt(req.params.id);
    if (isNaN(workEntryId)) {
      return res.status(400).json({ error: 'Invalid work entry ID' });
    }
    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) return next(error);
    const db = getDatabase();
    getEntry(db, workEntryId, req.userEmail, (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) return res.status(404).json({ error: 'Work entry not found' });
      if (!['draft', 'rejected'].includes(row.status)) {
        return invalidState(res, 'edit');
      }

      const performUpdate = () => {
        const updates = [];
        const values = [];
        if (value.clientId !== undefined) {
          updates.push('client_id = ?');
          values.push(value.clientId);
        }
        if (value.hours !== undefined) {
          updates.push('hours = ?');
          values.push(value.hours);
        }
        if (value.description !== undefined) {
          updates.push('description = ?');
          values.push(value.description || null);
        }
        if (value.date !== undefined) {
          updates.push('date = ?');
          values.push(value.date);
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(workEntryId, req.userEmail);
        db.run(
          `UPDATE work_entries SET ${updates.join(', ')} WHERE id = ? AND user_email = ?`,
          values,
          (updateError) => {
            if (updateError) {
              console.error('Database error:', updateError);
              return res.status(500).json({ error: 'Failed to update work entry' });
            }
            returnEntry(db, workEntryId, res, 'Work entry updated successfully', 'Work entry updated but failed to retrieve');
          }
        );
      };

      if (value.clientId !== undefined) {
        db.get(
          'SELECT id FROM clients WHERE id = ? AND user_email = ?',
          [value.clientId, req.userEmail],
          (clientError, clientRow) => {
            if (clientError) {
              console.error('Database error:', clientError);
              return res.status(500).json({ error: 'Internal server error' });
            }
            if (!clientRow) {
              return res.status(400).json({ error: 'Client not found or does not belong to user' });
            }
            performUpdate();
          }
        );
      } else {
        performUpdate();
      }
    });
  } catch (error) {
    next(error);
  }
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  const db = getDatabase();
  getEntry(db, workEntryId, req.userEmail, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) return res.status(404).json({ error: 'Work entry not found' });
    if (row.status === 'approved') return invalidState(res, 'delete');
    db.run(
      'DELETE FROM work_entries WHERE id = ? AND user_email = ?',
      [workEntryId, req.userEmail],
      (deleteError) => {
        if (deleteError) {
          console.error('Database error:', deleteError);
          return res.status(500).json({ error: 'Failed to delete work entry' });
        }
        res.json({ message: 'Work entry deleted successfully' });
      }
    );
  });
});

module.exports = router;
