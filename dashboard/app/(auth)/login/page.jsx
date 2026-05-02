'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { login } from '../../../lib/api.js';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username, password);
      const dest = search.get('next') || '/';
      router.replace(dest);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm bg-[#0a0e14] border border-slate-800 rounded-lg p-6">
      <h1 className="text-xl font-bold text-sky-400 mb-1">Crypto Bot</h1>
      <p className="text-sm text-slate-500 mb-4">Sign in to continue</p>
      <label className="block text-xs text-slate-400 mb-1">Username</label>
      <input
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-3"
      />
      <label className="block text-xs text-slate-400 mb-1">Password</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-4"
      />
      {error && <div className="text-rose-400 text-sm mb-3">{error}</div>}
      <button
        disabled={busy}
        className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded py-2 text-sm font-semibold"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <Suspense fallback={<div className="text-slate-500">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
