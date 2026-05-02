export default function StatCard({ label, value, sub, color = 'sky' }) {
  const colorMap = {
    sky: 'text-sky-400',
    emerald: 'text-emerald-400',
    rose: 'text-rose-400',
    amber: 'text-amber-400',
    slate: 'text-slate-300',
  };
  return (
    <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${colorMap[color] || colorMap.sky}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}
