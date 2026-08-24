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
  Chip,
  CircularProgress,
} from '@mui/material';
import {
  Check as CheckIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import WorkEntryStatusChip from '../components/WorkEntryStatusChip';
import { useAuth } from '../hooks/useAuth';
import { type PendingWorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const { user } = useAuth();
  const [error, setError] = useState('');
  const [rejectingEntry, setRejectingEntry] = useState<PendingWorkEntry | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

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
    mutationFn: ({ id, reason }: { id: number; reason?: string }) => apiClient.rejectWorkEntry(id, reason),
    onSuccess: () => {
      invalidate();
      handleCloseReject();
    },
    onError: handleError('Failed to reject work entry'),
  });

  const pendingEntries: PendingWorkEntry[] = data?.workEntries || [];

  const handleCloseReject = () => {
    setRejectingEntry(null);
    setRejectionReason('');
  };

  const handleConfirmReject = () => {
    if (!rejectingEntry) {
      return;
    }
    setError('');
    rejectMutation.mutate({
      id: rejectingEntry.id,
      reason: rejectionReason.trim() || undefined,
    });
  };

  if (!user?.isApprover) {
    return (
      <Alert severity="info">
        You do not have the approver role, so there is nothing to approve here.
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
                pendingEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.user_email}</TableCell>
                    <TableCell>{entry.client_name}</TableCell>
                    <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                    <TableCell>{entry.hours}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {entry.description || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <WorkEntryStatusChip status={entry.status} />
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="success"
                        startIcon={<CheckIcon />}
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
                        startIcon={<CloseIcon />}
                        onClick={() => {
                          setError('');
                          setRejectingEntry(entry);
                        }}
                        disabled={rejectMutation.isPending}
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
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {rejectingEntry && `${rejectingEntry.hours} hours for ${rejectingEntry.client_name} by ${rejectingEntry.user_email}`}
          </Typography>
          <TextField
            autoFocus
            margin="dense"
            label="Reason (optional)"
            fullWidth
            multiline
            rows={3}
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseReject} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleConfirmReject}
            disabled={rejectMutation.isPending}
          >
            {rejectMutation.isPending ? <CircularProgress size={24} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
