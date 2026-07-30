import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Typography, Card, CardContent, Grid, Chip, Button, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { useAllTraders, useTraderById } from '../hooks/useQueries';

export function TradersPage(): React.ReactElement {
  const { data: traders, isLoading } = useAllTraders();
  const navigate = useNavigate();

  if (isLoading) return <Typography>Loading traders...</Typography>;

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>Traders</Typography>
      <Card elevation={2}>
        <CardContent sx={{ p: 0 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Symbol</TableCell>
                <TableCell>Mode</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Leverage</TableCell>
                <TableCell>Entry</TableCell>
                <TableCell>Hedge Level</TableCell>
                <TableCell align="right">Realized PnL</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(traders ?? []).map((t) => (
                <TableRow
                  key={t.id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => void navigate(`/traders/${t.id}`)}
                >
                  <TableCell><Typography fontWeight="bold">{t.symbol}</Typography></TableCell>
                  <TableCell><Chip label={t.mode} size="small" variant="outlined" /></TableCell>
                  <TableCell>
                    <Chip
                      label={t.status}
                      size="small"
                      color={t.status === 'ACTIVE' ? 'success' : t.status === 'COMPLETED' ? 'default' : t.status === 'FAILED' ? 'error' : 'warning'}
                    />
                  </TableCell>
                  <TableCell>{t.leverage}x</TableCell>
                  <TableCell>{t.shortEntryPrice != null ? `$${parseFloat(t.shortEntryPrice).toFixed(2)}` : '-'}</TableCell>
                  <TableCell>L{t.currentHedgeLevel}</TableCell>
                  <TableCell align="right" sx={{ color: parseFloat(t.realizedPnl) >= 0 ? 'success.main' : 'error.main' }}>
                    ${parseFloat(t.realizedPnl).toFixed(2)}
                  </TableCell>
                  <TableCell>{new Date(t.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}

export function TraderDetailPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const { data: trader, isLoading } = useTraderById(id);
  const navigate = useNavigate();

  if (isLoading) return <Typography>Loading...</Typography>;
  if (trader == null) return <Typography>Trader not found</Typography>;

  return (
    <Box>
      <Button startIcon={<ArrowBack />} onClick={() => void navigate('/traders')} sx={{ mb: 2 }}>
        Back to Traders
      </Button>
      <Typography variant="h4" fontWeight="bold" mb={3}>{trader.symbol} Trader</Typography>

      <Grid container spacing={2} mb={3}>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Status</Typography>
            <Chip label={trader.status} color={trader.status === 'ACTIVE' ? 'success' : 'default'} />
          </CardContent></Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Short Entry</Typography>
            <Typography variant="h6">{trader.shortEntryPrice != null ? `$${parseFloat(trader.shortEntryPrice).toFixed(2)}` : 'N/A'}</Typography>
          </CardContent></Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Short TP</Typography>
            <Typography variant="h6" color="success.main">{trader.shortTpPrice != null ? `$${parseFloat(trader.shortTpPrice).toFixed(2)}` : 'N/A'}</Typography>
          </CardContent></Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Realized PnL</Typography>
            <Typography variant="h6" color={parseFloat(trader.realizedPnl) >= 0 ? 'success.main' : 'error.main'}>
              ${parseFloat(trader.realizedPnl).toFixed(4)}
            </Typography>
          </CardContent></Card>
        </Grid>
      </Grid>

      <Card elevation={2} sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Recent Orders</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Side</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Qty</TableCell>
                <TableCell>Price</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {trader.orders.slice(0, 20).map((o) => (
                <TableRow key={o.id}>
                  <TableCell><Chip label={o.side} size="small" color={o.side === 'BUY' ? 'success' : 'error'} /></TableCell>
                  <TableCell>{o.type}</TableCell>
                  <TableCell><Chip label={o.role} size="small" variant="outlined" /></TableCell>
                  <TableCell>{o.quantity}</TableCell>
                  <TableCell>{o.price != null ? `$${parseFloat(o.price).toFixed(2)}` : 'MARKET'}</TableCell>
                  <TableCell><Chip label={o.status} size="small" /></TableCell>
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
