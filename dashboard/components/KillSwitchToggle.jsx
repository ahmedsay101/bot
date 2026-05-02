'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api.js';

export default function KillSwitchToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet('/settings'),
    refetchInterval: 5000,
  });
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: (enabled) => apiPost('/kill-switch', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const enabled = !!data?.killSwitch;

  const onClick = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    mutation.mutate(!enabled);
    setConfirming(false);
  };

  const base =
    'inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-md border transition-all';

  return (
    <button
      onClick={onClick}
      title={enabled ? 'Trading halted — click to resume' : 'Halt all new entries'}
      className={
        enabled
          ? `${base} bg-rose-600 border-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,0.5)]`
          : confirming
          ? `${base} bg-amber-500 border-amber-400 text-black animate-pulse`
          : `${base} bg-slate-800/60 border-slate-700 text-rose-400 hover:bg-rose-900/30 hover:border-rose-700`
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          enabled ? 'bg-white animate-pulse' : confirming ? 'bg-black' : 'bg-rose-400'
        }`}
      />
      {enabled ? 'KILL ACTIVE' : confirming ? 'Confirm?' : 'KILL'}
    </button>
  );
}
