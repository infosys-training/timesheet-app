import React, { useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  CircularProgress,
  Chip,
} from '@mui/material';
import {
  CheckCircle as ApproveIcon,
  Cancel as RejectIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import WorkEntryStatusChip from '../components/WorkEntryStatusChip';
import { useAuth } from '../hooks/useAuth';
import { type WorkEntry } from '../types/api';

type ReviewAction = 'approve' | 'reject';

const PendingApprovalsPage: React.FC = () => {
  const { user } = useAuth();
  const [review, setReview] = useState<{ entry: WorkEntry; action: ReviewAction } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const queryClient = useQueryClient();

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, note: reviewNote }: { id: number; action: ReviewAction; note?: string }) =>
      action === 'approve'
        ? apiClient.approveWorkEntry(id, reviewNote)
        : apiClient.rejectWorkEntry(id, reviewNote),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      handleClose();
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to review work entry');
    },
  });

  const pendingEntries: WorkEntry[] = data?.workEntries || [];

  const handleOpen = (entry: WorkEntry, action: ReviewAction) => {
    setReview({ entry, action });
    setNote('');
    setError('');
  };

  const handleClose = () => {
    setReview(null);
    setNote('');
  };

  const handleSubmit = () => {
    if (!review) {
      return;
    }

    reviewMutation.mutate({
      id: review.entry.id,
      action: review.action,
      note: note.trim() || undefined,
    });
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" p={3}>
        <CircularProgress />
      </Box>
    );
  }

  if (queryError) {
    const status = (queryError as { response?: { status?: number } }).response?.status;

    return (
      <Alert severity="error">
        {status === 403
          ? 'You do not have the approver role required to review work entries.'
          : 'Failed to load pending approvals'}
      </Alert>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4">Pending Approvals</Typography>
        <Chip label={`${pendingEntries.length} awaiting review`} color="info" />
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Employee</TableCell>
                <TableCell>Client</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Hours</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pendingEntries.length > 0 ? (
                pendingEntries.map((entry) => {
                  const isOwnEntry = entry.user_email === user?.email;

                  return (
                    <TableRow key={entry.id}>
                      <TableCell>{entry.user_email}</TableCell>
                      <TableCell>{entry.client_name}</TableCell>
                      <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                      <TableCell>{entry.hours}</TableCell>
                      <TableCell>{entry.description || '-'}</TableCell>
                      <TableCell>
                        <WorkEntryStatusChip status={entry.status} />
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          startIcon={<ApproveIcon />}
                          color="success"
                          size="small"
                          disabled={isOwnEntry}
                          onClick={() => handleOpen(entry, 'approve')}
                        >
                          Approve
                        </Button>
                        <Button
                          startIcon={<RejectIcon />}
                          color="error"
                          size="small"
                          disabled={isOwnEntry}
                          onClick={() => handleOpen(entry, 'reject')}
                        >
                          Reject
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="textSecondary">No entries are awaiting approval</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!review} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          {review?.action === 'approve' ? 'Approve work entry' : 'Reject work entry'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            {review?.entry.user_email} — {review?.entry.client_name} — {review?.entry.hours} hours
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={3}
            label="Note (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            variant="contained"
            color={review?.action === 'approve' ? 'success' : 'error'}
            disabled={reviewMutation.isPending}
          >
            {review?.action === 'approve' ? 'Approve' : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
