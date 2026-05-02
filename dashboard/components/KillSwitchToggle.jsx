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

  return (
    <button
      onClick={onClick}
      className={`text-xs font-semibold px-3 py-1.5 rounded border transition-colors ${
        enabled
          ? 'bg-rose-600 border-rose-700 text-white'
          : confirming
          ? 'bg-amber-500 border-amber-600 text-black'
          : 'bg-slate-800 border-slate-700 text-rose-400 hover:bg-rose-900/30'
      }`}
    >
      {enabled ? '● KILL ACTIVE' : confirming ? 'Click to confirm' : 'KILL SWITCH'}
    </button>
  );
}
