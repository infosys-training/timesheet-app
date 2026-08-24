const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();

const workEntrySelect = `
  SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
         we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
         we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
  FROM work_entries we
  JOIN clients c ON we.client_id = c.id
`;

function parseWorkEntryId(id) {
  const workEntryId = parseInt(id, 10);
  return Number.isNaN(workEntryId) ? null : workEntryId;
}

function transitionError(res, action, status) {
  return res.status(409).json({
    error: `Cannot ${action} work entry with status '${status}'`
  });
}

router.use(authenticateUser);

// This route must precede /:id so "pending-approvals" is not parsed as an ID.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  db.all(
    `${workEntrySelect}
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

router.get('/', (req, res) => {
  const { clientId } = req.query;
  const db = getDatabase();
  let query = `${workEntrySelect} WHERE we.user_email = ?`;
  const params = [req.userEmail];

  if (clientId) {
    const clientIdNum = parseInt(clientId, 10);
    if (Number.isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
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

router.get('/:id', (req, res) => {
  const workEntryId = parseWorkEntryId(req.params.id);
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get(
    `${workEntrySelect} WHERE we.id = ? AND we.user_email = ?`,
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      res.json({ workEntry: row });
    }
  );
});

router.post('/', (req, res, next) => {
  try {
    const { error, value } = workEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

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
            db.get(
              `${workEntrySelect} WHERE we.id = ?`,
              [this.lastID],
              (selectError, createdEntry) => {
                if (selectError) {
                  console.error('Database error:', selectError);
                  return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
                }
                res.status(201).json({
                  message: 'Work entry created successfully',
                  workEntry: createdEntry
                });
              }
            );
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submit', (req, res) => {
  const workEntryId = parseWorkEntryId(req.params.id);
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get(
    'SELECT status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      if (!['draft', 'rejected'].includes(row.status)) {
        return transitionError(res, 'submit', row.status);
      }

      db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
             reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        (updateError) => {
          if (updateError) {
            console.error('Database error:', updateError);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }
          db.get(
            `${workEntrySelect} WHERE we.id = ? AND we.user_email = ?`,
            [workEntryId, req.userEmail],
            (selectError, entry) => {
              if (selectError) {
                console.error('Database error:', selectError);
                return res.status(500).json({ error: 'Work entry submitted but failed to retrieve' });
              }
              res.json({ message: 'Work entry submitted successfully', workEntry: entry });
            }
          );
        }
      );
    }
  );
});

function reviewWorkEntry(req, res, action, status, reason) {
  const workEntryId = parseWorkEntryId(req.params.id);
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get('SELECT status FROM work_entries WHERE id = ?', [workEntryId], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }
    if (row.status !== 'submitted') {
      return transitionError(res, action, row.status);
    }

    const rejectionReason = action === 'reject' ? (reason || null) : null;
    db.run(
      `UPDATE work_entries
       SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
           rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'submitted'`,
      [status, req.userEmail, rejectionReason, workEntryId],
      (updateError) => {
        if (updateError) {
          console.error('Database error:', updateError);
          return res.status(500).json({ error: `Failed to ${action} work entry` });
        }
        db.get(`${workEntrySelect} WHERE we.id = ?`, [workEntryId], (selectError, entry) => {
          if (selectError) {
            console.error('Database error:', selectError);
            return res.status(500).json({ error: `Work entry ${action}d but failed to retrieve` });
          }
          res.json({ message: `Work entry ${action}d successfully`, workEntry: entry });
        });
      }
    );
  });
}

router.post('/:id/approve', requireApprover, (req, res) => {
  reviewWorkEntry(req, res, 'approve', 'approved');
});

router.post('/:id/reject', requireApprover, (req, res, next) => {
  try {
    const { error, value } = rejectWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }
    reviewWorkEntry(req, res, 'reject', 'rejected', value.reason);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseWorkEntryId(req.params.id);
    if (workEntryId === null) {
      return res.status(400).json({ error: 'Invalid work entry ID' });
    }

    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const db = getDatabase();
    db.get(
      'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
      [workEntryId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (!row) {
          return res.status(404).json({ error: 'Work entry not found' });
        }
        if (row.status === 'approved') {
          return transitionError(res, 'edit', row.status);
        }

        const update = () => {
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
              db.get(
                `${workEntrySelect} WHERE we.id = ? AND we.user_email = ?`,
                [workEntryId, req.userEmail],
                (selectError, entry) => {
                  if (selectError) {
                    console.error('Database error:', selectError);
                    return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
                  }
                  res.json({ message: 'Work entry updated successfully', workEntry: entry });
                }
              );
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
              update();
            }
          );
        } else {
          update();
        }
      }
    );
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res) => {
  const workEntryId = parseWorkEntryId(req.params.id);
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get(
    'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      if (row.status === 'approved') {
        return transitionError(res, 'delete', row.status);
      }

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
    }
  );
});

module.exports = router;
