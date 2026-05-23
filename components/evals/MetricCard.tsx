export type MetricCardProps = {
  label: string;
  value: number;         // 0-1
};

export function MetricCard({ label, value }: MetricCardProps) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 75 ? "text-green-600 bg-green-50" :
    pct >= 50 ? "text-yellow-700 bg-yellow-50" :
    "text-red-700 bg-red-50";
  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {pct}%
      </div>
    </div>
  );
}
