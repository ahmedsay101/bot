import React from 'react';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Layout } from './components/layout/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { TradersPage, TraderDetailPage } from './pages/TradersPage';
import { OrdersPage } from './pages/OrdersPage';
import { StatisticsPage } from './pages/StatisticsPage';
import { ConfigurationPage } from './pages/ConfigurationPage';
import { LogsPage } from './pages/LogsPage';
import { SystemHealthPage } from './pages/SystemHealthPage';
import { useWebSocket } from './services/websocket';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 2,
    },
  },
});

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#2196f3' },
    secondary: { main: '#f50057' },
    success: { main: '#4caf50' },
    background: { default: '#0a0e1a', paper: '#141824' },
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
  },
  components: {
    MuiCard: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});

function AppContent(): React.ReactElement {
  useWebSocket();
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/traders" element={<TradersPage />} />
        <Route path="/traders/:id" element={<TraderDetailPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/statistics" element={<StatisticsPage />} />
        <Route path="/config" element={<ConfigurationPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/health" element={<SystemHealthPage />} />
        <Route path="/positions" element={<Navigate to="/traders" replace />} />
        <Route path="/trades" element={<Navigate to="/orders" replace />} />
        <Route path="/simulation" element={<Navigate to="/health" replace />} />
      </Routes>
    </Layout>
  );
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </ThemeProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
