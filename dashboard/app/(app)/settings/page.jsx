'use client';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from '../../../lib/api.js';

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => apiGet('/settings') });
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    if (data) setText(JSON.stringify(data, null, 2));
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch) => apiPut('/settings', patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSavedAt(Date.now());
      setError('');
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  });

  const save = () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${e.message}`);
      return;
    }
    mutation.mutate(parsed);
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Settings</h1>
        <span className="text-xs text-slate-500">Edit JSON. Hot-reloads across the bot when saved.</span>
        <div className="ml-auto flex gap-2">
          {savedAt && <span className="text-xs text-emerald-400 self-center">Saved ✓</span>}
          <button
            onClick={save}
            disabled={mutation.isPending}
            className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-sm font-semibold rounded px-4 py-1.5"
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {error && <div className="text-rose-400 text-sm">{error}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="w-full h-[600px] bg-slate-950 border border-slate-800 rounded p-4 text-sm font-mono text-slate-200"
      />
    </div>
  );
}
