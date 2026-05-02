'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getToken, clearToken } from '../lib/api.js';
import { useWsStatus } from '../lib/ws.js';
import KillSwitchToggle from './KillSwitchToggle.jsx';

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/symbols', label: 'Symbols' },
  { href: '/trades', label: 'Trades' },
  { href: '/strategy', label: 'Strategy' },
  { href: '/backtest', label: 'Backtest' },
  { href: '/debug', label: 'Debug' },
  { href: '/settings', label: 'Settings' },
];

export default function Shell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useWsStatus();
  const [authed, setAuthed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
    } else {
      setAuthed(true);
    }
  }, [router]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  if (!authed) return null;

  const isActive = (href) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 bg-[#0a0e14] px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="font-bold text-sky-400 tracking-wide text-sm sm:text-base whitespace-nowrap">
            CRYPTO BOT
          </div>

          <nav className="hidden md:flex gap-2 lg:gap-4 flex-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`text-sm px-2 py-1 rounded ${
                  isActive(l.href)
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex-1 md:hidden" />

          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                status === 'open' ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
            <span className="text-slate-400 hidden sm:inline">{status}</span>
          </div>

          <KillSwitchToggle />

          <button
            onClick={() => {
              clearToken();
              router.replace('/login');
            }}
            className="hidden sm:inline text-xs text-slate-400 hover:text-slate-100"
          >
            Logout
          </button>

          <button
            aria-label="Toggle menu"
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none">
              {menuOpen ? (
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <nav className="md:hidden mt-3 flex flex-col gap-1 border-t border-slate-800 pt-3">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`text-sm px-3 py-2 rounded ${
                  isActive(l.href)
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {l.label}
              </Link>
            ))}
            <button
              onClick={() => {
                clearToken();
                router.replace('/login');
              }}
              className="mt-1 text-left text-sm px-3 py-2 rounded text-rose-400 hover:bg-slate-800"
            >
              Logout
            </button>
          </nav>
        )}
      </header>

      <main className="flex-1 p-3 sm:p-4 md:p-6 max-w-[1600px] w-full mx-auto">{children}</main>
    </div>
  );
}
