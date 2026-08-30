import React from 'react';
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

interface EntryTableProps {
  columns: string[];
  isEmpty: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}

// Table shell shared by the work entry and pending approval tables: the last
// column is right aligned for row actions
const EntryTable: React.FC<EntryTableProps> = ({ columns, isEmpty, emptyMessage, children }) => (
  <Paper>
    <TableContainer>
      <Table>
        <TableHead>
          <TableRow>
            {columns.map((column, index) => (
              <TableCell key={column} align={index === columns.length - 1 ? 'right' : 'left'}>
                {column}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {isEmpty ? (
            <TableRow>
              <TableCell colSpan={columns.length} align="center">
                <Typography color="text.secondary" sx={{ py: 3 }}>
                  {emptyMessage}
                </Typography>
              </TableCell>
            </TableRow>
          ) : (
            children
          )}
        </TableBody>
      </Table>
    </TableContainer>
  </Paper>
);

export default EntryTable;
