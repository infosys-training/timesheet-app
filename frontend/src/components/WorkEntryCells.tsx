import React from 'react';
import { Chip, TableCell, Typography } from '@mui/material';
import { type WorkEntry } from '../types/api';

interface WorkEntryCellsProps {
  entry: WorkEntry;
}

// Client / date / hours / description cells, shared by the work entry and
// pending approval tables
const WorkEntryCells: React.FC<WorkEntryCellsProps> = ({ entry }) => (
  <>
    <TableCell>
      <Typography variant="subtitle1" fontWeight="medium">
        {entry.client_name}
      </Typography>
    </TableCell>
    <TableCell>
      <Typography variant="body2">{new Date(entry.date).toLocaleDateString()}</Typography>
    </TableCell>
    <TableCell>
      <Chip label={`${entry.hours} hours`} color="primary" variant="outlined" />
    </TableCell>
    <TableCell>
      {entry.description ? (
        <Typography variant="body2" color="text.secondary">
          {entry.description}
        </Typography>
      ) : (
        <Chip label="No description" size="small" variant="outlined" />
      )}
    </TableCell>
  </>
);

export default WorkEntryCells;
