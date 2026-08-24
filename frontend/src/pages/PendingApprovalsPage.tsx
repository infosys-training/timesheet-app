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
import {
  CheckCircle as ApproveIcon,
  Cancel as RejectIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { type PendingWorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const { user } = useAuth();
  const [reviewing, setReviewing] = useState<PendingWorkEntry | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const queryClient = useQueryClient();
  const isApprover = user?.role === 'approver';

  const { data, isLoading } = useQuery({
    queryKey: ['pendingWorkEntries'],
    queryFn: () => apiClient.getPendingWorkEntries(),
    enabled: isApprover,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pendingWorkEntries'] });
    queryClient.invalidateQueries({ queryKey: ['workEntries'] });
  };

  const handleError = (fallback: string) => (err: unknown) => {
    const apiError = err as { response?: { data?: { error?: string } } };
    setError(apiError.response?.data?.error || fallback);
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: invalidate,
    onError: handleError('Failed to approve work entry'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) => apiClient.rejectWorkEntry(id, note),
    onSuccess: () => {
      invalidate();
      handleCloseReview();
    },
    onError: handleError('Failed to reject work entry'),
  });

  const pendingEntries: PendingWorkEntry[] = data?.workEntries || [];

  const handleOpenReview = (entry: PendingWorkEntry) => {
    setReviewing(entry);
    setNote('');
    setError('');
  };

  const handleCloseReview = () => {
    setReviewing(null);
    setNote('');
  };

  if (!isApprover) {
    return (
      <Alert severity="warning">
        You need the approver role to review submitted work entries.
      </Alert>
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
                        {entry.description || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        startIcon={<ApproveIcon />}
                        color="success"
                        size="small"
                        onClick={() => approveMutation.mutate(entry.id)}
                        disabled={approveMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        startIcon={<RejectIcon />}
                        color="error"
                        size="small"
                        onClick={() => handleOpenReview(entry)}
                        disabled={rejectMutation.isPending}
                      >
                        Reject
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      Nothing awaiting approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!reviewing} onClose={handleCloseReview} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {reviewing?.user_email} — {reviewing?.hours} hours for {reviewing?.client_name}
          </Typography>
          <TextField
            margin="dense"
            label="Reason (optional)"
            fullWidth
            multiline
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseReview} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={rejectMutation.isPending}
            onClick={() => reviewing && rejectMutation.mutate({ id: reviewing.id, note: note || undefined })}
          >
            {rejectMutation.isPending ? <CircularProgress size={24} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
