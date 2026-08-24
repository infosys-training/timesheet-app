import React, { useEffect, useRef, useState } from 'react';
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
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const reasonInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] }),
    onError: () => setError('Failed to approve work entry'),
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason?: string }) =>
      apiClient.rejectWorkEntry(id, rejectionReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
      setRejectingEntry(null);
      setReason('');
    },
    onError: () => setError('Failed to reject work entry'),
  });

  useEffect(() => {
    if (!rejectingEntry) return undefined;
    const focusTimer = window.setTimeout(() => reasonInputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [rejectingEntry]);

  if (isLoading) {
    return <Box display="flex" justifyContent="center" minHeight="400px" alignItems="center"><CircularProgress /></Box>;
  }

  const entries: WorkEntry[] = data?.workEntries || [];
  return (
    <Box>
      <Typography variant="h4" mb={3}>Pending Approvals</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Submitted by</TableCell>
                <TableCell>Client</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Hours</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.length ? entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.user_email}</TableCell>
                  <TableCell>{entry.client_name}</TableCell>
                  <TableCell>{new Date(entry.date).toLocaleDateString()}</TableCell>
                  <TableCell>{entry.hours}</TableCell>
                  <TableCell>{entry.description || 'No description'}</TableCell>
                  <TableCell align="right">
                    <Button size="small" color="success" onClick={() => approveMutation.mutate(entry.id)}>
                      Approve
                    </Button>
                    <Button size="small" color="error" onClick={() => setRejectingEntry(entry)}>
                      Reject
                    </Button>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={6} align="center">No pending approvals.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
      <Dialog open={Boolean(rejectingEntry)} onClose={() => setRejectingEntry(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Entry</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            multiline
            rows={3}
            margin="dense"
            label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            inputProps={{ maxLength: 1000 }}
            inputRef={reasonInputRef}
            slotProps={{ htmlInput: { autoFocus: true } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectingEntry(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!rejectingEntry || rejectMutation.isPending}
            onClick={() => rejectingEntry && rejectMutation.mutate({ id: rejectingEntry.id, rejectionReason: reason })}
          >
            Reject
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PendingApprovalsPage;
