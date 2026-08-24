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
import { type WorkEntry } from '../types/api';
import { useAuth } from '../hooks/useAuth';

const PendingApprovalsPage: React.FC = () => {
  const [rejectingEntry, setRejectingEntry] = useState<WorkEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
    enabled: !!user?.isApprover,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
    queryClient.invalidateQueries({ queryKey: ['workEntries'] });
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: invalidate,
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason: rejectionReason }: { id: number; reason: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      invalidate();
      handleCloseReject();
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  const pendingEntries: WorkEntry[] = data?.workEntries || [];

  const handleCloseReject = () => {
    setRejectingEntry(null);
    setReason('');
  };

  const handleReject = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!reason.trim()) {
      setError('A rejection reason is required');
      return;
    }

    if (rejectingEntry) {
      rejectMutation.mutate({ id: rejectingEntry.id, reason: reason.trim() });
    }
  };

  if (!user?.isApprover) {
    return (
      <Box>
        <Typography variant="h4" sx={{ mb: 3 }}>Pending Approvals</Typography>
        <Alert severity="info">
          Your account is not configured as an approver.
        </Alert>
      </Box>
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
      <Typography variant="h4" sx={{ mb: 3 }}>Pending Approvals</Typography>

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
                <TableCell>Submitted</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pendingEntries.length > 0 ? (
                pendingEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Typography variant="body2">{entry.user_email}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="subtitle1" fontWeight="medium">
                        {entry.client_name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(entry.date).toLocaleDateString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={`${entry.hours} hours`} color="primary" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      {entry.description ? (
                        <Typography variant="body2" color="text.secondary">
                          {entry.description}
                        </Typography>
                      ) : (
                        <Chip label="No description" size="small" variant="outlined" />
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {entry.submitted_at ? new Date(entry.submitted_at).toLocaleString() : '-'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="success"
                        startIcon={<ApproveIcon />}
                        onClick={() => {
                          setError('');
                          approveMutation.mutate(entry.id);
                        }}
                        disabled={approveMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<RejectIcon />}
                        onClick={() => {
                          setError('');
                          setRejectingEntry(entry);
                        }}
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

      <Dialog open={!!rejectingEntry} onClose={handleCloseReject} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <form onSubmit={handleReject}>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {rejectingEntry?.hours} hours for {rejectingEntry?.client_name} by {rejectingEntry?.user_email}
            </Typography>
            <TextField
              margin="dense"
              label="Reason"
              fullWidth
              required
              multiline
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={rejectMutation.isPending}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={handleCloseReject} disabled={rejectMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" color="error" disabled={rejectMutation.isPending}>
              {rejectMutation.isPending ? <CircularProgress size={24} /> : 'Reject'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
