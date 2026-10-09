# SSH Transport

Transport priority:

- `controlmaster`: preferred for repeated commands, uses OpenSSH multiplexing.
- `persistent_shell`: fallback for background/realtime when ControlMaster is unavailable.
- `oneshot`: allowed for manual/heavy operations, suppressed by default for realtime/background.
- `hub_agent`: status read path. Worker state should come from Hub Agent stream/snapshot, not direct worker fanout.

Realtime refresh should not create high-frequency oneshot SSH connections. Manual refresh may use direct fallback.

Diagnostics expose transport, command counts, suppress counts, last error, retry time, and Agent stream state.

