// Actual imported production modules for partial Host method harnesses.
// No replacement scheduler, fabricated receipt or permissive safety gate.
require('./registerTsRequire');
module.exports = {
  GpuQuotaScheduling: require('../../src/features/GpuQuotaScheduling.ts'),
  GpuMemoryScheduling: require('../../src/features/GpuMemoryScheduling.ts'),
  GpuJobOwnership: require('../../src/features/GpuJobOwnership.ts'),
  DistributedSchedulingPolicy: require('../../src/features/DistributedSchedulingPolicy.ts'),
  PlanCodeScopeHost: require('../../src/extension/PlanCodeScopeHost.ts'),
  AgentTmuxPolicy_1: require('../../src/tunnel/AgentTmuxPolicy.ts'),
  PulledTaskControl: require('../../src/features/PulledTaskControl.ts'),
  PlanExecutionMode: require('../../src/features/PlanExecutionMode.ts'),
  NativeResultManifest_1: require('../../src/results/NativeResultManifest.ts'),
  vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
};
