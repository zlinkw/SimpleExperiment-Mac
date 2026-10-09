# State Model

`ClusterStoreState` contains:

- profiles and active profile
- servers
- GPU snapshots
- scheduler states
- experiment traces
- live outputs
- Agent runtime state
- operations
- diagnostics
- lastKnownGood

Reducer rules:

- old seq does not overwrite new seq
- terminal states are protected
- incomplete payloads do not clear existing state
- JSON read failure must not replace lastKnownGood

