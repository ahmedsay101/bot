import React from 'react';
import { Box, Typography, Alert, Card, CardContent, Chip } from '@mui/material';
import { useSystemHealth } from '../hooks/useQueries';

export function SimulationPage(): React.ReactElement {
  const { data: health } = useSystemHealth();

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>Simulation Mode</Typography>

      <Alert severity="info" sx={{ mb: 3 }}>
        Simulation mode uses real Binance WebSocket mark prices with simulated order execution.
        All trading calculations are identical to live mode — only the order filling differs.
      </Alert>

      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Simulation Status</Typography>
          <Box display="flex" gap={2} flexWrap="wrap">
            <Chip label={`WebSocket: ${health?.binanceWs ? 'Connected' : 'Disconnected'}`} color={health?.binanceWs ? 'success' : 'error'} />
            <Chip label={`Active Traders: ${health?.activeTraders ?? 0}`} color="primary" />
          </Box>
          <Typography variant="body2" color="text.secondary" mt={2}>
            The simulation provider:
          </Typography>
          <Box component="ul" sx={{ pl: 2, mt: 1 }}>
            <li><Typography variant="body2">Uses real Binance Futures mark prices via WebSocket</Typography></li>
            <li><Typography variant="body2">Simulates 50–100ms execution latency</Typography></li>
            <li><Typography variant="body2">Applies configured slippage to market orders</Typography></li>
            <li><Typography variant="body2">Charges configured fee rates on fills</Typography></li>
            <li><Typography variant="body2">Simulates ~25% partial fill rate on fills (remainder completes shortly after)</Typography></li>
            <li><Typography variant="body2">Triggers STOP_LIMIT / TAKE_PROFIT orders when price crosses</Typography></li>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
