import { CommandBus } from "./CommandBus";
import { OperationQueue } from "./OperationQueue";
import { ClusterStore } from "../state/ClusterStore";

export interface ClusterControllerServices {
  commands: CommandBus;
  operations: OperationQueue;
  store: ClusterStore;
}

export class ClusterController {
  constructor(readonly services: ClusterControllerServices) {}

  diagnostics(): Record<string, unknown> {
    return {
      operations: this.services.operations.snapshot(50),
      store: this.services.store.getState(),
    };
  }
}
