import { hasFreshDurableSnapshot, jobHasLiveExecution } from "./DistributedPlanQueue";
import { observationMatches } from "./TaskLifecycle";

/** A current, exact execution observation wakes local scheduling before result checks finish. */
export function ownExecutionExited(previous: any, snapshot: any, queue: any, projectId: string) {
  if (!hasFreshDurableSnapshot(snapshot) || snapshot.queryComplete !== true || snapshot.executionQueryError) return false;
  const jobs = (queue?.plans || []).flatMap((plan: any) => plan.projectId === projectId ? plan.jobs || [] : []);
  if (!jobs.some((job: any) => job.status === "pending" && !job.workerId && !job.commandId && !job.manualDispatch && !job.stopIntent)) return false;
  return (snapshot.tasks || []).some((task: any) => {
    const job = jobs.find((job: any) => job.commandId === task.commandId && job.workerId === snapshot.workerId);
    const observation = task.observation;
    if (!job || !observation || !observationMatches(observation, { commandId: job.commandId, workerId: job.workerId, projectId })
      || observation.queryError || observation.executionQueryError || observation.tmux?.dead !== true) return false;
    const before = previous?.tasks?.find((row: any) => row.commandId === job.commandId && row.projectId === projectId);
    return before ? before.observation?.tmux?.dead !== true : jobHasLiveExecution(job);
  });
}
