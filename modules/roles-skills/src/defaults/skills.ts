/** Shipped default skills. Bodies are injected into role system prompts (bounded). */
export interface ShippedSkill {
  id: string;
  description: string;
  version: number;
  body: string;
}

export const DEFAULT_SKILLS: ShippedSkill[] = [
  {
    id: "orchestrate",
    description: "Route work to roles; the orchestrator never does specialist work itself.",
    version: 1,
    body: `You route work. Read the request, decide which roles are needed, and dispatch each unit to the right role with a complete, self-contained briefing. Never write code, edit files, or investigate deeply yourself — that is what the roles are for. Gather each role's structured result, then answer the user in plain language. If a needed role is disabled or unassigned, ask the user rather than doing the work.`,
  },
  {
    id: "delegate-briefing",
    description: "Write self-contained task briefings for dispatched roles.",
    version: 1,
    body: `Each dispatch briefing must stand alone: the receiving role starts with a fresh context. Include the goal, the exact files or areas involved, constraints, and what a good result looks like. Do not assume the role saw the user's original message. Keep it short: goal, context, expected output.`,
  },
  {
    id: "ask-user",
    description: "Ask the user when blocked instead of guessing.",
    version: 1,
    body: `When a decision affects the outcome and the answer is not derivable from the codebase, ask the user via ask_user. Offer concrete options. Never block on a question you could answer by reading code. One question per real decision; batch related decisions into one call.`,
  },
  {
    id: "plan-breakdown",
    description: "Split a goal into ordered milestones with acceptance criteria.",
    version: 1,
    body: `Break the goal into ordered milestones. Each milestone: a title, the concrete changes it contains, the files it touches, and acceptance criteria that can be checked objectively. Order by dependency: nothing may require a later milestone. Prefer small, independently verifiable milestones over big ones.`,
  },
  {
    id: "spec-first",
    description: "Pin down the contract before planning implementation.",
    version: 1,
    body: `Before planning implementation, pin down the contract: inputs, outputs, error behaviour, and what the caller sees. If the request is ambiguous on the contract, list the interpretations and ask. A plan built on a guessed contract is waste.`,
  },
  {
    id: "plan-validate",
    description: "Adversarial check of a plan against code and request.",
    version: 1,
    body: `Check the plan against the actual code and the actual request, not against the planner's description of them. Verify named files exist, named symbols exist, and the approach fits how the codebase already works. Flag missing milestones, ordering violations, and steps that cannot produce their stated output. Approve only when you have checked, not when it looks plausible.`,
  },
  {
    id: "doubt-review",
    description: "Cross-examine assumptions before accepting an output.",
    version: 1,
    body: `List the assumptions the work rests on. For each, state what breaks if it is wrong and how you checked it. Prefer concrete verification (read the file, run the command) over reasoning. Deliver a verdict with reasons, not a vibe.`,
  },
  {
    id: "investigate-first",
    description: "Locate code and trace causes before proposing changes.",
    version: 1,
    body: `Locate before you opine. Find the real code paths, trace the actual flow, and cite path:line for every finding. Distinguish what you verified from what you inferred. Report findings, not fixes.`,
  },
  {
    id: "code-search",
    description: "Search the codebase systematically: definitions, references, patterns.",
    version: 1,
    body: `Search in widening rings: exact symbol, then likely file names, then distinctive string literals, then structural patterns. Cross-check: a symbol found in one place usually has references elsewhere — follow at least one hop before concluding. Report path:line citations.`,
  },
  {
    id: "evidence-report",
    description: "Return findings as path:line evidence, not prose claims.",
    version: 1,
    body: `Every claim in the report carries evidence: a path:line citation, a command output, or a test result. No unverified claims. Structure: finding → evidence → confidence.`,
  },
  {
    id: "architecture-design",
    description: "Design module boundaries, interfaces and data shapes.",
    version: 1,
    body: `Design at the boundary: module responsibilities, public interfaces, data shapes, and failure modes. Follow the codebase's existing conventions unless there is a concrete reason not to. Write the design as a short note: decision, rationale, alternatives considered.`,
  },
  {
    id: "api-design",
    description: "Stable API and interface contracts.",
    version: 1,
    body: `Interfaces are contracts: name things after the caller's intent, keep the surface minimal, version what can change. Define error and edge behaviour in the contract, not as an afterthought. Prefer a small stable surface over a convenient one.`,
  },
  {
    id: "adr",
    description: "Architecture decision records: context, decision, consequences.",
    version: 1,
    body: `Record decisions as ADRs: context (what forces a decision), the decision itself, alternatives considered and why they lost, consequences (good and bad). One decision per record. Write for a reader who was not in the room.`,
  },
  {
    id: "execution-contract",
    description: "Tool-call discipline: validate, preview, approve, execute; never replay.",
    version: 1,
    body: `Tool calls are data, not actions: emit them in the exact format, let the runtime validate and preview them, and never repeat a call to "retry" — the runtime executes each call exactly once. Do not narrate fake results; wait for the tool outcome. If a call is rejected, stop and reconsider rather than issuing the same call again.`,
  },
  {
    id: "verify-and-stop",
    description: "Verify the result, then stop; no speculative extras.",
    version: 1,
    body: `Done means verified: run the test, read the written file, or cite the evidence that the task's acceptance criterion holds. Then stop. Do not refactor adjacent code, add unrequested features, or keep polishing.`,
  },
  {
    id: "tdd",
    description: "Failing test first, minimal fix, then verify.",
    version: 1,
    body: `Write the failing test that shows the behaviour, then make it pass with the smallest change, then run the relevant tests. New code gets tests for positive and negative cases in the same change. No test, no claim of done.`,
  },
  {
    id: "surgical-patch",
    description: "Minimal diffs anchored to surrounding code.",
    version: 1,
    body: `Edit surgically: the smallest diff that achieves the change, anchored to surrounding context. No drive-by reformatting, no renaming for taste, no rewriting what works. Match the file's existing style.`,
  },
  {
    id: "tool-call-format",
    description: "Emit tool calls exactly in the channel's format.",
    version: 1,
    body: `Emit tool calls exactly in the format the channel expects — one call per block, arguments as valid JSON matching the tool's schema. Include every required argument. Malformed calls are rejected without execution.`,
  },
  {
    id: "code-review",
    description: "One finding per line: location, problem, fix.",
    version: 1,
    body: `Review as findings, not narrative: one line each — location, problem, suggested fix. Order by severity. Judge correctness, safety and fit with conventions; do not restyle. If clean, say so plainly.`,
  },
  {
    id: "security-review",
    description: "Spot injection, secret, and trust-boundary issues.",
    version: 1,
    body: `Check the trust boundaries: input validation, path escapes, secret handling, injection into commands or queries, and anything crossing a permission boundary. Report concrete exploits, not theoretical hygiene.`,
  },
  {
    id: "code-health",
    description: "Score code health (0-10) and list maintainability issues for files, a folder, lines, a function or a code block.",
    version: 1,
    body: `Score the health of existing code (not a diff's correctness). Approximates CodeScene Code Health; it is a heuristic, say so once.
Scope: resolve from the request — file(s) via ReadFile; folder via FindFiles (max 20 files, skip node_modules/dist/generated; state what was skipped); file + lines via ReadFile start_line/end_line; function via Search then ReadFile; a pasted code block as given. State the resolved scope.
Mode: "score" if asked for score only; otherwise "issues" (score + findings).
Scoring: each unit starts at 10.0; deduct per finding (high -2.0, med -1.0, low -0.3; max -4.0 per category); clamp 1.0-10.0. Bands: Green >=9.5, Yellow 7.0-9.4, Red <7.0. Folder: LOC-weighted mean, plus worst file and Red-file count. Lines/function/block: label "unit score, not file health".
Smells (with path:line evidence): high complexity (>10 med, >15 high branches), large functions (>60 / >120 lines) and files (>500 / >1000), deep nesting (4 / >=5), low cohesion, duplicated logic, closure-captured mutable state (>4 / >7 vars), dead code, suppressions or skipped/weakened tests, cross-package coupling. Coverage only if a report is readable; hotspots/history not checked.
Output: line 1 "Scope · Mode · Checked · Not checked". Score: "<unit> — <n>/10 (<band>)". Issues: one per line "path:line | smell | high/med/low | refactor", most severe first; name a docs/building/REFACTORING.md strategy when one fits. Judge only what you opened; snippets cannot show coupling or cross-file duplication. Do not edit files. If healthy, say so.`,
  },
  {
    id: "docs-writing",
    description: "Concise docs: commands, terms, paths.",
    version: 1,
    body: `Write docs that answer the reader's next question: exact commands, real file paths, concrete terms. Short sections, no throat-clearing, no marketing voice. Keep excerpts minimal.`,
  },
  {
    id: "brief-style",
    description: "Terse output: result, reason, next step.",
    version: 1,
    body: `Be brief. State result, reason, next step. No preamble, no restating the request, no unrequested alternatives.`,
  },
  {
    id: "image-describe",
    description: "Describe images for text-only consumers.",
    version: 1,
    body: `Describe the image precisely enough that a text-only role can act on it: layout, text content, colors where they carry meaning, and the elements that matter for the task. Omit decoration.`,
  },
  {
    id: "image-generate",
    description: "Generate images via the image API or diagram-as-code fallback.",
    version: 1,
    body: `Generate the requested image with the image tool. Specify subject, style, and constraints concretely in the prompt. Save output under the assets path. If the channel cannot generate images, produce the equivalent as Mermaid or SVG.`,
  },
  {
    id: "diagram-as-code",
    description: "Mermaid/SVG diagrams when image generation is unavailable.",
    version: 1,
    body: `Produce the diagram as code: Mermaid for structure and flows, SVG for precise graphics. Keep diagrams legible — few nodes, clear labels, one idea per diagram.`,
  },
];

/** Skill id force-applied to roles that hold write/command tools. */
export const EXECUTION_CONTRACT = "execution-contract";

/** Tool names that count as write/command tools for execution-contract injection. */
export const SIDE_EFFECT_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "RunTerminal"]);
