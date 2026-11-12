// Public surface of @stewart/setup. Only this file is importable from outside.
export { meetsHardRequirements, modelSizeB, scoreAssignments, proposeChain, ROLE_PROFILES, SCORE_WEIGHTS } from "./assign.js";
export type { Candidate, ScoredAssignment, Unfilled } from "./assign.js";
export { recommendAssignments } from "./recommend.js";
export type { RecommendChannelInfo, Assignment, RecommendOptions, RecommendResult, RecommendChannel } from "./recommend.js";
export { BENCH_VERSION, benchModel } from "./bench.js";
export { CONFORMANCE_VERSION, qualifyAgent, qualifyFunction, agentBlockReason } from "./conformance.js";
export type { QualifyDeps } from "./conformance.js";
export type { QualifyResult } from "./probeTypes.js";
export { scanWorkspace, gatherHardware, SCAN_FILE_CAP, SCAN_DEADLINE_MS } from "./setupContext.js";
export type { WorkspaceInfo, HardwareInfo, SetupContext } from "./setupContext.js";
export { SetupSession, SETUP_FILES } from "./session.js";
export type { SetupDraft, SetupEvent, SetupPhase, SetupSessionDeps, Evaluation } from "./session.js";
export type { DraftChannelInput, DraftChannelResult } from "./draftChannels.js";
export { SMOKE_TIMEOUT_MS, RANK_TIMEOUT_MS, PROBE_DRAIN_MS, MAX_SMOKE_ATTEMPTS, SetupProbeRunner, smokeModel, normalizeReason, orderSmokeCandidates, fallbackOrder, rankCandidates } from "./probe.js";
export type { ProbeCounts, ProbeItem, ProbeSnapshot, ProbeStatus, ProbeRunnerDeps, RankCandidate, SmokeCandidate, SmokeChannel, SmokeOptions, SmokeResult, SmokeState, SmokeVerdict } from "./probe.js";
