import { CommandBus } from "../core/CommandBus";

export class SchedulerService {
  constructor(readonly commands: CommandBus) {}
}

