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
import { type PendingApprovalWorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const [rejectingEntry, setRejectingEntry] = useState<PendingApprovalWorkEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const getErrorMessage = (err: unknown, fallback: string) => {
    const responseError = err as { response?: { data?: { error?: string } } };
    return responseError.response?.data?.error || fallback;
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
    },
    onError: (err: unknown) => setError(getErrorMessage(err, 'Failed to approve work entry')),
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
    onError: (err: unknown) => setError(getErrorMessage(err, 'Failed to reject work entry')),
  });

  const entries = (data?.workEntries || []) as PendingApprovalWorkEntry[];
  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  const openRejectDialog = (entry: PendingApprovalWorkEntry) => {
    setError('');
    setReason('');
    setRejectingEntry(entry);
  };

  const closeRejectDialog = () => {
    if (!rejectMutation.isPending) {
      setRejectingEntry(null);
      setReason('');
    }
  };

  const submitRejection = () => {
    if (rejectingEntry) {
      rejectMutation.mutate({
        id: rejectingEntry.id,
        rejectionReason: reason.trim() || undefined,
      });
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
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.length > 0 ? entries.map((entry) => (
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
                      disabled={isMutating}
                    >
                      Approve
                    </Button>
                    <Button
                      color="error"
                      onClick={() => openRejectDialog(entry)}
                      disabled={isMutating}
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

      <Dialog open={Boolean(rejectingEntry)} onClose={closeRejectDialog} maxWidth="sm" fullWidth>
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
            inputProps={{ maxLength: 1000 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRejectDialog} disabled={rejectMutation.isPending}>Cancel</Button>
          <Button onClick={submitRejection} color="error" variant="contained" disabled={rejectMutation.isPending}>
            {rejectMutation.isPending ? <CircularProgress size={24} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
