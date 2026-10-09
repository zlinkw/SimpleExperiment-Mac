export function fakeServer(id: string, role = "gpu_worker") {
  return {
    id,
    name: id.toUpperCase(),
    host: id,
    role,
    loginStatus: "ok",
    remoteWorkspaceDir: "/srv",
    condaEnv: "simple",
    gpuCount: 1,
    maxGpus: 1,
    tags: [],
  };
}

export function fakeExperiment(overrides: Record<string, any> = {}) {
  return {
    global_job_id: "g1",
    run_id: "1_case",
    suite: "demo",
    case: "case",
    seed: "1",
    hub_job_dir: "work_dirs/multirun/demo/1_case",
    worker_id: "w1",
    worker_host: "w1",
    worker_job_dir: "/srv/project/work_dirs/multirun/demo/1_case",
    synced_at: new Date(0).toISOString(),
    ...overrides,
  };
}