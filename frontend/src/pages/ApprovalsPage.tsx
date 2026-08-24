import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { type PendingApprovalEntry } from '../types/api';

const ApprovalsPage: React.FC = () => {
  const [error, setError] = useState('');
  const [rejectingEntry, setRejectingEntry] = useState<PendingApprovalEntry | null>(null);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason?: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      setRejectingEntry(null);
      setReason('');
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  const pendingApprovals: PendingApprovalEntry[] = data?.workEntries || [];

  const handleReject = () => {
    if (rejectingEntry) {
      rejectMutation.mutate({ id: rejectingEntry.id, rejectionReason: reason || undefined });
    }
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" mb={3}>Pending Approvals</Typography>
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
                <TableCell>Owner Email</TableCell>
                <TableCell>Client</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Hours</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pendingApprovals.length > 0 ? pendingApprovals.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.user_email}</TableCell>
                  <TableCell>{entry.client_name}</TableCell>
                  <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                  <TableCell>{entry.hours}</TableCell>
                  <TableCell>{entry.description || 'No description'}</TableCell>
                  <TableCell align="right">
                    <Button
                      color="success"
                      onClick={() => approveMutation.mutate(entry.id)}
                      disabled={approveMutation.isPending || rejectMutation.isPending}
                    >
                      Approve
                    </Button>
                    <Button
                      color="error"
                      onClick={() => {
                        setRejectingEntry(entry);
                        setReason('');
                        setError('');
                      }}
                      disabled={approveMutation.isPending || rejectMutation.isPending}
                    >
                      Reject
                    </Button>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No work entries are pending approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!rejectingEntry} onClose={() => setRejectingEntry(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Reason (optional)"
            fullWidth
            multiline
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectingEntry(null)} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleReject} color="error" disabled={rejectMutation.isPending}>
            {rejectMutation.isPending ? <CircularProgress size={24} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ApprovalsPage;
