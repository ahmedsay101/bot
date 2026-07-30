import React, { useState } from 'react';
import {
  Box, Drawer, AppBar, Toolbar, Typography, List, ListItemButton,
  ListItemIcon, ListItemText, IconButton, Chip, useTheme,
} from '@mui/material';
import {
  Dashboard, People, Receipt, AccountBalance, SwapHoriz,
  BarChart, Settings, Article, PlayArrow, MonitorHeart, Menu,
} from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSystemHealth } from '../../hooks/useQueries';

const DRAWER_WIDTH = 240;

const navItems = [
  { label: 'Dashboard', path: '/', icon: <Dashboard /> },
  { label: 'Traders', path: '/traders', icon: <People /> },
  { label: 'Orders', path: '/orders', icon: <Receipt /> },
  { label: 'Positions', path: '/positions', icon: <AccountBalance /> },
  { label: 'Trades', path: '/trades', icon: <SwapHoriz /> },
  { label: 'Statistics', path: '/statistics', icon: <BarChart /> },
  { label: 'Configuration', path: '/config', icon: <Settings /> },
  { label: 'Logs', path: '/logs', icon: <Article /> },
  { label: 'Simulation', path: '/simulation', icon: <PlayArrow /> },
  { label: 'System Health', path: '/health', icon: <MonitorHeart /> },
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

  const drawer = (
    <Box>
      <Toolbar>
        <Typography variant="h6" fontWeight="bold" color="primary">
          Futures Bot
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
        <Toolbar>
          <IconButton edge="start" onClick={() => setMobileOpen(!mobileOpen)} sx={{ mr: 2, display: { sm: 'none' } }}>
            <Menu />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Binance Futures Trading Bot
          </Typography>
          <Chip
            label={health?.status ?? 'connecting'}
            color={health?.status === 'healthy' ? 'success' : health?.status === 'degraded' ? 'warning' : 'error'}
            size="small"
            sx={{ mr: 1 }}
          />
          <Chip
            label={health?.binanceWs ? 'WS Connected' : 'WS Disconnected'}
            color={health?.binanceWs ? 'success' : 'error'}
            size="small"
            variant="outlined"
          />
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

      <Box component="main" sx={{ flexGrow: 1, p: 3, width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` }, mt: 8 }}>
        {children}
      </Box>
    </Box>
  );
}
