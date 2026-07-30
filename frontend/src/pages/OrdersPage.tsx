import React from 'react';
import { Box, Typography, Card, CardContent, Table, TableBody, TableCell, TableHead, TableRow, Chip } from '@mui/material';
import { useOrders } from '../hooks/useQueries';

export function OrdersPage(): React.ReactElement {
  const { data: orders, isLoading } = useOrders();

  if (isLoading) return <Typography>Loading orders...</Typography>;

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>Orders</Typography>
      <Card elevation={2}>
        <CardContent sx={{ p: 0 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Symbol</TableCell>
                <TableCell>Side</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>L#</TableCell>
                <TableCell>Qty</TableCell>
                <TableCell>Price</TableCell>
                <TableCell>Stop</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Filled Qty</TableCell>
                <TableCell>Avg Price</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(orders ?? []).map((o) => (
                <TableRow key={o.id}>
                  <TableCell><Typography variant="body2" fontWeight="bold">{o.symbol}</Typography></TableCell>
                  <TableCell><Chip label={o.side} size="small" color={o.side === 'BUY' ? 'success' : 'error'} /></TableCell>
                  <TableCell><Typography variant="caption">{o.type}</Typography></TableCell>
                  <TableCell><Chip label={o.role} size="small" variant="outlined" /></TableCell>
                  <TableCell>{o.hedgeLevel}</TableCell>
                  <TableCell>{o.quantity}</TableCell>
                  <TableCell>{o.price != null ? `$${parseFloat(o.price).toFixed(2)}` : '-'}</TableCell>
                  <TableCell>{o.stopPrice != null ? `$${parseFloat(o.stopPrice).toFixed(2)}` : '-'}</TableCell>
                  <TableCell>
                    <Chip label={o.status} size="small"
                      color={o.status === 'FILLED' ? 'success' : o.status === 'CANCELED' ? 'default' : o.status === 'REJECTED' ? 'error' : 'warning'}
                    />
                  </TableCell>
                  <TableCell>{o.filledQuantity}</TableCell>
                  <TableCell>{o.avgFillPrice != null ? `$${parseFloat(o.avgFillPrice).toFixed(2)}` : '-'}</TableCell>
                  <TableCell>{new Date(o.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}
