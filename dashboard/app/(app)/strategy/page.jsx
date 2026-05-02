'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function StrategyIndexPage() {
  const [input, setInput] = useState('');
  const router = useRouter();
  const submit = (e) => {
    e.preventDefault();
    if (input) router.push(`/strategy/${input.toUpperCase()}`);
  };
  return (
    <form onSubmit={submit} className="flex gap-3 items-end">
      <div>
        <label className="block text-xs text-slate-400 mb-1">Symbol</label>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="BTCUSDT"
          className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
        />
      </div>
      <button className="bg-sky-600 hover:bg-sky-500 text-sm font-semibold rounded px-3 py-1.5">Load</button>
    </form>
  );
}
