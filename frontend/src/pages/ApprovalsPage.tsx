import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  CircularProgress,
  Chip,
} from '@mui/material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../hooks/useAuth';
import { type PendingWorkEntry } from '../types/api';

type ReviewAction = 'approve' | 'reject';

const ApprovalsPage: React.FC = () => {
  const { user } = useAuth();
  const [review, setReview] = useState<{ entry: PendingWorkEntry; action: ReviewAction } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
    enabled: Boolean(user?.isApprover),
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
      const mutationError = err as { response?: { data?: { error?: string } } };
      setError(mutationError.response?.data?.error || 'Failed to review work entry');
    },
  });

  const pendingEntries: PendingWorkEntry[] = data?.workEntries || [];

  const handleOpen = (entry: PendingWorkEntry, action: ReviewAction) => {
    setReview({ entry, action });
    setNote('');
    setError('');
  };

  const handleClose = () => {
    setReview(null);
    setNote('');
  };

  const handleConfirm = () => {
    if (!review) {
      return;
    }

    reviewMutation.mutate({
      id: review.entry.id,
      action: review.action,
      note: note || undefined,
    });
  };

  if (!user?.isApprover) {
    return (
      <Alert severity="info">You need approver permissions to review submitted work entries.</Alert>
    );
  }

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" mb={3}>
        Pending Approvals
      </Typography>

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
                pendingEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.user_email}</TableCell>
                    <TableCell>{entry.client_name}</TableCell>
                    <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Chip label={`${entry.hours} hours`} color="primary" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {entry.description || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={entry.status} />
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="success"
                        onClick={() => handleOpen(entry, 'approve')}
                        disabled={reviewMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => handleOpen(entry, 'reject')}
                        disabled={reviewMutation.isPending}
                      >
                        Reject
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No work entries are waiting for approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={Boolean(review)} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          {review?.action === 'approve' ? 'Approve work entry' : 'Reject work entry'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {review?.entry.hours} hours for {review?.entry.client_name} by {review?.entry.user_email}
          </Typography>
          <TextField
            margin="dense"
            label="Note (optional)"
            fullWidth
            multiline
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={reviewMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={reviewMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color={review?.action === 'approve' ? 'success' : 'error'}
            onClick={handleConfirm}
            disabled={reviewMutation.isPending}
          >
            {reviewMutation.isPending ? (
              <CircularProgress size={24} />
            ) : review?.action === 'approve' ? (
              'Approve'
            ) : (
              'Reject'
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ApprovalsPage;
