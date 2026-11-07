# @stewart/scheduling

- Purpose: Task graph and path leases with deadlock detection
- Surface: `src/api.ts`
- Owns: `tasks.ts` (`TaskGraph`, `TaskSpec`/`TaskRecord`, ready/blocked/persist), `leases.ts` (`LeaseManager`, wait-for graph, cycle victim)
- Depends on: — (leaf) (lower layers only; `scripts/layers.json`)
- Fake it: Pure; construct directly
