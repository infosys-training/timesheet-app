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
import { type PendingApproval } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const [rejectionEntry, setRejectionEntry] = useState<PendingApproval | null>(null);
  const [rejectionNote, setRejectionNote] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const getErrorMessage = (err: unknown) => {
    const requestError = err as { response?: { data?: { error?: string } } };
    return requestError.response?.data?.error || 'Failed to update work entry';
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
    },
    onError: (err: unknown) => setError(getErrorMessage(err)),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) => apiClient.rejectWorkEntry(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      setRejectionEntry(null);
      setRejectionNote('');
    },
    onError: (err: unknown) => setError(getErrorMessage(err)),
  });

  const pendingApprovals: PendingApproval[] = data?.workEntries || [];
  const isPending = approveMutation.isPending || rejectMutation.isPending;

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
              {pendingApprovals.length > 0 ? (
                pendingApprovals.map((entry) => (
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
                        onClick={() => approveMutation.mutate(entry.id)}
                        disabled={isPending}
                        sx={{ mr: 1 }}
                      >
                        Approve
                      </Button>
                      <Button
                        color="error"
                        variant="outlined"
                        size="small"
                        onClick={() => {
                          setError('');
                          setRejectionEntry(entry);
                        }}
                        disabled={isPending}
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

      <Dialog
        open={Boolean(rejectionEntry)}
        onClose={() => !isPending && setRejectionEntry(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Reason (optional)"
            fullWidth
            multiline
            rows={4}
            value={rejectionNote}
            onChange={(event) => setRejectionNote(event.target.value)}
            inputProps={{ maxLength: 1000 }}
            disabled={isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectionEntry(null)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => rejectionEntry && rejectMutation.mutate({
              id: rejectionEntry.id,
              note: rejectionNote.trim() || undefined,
            })}
            disabled={isPending}
          >
            {rejectMutation.isPending ? <CircularProgress size={22} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
