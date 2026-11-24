// Rough cost tracking. Prices are USD per million tokens (Anthropic list
// prices as of Oct 2026). The real bill is at platform.claude.com.

export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  // Possible server-side fallback models
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

export function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

export function formatCost(cost) {
  if (cost == null) return "unknown";
  if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(2)}`;
}

const KEY = "spend";
const thisMonth = () => new Date().toISOString().slice(0, 7);

export async function recordUsage(cost) {
  if (cost == null) return;
  const month = thisMonth();
  const cur = (await chrome.storage.local.get(KEY))[KEY];
  const next =
    cur?.month === month
      ? { month, total: cur.total + cost, requests: cur.requests + 1 }
      : { month, total: cost, requests: 1 };
  await chrome.storage.local.set({ [KEY]: next });
}

export async function getSpend() {
  const cur = (await chrome.storage.local.get(KEY))[KEY];
  return cur?.month === thisMonth() ? cur : { month: thisMonth(), total: 0, requests: 0 };
}
