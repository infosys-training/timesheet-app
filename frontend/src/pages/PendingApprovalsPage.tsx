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
  const [rejectingEntry, setRejectingEntry] = useState<WorkEntry | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, reviewNote }: { id: number; action: 'approve' | 'reject'; reviewNote?: string }) =>
      action === 'approve'
        ? apiClient.approveWorkEntry(id, reviewNote)
        : apiClient.rejectWorkEntry(id, reviewNote),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['workEntries'] });
      setRejectingEntry(null);
      setNote('');
    },
    onError: (err: unknown) => {
      const responseError = err as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error || 'Failed to review work entry');
    },
  });

  const entries: WorkEntry[] = data?.workEntries || [];

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  const approve = (entry: WorkEntry) => {
    reviewMutation.mutate({ id: entry.id, action: 'approve' });
  };

  const reject = () => {
    if (!rejectingEntry) return;
    reviewMutation.mutate({ id: rejectingEntry.id, action: 'reject', reviewNote: note });
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Pending Approvals</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
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
                      onClick={() => approve(entry)}
                      disabled={reviewMutation.isPending}
                    >
                      Approve
                    </Button>
                    <Button
                      color="error"
                      onClick={() => { setRejectingEntry(entry); setNote(''); }}
                      disabled={reviewMutation.isPending}
                    >
                      Reject
                    </Button>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>No pending approvals.</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!rejectingEntry} onClose={() => setRejectingEntry(null)} fullWidth maxWidth="sm">
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            rows={4}
            margin="dense"
            label="Review note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            inputProps={{ maxLength: 1000 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectingEntry(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={reject} disabled={reviewMutation.isPending}>
            Reject
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
