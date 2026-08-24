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
import { type WorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const [rejectionEntry, setRejectionEntry] = useState<WorkEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
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
      const responseError = err as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason?: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      setRejectionEntry(null);
      setReason('');
    },
    onError: (err: unknown) => {
      const responseError = err as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  const pendingEntries: WorkEntry[] = data?.workEntries || [];

  const openRejectDialog = (entry: WorkEntry) => {
    setError('');
    setReason('');
    setRejectionEntry(entry);
  };

  const closeRejectDialog = () => {
    if (!rejectMutation.isPending) {
      setRejectionEntry(null);
      setReason('');
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
      <Typography variant="h4" gutterBottom>
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
                    <TableCell>{entry.hours}</TableCell>
                    <TableCell>{entry.description || 'No description'}</TableCell>
                    <TableCell align="right">
                      <Button
                        color="success"
                        variant="contained"
                        size="small"
                        sx={{ mr: 1 }}
                        onClick={() => approveMutation.mutate(entry.id)}
                        disabled={approveMutation.isPending || rejectMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        color="error"
                        variant="outlined"
                        size="small"
                        onClick={() => openRejectDialog(entry)}
                        disabled={approveMutation.isPending || rejectMutation.isPending}
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
                      No work entries are waiting for approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={Boolean(rejectionEntry)} onClose={closeRejectDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Add an optional reason for {rejectionEntry?.user_email}&apos;s entry.
          </Typography>
          <TextField
            label="Reason"
            fullWidth
            multiline
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            inputProps={{ maxLength: 1000 }}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRejectDialog} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => rejectionEntry && rejectMutation.mutate({
              id: rejectionEntry.id,
              rejectionReason: reason,
            })}
            disabled={rejectMutation.isPending}
          >
            {rejectMutation.isPending ? <CircularProgress size={22} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
