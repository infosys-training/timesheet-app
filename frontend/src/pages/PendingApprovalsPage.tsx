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
import { type PendingWorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [rejectingEntry, setRejectingEntry] = useState<PendingWorkEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const pendingQuery = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const refreshEntries = () => {
    queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
    queryClient.invalidateQueries({ queryKey: ['workEntries'] });
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: refreshEntries,
    onError: (err: unknown) => {
      const responseError = err as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason: rejectionReason }: { id: number; reason?: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      setRejectingEntry(null);
      setReason('');
      refreshEntries();
    },
    onError: (err: unknown) => {
      const responseError = err as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  const entries: PendingWorkEntry[] = pendingQuery.data?.workEntries || [];
  const status = (pendingQuery.error as { response?: { status?: number } } | null)?.response?.status;

  if (pendingQuery.isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  if (status === 403) {
    return (
      <Alert severity="info">
        You do not have permission to view pending approvals.
      </Alert>
    );
  }

  if (pendingQuery.isError) {
    return <Alert severity="error">Failed to load pending approvals.</Alert>;
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
                      size="small"
                      onClick={() => approveMutation.mutate(entry.id)}
                      disabled={approveMutation.isPending || rejectMutation.isPending}
                    >
                      Approve
                    </Button>
                    <Button
                      color="error"
                      size="small"
                      onClick={() => {
                        setRejectingEntry(entry);
                        setReason('');
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
                      No work entries are waiting for approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog
        open={!!rejectingEntry}
        onClose={() => !rejectMutation.isPending && setRejectingEntry(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            rows={3}
            margin="dense"
            label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            inputProps={{ maxLength: 1000 }}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectingEntry(null)} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => rejectingEntry && rejectMutation.mutate({
              id: rejectingEntry.id,
              reason: reason || undefined,
            })}
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
