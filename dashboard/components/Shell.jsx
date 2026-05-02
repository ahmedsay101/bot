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
  { href: '/settings', label: 'Settings' },
];

export default function Shell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useWsStatus();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
    } else {
      setAuthed(true);
    }
  }, [router]);

  if (!authed) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 bg-[#0a0e14] px-6 py-3 flex items-center gap-6">
        <div className="font-bold text-sky-400 tracking-wide">CRYPTO BOT</div>
        <nav className="flex gap-4 flex-1">
          {links.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`text-sm px-2 py-1 rounded ${
                  active ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 text-xs">
          <span className={`w-2 h-2 rounded-full ${status === 'open' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-slate-400">{status}</span>
        </div>
        <KillSwitchToggle />
        <button
          onClick={() => {
            clearToken();
            router.replace('/login');
          }}
          className="text-xs text-slate-400 hover:text-slate-100"
        >
          Logout
        </button>
      </header>
      <main className="flex-1 p-6 max-w-[1600px] w-full mx-auto">{children}</main>
    </div>
  );
}
