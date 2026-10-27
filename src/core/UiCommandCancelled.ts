/**
 * The single UI-command cancellation type (task ui-plan-gpu-progress-20261024 r47).
 * Moved verbatim from legacy.ts so collaborator modules (e.g. CompletedJobSyncHost) can throw
 * the real production cancellation type that `isUiCommandCancelled` recognizes by instanceof —
 * no second lookalike error class, no widened name-based check.
 */
export class UiCommandCancelled extends Error {
    constructor(message = "用户取消操作。", readonly code = "USER_CANCELLED") {
        super(message);
        this.name = "UiCommandCancelled";
    }
}
