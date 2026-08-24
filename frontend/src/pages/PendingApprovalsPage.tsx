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
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pendingWorkEntries'],
    queryFn: () => apiClient.getPendingWorkEntries(),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingWorkEntries'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to approve work entry');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingWorkEntries'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      setSelectedEntry(null);
      setReason('');
    },
    onError: (err: unknown) => {
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || 'Failed to reject work entry');
    },
  });

  const pendingEntries: WorkEntry[] = data?.workEntries || [];

  const handleReject = () => {
    if (selectedEntry) {
      rejectMutation.mutate({ id: selectedEntry.id, rejectionReason: reason });
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

      {isError ? (
        <Alert severity="error">Failed to load pending approvals.</Alert>
      ) : (
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
                            setError('');
                            setSelectedEntry(entry);
                            setReason('');
                          }}
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
                        No pending approvals.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <Dialog
        open={selectedEntry !== null}
        onClose={() => !rejectMutation.isPending && setSelectedEntry(null)}
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
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={rejectMutation.isPending}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedEntry(null)} disabled={rejectMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleReject} color="error" variant="contained" disabled={rejectMutation.isPending}>
            {rejectMutation.isPending ? <CircularProgress size={20} /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
