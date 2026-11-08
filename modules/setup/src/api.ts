// Public surface of @stewart/setup. Only this file is importable from outside.
export { meetsHardRequirements, modelSizeB, scoreAssignments, ROLE_PROFILES, SCORE_WEIGHTS } from "./assign.js";
export type { Candidate, ScoredAssignment, Unfilled } from "./assign.js";
export { recommendAssignments } from "./recommend.js";
export type { RecommendChannelInfo, Assignment, RecommendOptions, RecommendResult, RecommendChannel } from "./recommend.js";
export { BENCH_VERSION, benchModel } from "./bench.js";
export { scanWorkspace, gatherHardware, SCAN_FILE_CAP, SCAN_DEADLINE_MS } from "./setupContext.js";
export type { WorkspaceInfo, HardwareInfo, SetupContext } from "./setupContext.js";
export { SetupSession, SETUP_FILES } from "./session.js";
export type { SetupDraft, SetupEvent, SetupPhase, SetupSessionDeps, Evaluation } from "./session.js";
