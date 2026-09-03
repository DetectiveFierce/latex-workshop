const counters = new Map<string, number>();
const observations = new Map<string, { count: number; sum: number }>();

function metricKey(name: string, labels: Record<string, string> = {}) {
  const suffix = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`)
    .join(',');
  return suffix ? `${name}{${suffix}}` : name;
}

export function incrementMetric(name: string, labels?: Record<string, string>) {
  const key = metricKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function observeMetric(name: string, value: number, labels?: Record<string, string>) {
  if (!Number.isFinite(value) || value < 0) return;
  const key = metricKey(name, labels);
  const current = observations.get(key) ?? { count: 0, sum: 0 };
  current.count += 1;
  current.sum += value;
  observations.set(key, current);
}

export function renderOperationalMetrics() {
  return [
    ...[...counters.entries()].map(([key, value]) => `${key} ${value}`),
    ...[...observations.entries()].flatMap(([key, value]) => [
      `${key}_count ${value.count}`,
      `${key}_sum ${value.sum}`,
    ]),
  ];
}
