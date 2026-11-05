import { Core, systemClock, counterIds, nodeFetch } from "@stewart/core";
import { runStdio } from "./server.js";

/** Node sidecar entry: the IDE starts this, speaks NDJSON JSON-RPC on stdio. */
runStdio(({ emit, store, projectStore }) =>
  new Core({
    fetcher: nodeFetch,
    clock: systemClock,
    ids: counterIds(),
    emitEvent: (ev) => emit(ev),
    defaults: {},
    userConfig: store,
    projectConfig: async () => projectStore,
  }),
);
