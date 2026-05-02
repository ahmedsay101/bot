import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { getToken, clearToken } from './lib/api.js';
import { useWsStatus } from './lib/ws.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Symbols from './pages/Symbols.jsx';
import Trades from './pages/Trades.jsx';
import StrategyMonitor from './pages/StrategyMonitor.jsx';
import Settings from './pages/Settings.jsx';
import Backtest from './pages/Backtest.jsx';
import KillSwitchToggle from './components/KillSwitchToggle.jsx';

function RequireAuth({ children }) {
  const loc = useLocation();
  if (!getToken()) return <Navigate to="/login" state={{ from: loc }} replace />;
  return children;
}

function Shell() {
  const navigate = useNavigate();
  const status = useWsStatus();
  const links = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/symbols', label: 'Symbols' },
    { to: '/trades', label: 'Trades' },
    { to: '/strategy', label: 'Strategy' },
    { to: '/backtest', label: 'Backtest' },
    { to: '/settings', label: 'Settings' },
  ];
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 bg-[#0a0e14] px-6 py-3 flex items-center gap-6">
        <div className="font-bold text-sky-400 tracking-wide">CRYPTO BOT</div>
        <nav className="flex gap-4 flex-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `text-sm px-2 py-1 rounded ${isActive ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-100'}`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-xs">
          <span className={`w-2 h-2 rounded-full ${status === 'open' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-slate-400">{status}</span>
        </div>
        <KillSwitchToggle />
        <button
          onClick={() => {
            clearToken();
            navigate('/login');
          }}
          className="text-xs text-slate-400 hover:text-slate-100"
        >
          Logout
        </button>
      </header>
      <main className="flex-1 p-6 max-w-[1600px] w-full mx-auto">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="symbols" element={<Symbols />} />
          <Route path="trades" element={<Trades />} />
          <Route path="strategy" element={<StrategyMonitor />} />
          <Route path="strategy/:symbol" element={<StrategyMonitor />} />
          <Route path="backtest" element={<Backtest />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
