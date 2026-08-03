import React, { useState } from 'react';
import {
  Box, Drawer, AppBar, Toolbar, Typography, List, ListItemButton,
  ListItemIcon, ListItemText, IconButton, Chip, useTheme,
} from '@mui/material';
import {
  Dashboard, People, Receipt, BarChart, Settings, Article, MonitorHeart, Menu,
} from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSystemHealth, useStatsSummary } from '../../hooks/useQueries';
import { useSystemStore } from '../../stores/systemStore';

const DRAWER_WIDTH = 220;

const navItems = [
  { label: 'Dashboard', path: '/', icon: <Dashboard /> },
  { label: 'Traders', path: '/traders', icon: <People /> },
  { label: 'Orders', path: '/orders', icon: <Receipt /> },
  { label: 'Statistics', path: '/statistics', icon: <BarChart /> },
  { label: 'Configuration', path: '/config', icon: <Settings /> },
  { label: 'Logs', path: '/logs', icon: <Article /> },
  { label: 'Health', path: '/health', icon: <MonitorHeart /> },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps): React.ReactElement {
  const theme = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: health } = useSystemHealth();
  const { data: summary } = useStatsSummary();
  const dashWs = useSystemStore((s) => s.dashboardWsConnected);

  const drawer = (
    <Box>
      <Toolbar>
        <Typography variant="h6" fontWeight="bold" color="primary">
          Speed
        </Typography>
      </Toolbar>
      <List dense>
        {navItems.map((item) => (
          <ListItemButton
            key={item.path}
            selected={location.pathname === item.path}
            onClick={() => { void navigate(item.path); setMobileOpen(false); }}
          >
            <ListItemIcon sx={{ minWidth: 36, color: location.pathname === item.path ? 'primary.main' : 'inherit' }}>
              {item.icon}
            </ListItemIcon>
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="fixed" sx={{ zIndex: theme.zIndex.drawer + 1, bgcolor: 'background.paper', color: 'text.primary', boxShadow: 1 }}>
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap', minHeight: { xs: 56, sm: 64 }, py: { xs: 0.5, sm: 0 } }}>
          <IconButton edge="start" onClick={() => setMobileOpen(!mobileOpen)} sx={{ display: { sm: 'none' }, minWidth: 44, minHeight: 44 }}>
            <Menu />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1, minWidth: 0, fontSize: { xs: '1rem', sm: '1.25rem' } }}>
            Futures Bot
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, justifyContent: 'flex-end', maxWidth: '100%' }}>
            {summary?.tradingMode != null && (
              <Chip label={summary.tradingMode} size="small" color={summary.tradingMode === 'LIVE' ? 'error' : 'info'} sx={{ height: 28 }} />
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

      <Box component="nav" sx={{ width: { sm: DRAWER_WIDTH }, flexShrink: { sm: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ display: { xs: 'block', sm: 'none' }, '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}
        >
          {drawer}
        </Drawer>
        <Drawer
          variant="permanent"
          sx={{ display: { xs: 'none', sm: 'block' }, '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' } }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: { xs: 1.5, sm: 3 },
          width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` },
          maxWidth: '100%',
          overflowX: 'hidden',
          mt: { xs: 9, sm: 8 },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
