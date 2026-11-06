import { Core, systemClock, counterIds, nodeFetch } from "@stewart/core";
import { runStdio } from "./server.js";
import { FileDebugSink } from "./debugSink.js";

/** Node sidecar entry: the IDE starts this, speaks NDJSON JSON-RPC on stdio. */
runStdio((ctx) =>
  new Core({
    fetcher: nodeFetch,
    clock: systemClock,
    ids: counterIds(),
    emitEvent: (ev) => ctx.emit(ev),
    defaults: {},
    userConfig: ctx.store,
    projectConfig: async () => ctx.projectStore,
    debugSinkFactory: ({ retainDays }) => new FileDebugSink({ dir: ctx.logDir, retainDays }),
  }),
);
