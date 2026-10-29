// Actual imported production modules for partial Host method harnesses.
// No replacement scheduler, fabricated receipt or permissive safety gate.
require('./registerTsRequire');
module.exports = {
  GpuQuotaScheduling: require('../../src/features/GpuQuotaScheduling.ts'),
  GpuMemoryBudget: require('../../src/features/GpuMemoryBudget.ts'),
  GpuMemoryScheduling: require('../../src/features/GpuMemoryScheduling.ts'),
  GpuJobOwnership: require('../../src/features/GpuJobOwnership.ts'),
  DistributedSchedulingPolicy: require('../../src/features/DistributedSchedulingPolicy.ts'),
  PlanCodeScopeHost: require('../../src/extension/PlanCodeScopeHost.ts'),
  AgentTmuxPolicy_1: require('../../src/tunnel/AgentTmuxPolicy.ts'),
  PulledTaskControl: require('../../src/features/PulledTaskControl.ts'),
  PlanExecutionMode: require('../../src/features/PlanExecutionMode.ts'),
  NativeResultManifest_1: require('../../src/results/NativeResultManifest.ts'),
  // 0.5.416 配套：syncDistributedJobArtifacts/failJob 编译形态引用模块命名空间绑定
  // （artifactStageBlockFromError/jobArtifactRunGeneration/syncScopeStagingIdentity 同模块），
  // 所有以编译切片方式提取该方法的夹具共享同一真实生产模块，不造假替身。
  JobArtifactSyncIdentity_1: require('../../src/features/JobArtifactSyncIdentity.ts'),
  // 0.5.419 配套：交接门/tick 阶段账本与写租约由真实模块提供；摘出类成员的宿主
  // 一旦经过派发或 tick 路径就会引用该命名空间，必须共享同一真实模块，不做假替身。
  DispatchHandoffGate: require('../../src/features/DispatchHandoffGate.ts'),
  vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
};
