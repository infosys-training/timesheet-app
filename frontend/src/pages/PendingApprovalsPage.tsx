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
import { useAuth } from '../hooks/useAuth';
import type { WorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedEntry, setSelectedEntry] = useState<WorkEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const pendingQuery = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
    enabled: !!user?.isApprover,
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] }),
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason?: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      setSelectedEntry(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  if (!user?.isApprover) {
    return (
      <Alert severity="error">
        You are not authorized to view pending approvals.
      </Alert>
    );
  }

  if (pendingQuery.isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  const queryError = pendingQuery.error as { response?: { status?: number } } | null;
  if (queryError?.response?.status === 403) {
    return <Alert severity="error">You are not authorized to view pending approvals.</Alert>;
  }

  const entries: WorkEntry[] = pendingQuery.data?.workEntries || [];
  const isBusy = approveMutation.isPending || rejectMutation.isPending;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Pending Approvals</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>User</TableCell>
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
                      size="small"
                      color="success"
                      onClick={() => approveMutation.mutate(entry.id)}
                      disabled={isBusy}
                    >
                      Approve
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      onClick={() => { setSelectedEntry(entry); setReason(''); }}
                      disabled={isBusy}
                    >
                      Reject
                    </Button>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No entries are waiting for approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!selectedEntry} onClose={() => setSelectedEntry(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Reason (optional)"
            fullWidth
            multiline
            rows={3}
            margin="dense"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            inputProps={{ maxLength: 1000 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedEntry(null)} disabled={rejectMutation.isPending}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => selectedEntry && rejectMutation.mutate({ id: selectedEntry.id, rejectionReason: reason })}
            disabled={rejectMutation.isPending}
          >
            {rejectMutation.isPending ? <CircularProgress size={20} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
