import React from 'react';
import { Box, AppBar, Toolbar, Typography, Chip } from '@mui/material';
import { useSystemHealth, useStatsSummary } from '../../hooks/useQueries';
import { useSystemStore } from '../../stores/systemStore';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps): React.ReactElement {
  const { data: health } = useSystemHealth();
  const { data: summary } = useStatsSummary();
  const dashWs = useSystemStore((s) => s.dashboardWsConnected);

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          bgcolor: 'rgba(15, 22, 34, 0.92)',
          color: 'text.primary',
          borderBottom: '1px solid rgba(120, 160, 200, 0.16)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap', minHeight: { xs: 56, sm: 64 }, py: { xs: 0.5, sm: 0 } }}>
          <Typography
            variant="h6"
            fontWeight={800}
            color="primary"
            sx={{ flexGrow: 1, minWidth: 0, fontSize: { xs: '1rem', sm: '1.2rem' }, letterSpacing: -0.3 }}
          >
            Directional Grid
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, justifyContent: 'flex-end' }}>
            {summary?.tradingMode != null && (
              <Chip
                label={summary.tradingMode}
                size="small"
                color={summary.tradingMode === 'LIVE' ? 'error' : 'info'}
                sx={{ height: 28 }}
              />
            )}
            <Chip
              label={health?.status ?? '…'}
              color={health?.status === 'healthy' ? 'success' : health?.status === 'degraded' ? 'warning' : 'error'}
              size="small"
              sx={{ height: 28 }}
            />
            <Chip
              label={health?.binanceWs ? 'Binance' : 'Bn Down'}
              color={health?.binanceWs ? 'success' : 'error'}
              size="small"
              variant="outlined"
              sx={{ height: 28, display: { xs: 'none', sm: 'inline-flex' } }}
            />
            <Chip
              label={dashWs ? 'Live' : 'Poll'}
              color={dashWs ? 'success' : 'warning'}
              size="small"
              variant="outlined"
              sx={{ height: 28 }}
            />
          </Box>
        </Toolbar>
      </AppBar>

      <Box
        component="main"
        sx={{
          p: { xs: 1.5, sm: 3 },
          maxWidth: 1600,
          mx: 'auto',
          overflowX: 'hidden',
          mt: { xs: 8, sm: 9 },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
