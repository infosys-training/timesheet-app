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
  const [selectedEntry, setSelectedEntry] = useState<WorkEntry | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, error: pendingApprovalsError } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const getErrorMessage = (err: unknown, fallback: string) => {
    const apiError = err as {
      response?: { status?: number; data?: { error?: string } };
    };

    if (apiError.response?.status === 403) {
      return 'You are not an approver and cannot view pending approvals.';
    }

    return apiError.response?.data?.error || fallback;
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to approve work entry'));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      apiClient.rejectWorkEntry(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      setSelectedEntry(null);
      setRejectionReason('');
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to reject work entry'));
    },
  });

  const pendingEntries: WorkEntry[] = data?.workEntries || [];
  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  const openRejectDialog = (entry: WorkEntry) => {
    setError('');
    setSelectedEntry(entry);
    setRejectionReason('');
  };

  const closeRejectDialog = () => {
    if (!rejectMutation.isPending) {
      setSelectedEntry(null);
      setRejectionReason('');
    }
  };

  const handleReject = () => {
    if (!selectedEntry) {
      return;
    }

    setError('');
    rejectMutation.mutate({
      id: selectedEntry.id,
      reason: rejectionReason || undefined,
    });
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  if (pendingApprovalsError) {
    return (
      <Box>
        <Typography variant="h4" gutterBottom>
          Pending Approvals
        </Typography>
        <Alert severity="error">
          {getErrorMessage(
            pendingApprovalsError,
            'Failed to load pending approvals',
          )}
        </Alert>
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

      {pendingEntries.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            There are no work entries waiting for approval.
          </Typography>
        </Paper>
      ) : (
        <Paper>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Owner</TableCell>
                  <TableCell>Client</TableCell>
                  <TableCell>Date</TableCell>
                  <TableCell>Hours</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pendingEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.user_email}</TableCell>
                    <TableCell>{entry.client_name}</TableCell>
                    <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                    <TableCell>{entry.hours}</TableCell>
                    <TableCell>
                      {entry.description || (
                        <Typography color="text.secondary" variant="body2">
                          No description
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        color="success"
                        onClick={() => approveMutation.mutate(entry.id)}
                        disabled={isMutating}
                        sx={{ mr: 1 }}
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
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <Dialog open={!!selectedEntry} onClose={closeRejectDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Reason (optional)"
            fullWidth
            multiline
            rows={4}
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value)}
            inputProps={{ maxLength: 1000 }}
            helperText={`${rejectionReason.length}/1000`}
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
            onClick={handleReject}
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
