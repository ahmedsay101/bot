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
    if (!getToken()) router.replace('/login');
    else setAuthed(true);
  }, [router]);

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  if (!authed) return null;

  const isActive = (href) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const wsOk = status === 'open';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#05070b]/85 backdrop-blur-md">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-5">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="relative inline-flex w-7 h-7 items-center justify-center rounded-md bg-gradient-to-br from-sky-400 to-indigo-500 text-slate-950 font-bold text-sm shadow-[0_0_18px_rgba(56,189,248,0.35)]">
              ₿
            </span>
            <span className="font-semibold tracking-wide text-slate-100 text-sm sm:text-[15px]">
              CRYPTO<span className="text-sky-400"> BOT</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1 flex-1">
            {links.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`relative text-sm px-3 py-1.5 rounded-md transition-colors ${
                    active ? 'text-white bg-slate-800/60' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                  }`}
                >
                  {l.label}
                  {active && (
                    <span className="absolute left-3 right-3 -bottom-[11px] h-0.5 rounded-full bg-gradient-to-r from-sky-400 to-indigo-400" />
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="flex-1 md:hidden" />

          <div
            className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border ${
              wsOk
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
            }`}
            title={`WebSocket: ${status}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${wsOk ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
            {wsOk ? 'LIVE' : 'OFFLINE'}
          </div>

          <span
            className={`sm:hidden w-2 h-2 rounded-full ${wsOk ? 'bg-emerald-400' : 'bg-rose-400'}`}
            title={`WS: ${status}`}
          />

          <KillSwitchToggle />

          <button
            onClick={() => { clearToken(); router.replace('/login'); }}
            className="hidden sm:inline text-xs text-slate-400 hover:text-slate-100 px-2 py-1 rounded-md hover:bg-slate-800/60 transition-colors"
          >
            Logout
          </button>

          <button
            aria-label="Toggle menu"
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md border border-slate-700/80 text-slate-300 hover:bg-slate-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none">
              {menuOpen
                ? <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
      </header>

      <div
        className={`md:hidden fixed inset-0 z-30 transition-opacity ${
          menuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div onClick={() => setMenuOpen(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <aside
          className={`absolute right-0 top-14 bottom-0 w-72 max-w-[85vw] bg-[#0a0f17] border-l border-slate-800 shadow-2xl
            transition-transform duration-200 ${menuOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <nav className="p-3 flex flex-col gap-1">
            {links.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`text-sm px-3 py-2.5 rounded-md transition-colors ${
                    active
                      ? 'bg-sky-500/15 text-sky-300 border-l-2 border-sky-400'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
            <div className="border-t border-slate-800 mt-2 pt-2">
              <button
                onClick={() => { clearToken(); router.replace('/login'); }}
                className="w-full text-left text-sm px-3 py-2.5 rounded-md text-rose-400 hover:bg-rose-500/10"
              >
                Logout
              </button>
            </div>
          </nav>
        </aside>
      </div>

      <main className="flex-1 px-3 sm:px-4 md:px-6 py-4 sm:py-6 max-w-[1600px] w-full mx-auto">
        {children}
      </main>

      <footer className="border-t border-slate-900/60 py-4 px-4 text-center text-[11px] text-slate-600">
        Crypto Bot Console · {new Date().getFullYear()}
      </footer>
    </div>
  );
}
