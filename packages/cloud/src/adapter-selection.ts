import { DEFAULT_RUNNER_ADAPTER_ID, RUNNER_ADAPTER_IDS, type RunnerAdapterId } from "@cogni/contract";

export interface AdapterSelectableHost {
  adapters?: readonly string[];
  defaultAdapter?: string | null;
}

function isRunnerAdapterId(value: string | null | undefined): value is RunnerAdapterId {
  return value != null && (RUNNER_ADAPTER_IDS as readonly string[]).includes(value);
}

export function selectHostDefaultAdapter(host: AdapterSelectableHost): RunnerAdapterId {
  const adapters = host.adapters ?? [];
  const configured = host.defaultAdapter;
  if (isRunnerAdapterId(configured) && (adapters.length === 0 || adapters.includes(configured))) {
    return configured;
  }
  if (adapters.includes(DEFAULT_RUNNER_ADAPTER_ID)) return DEFAULT_RUNNER_ADAPTER_ID;
  const firstKnown = adapters.find((adapter) => isRunnerAdapterId(adapter));
  return firstKnown ?? DEFAULT_RUNNER_ADAPTER_ID;
}
