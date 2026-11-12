/** Shipped default skills. Bodies are injected into role system prompts (bounded). */
export interface ShippedSkill {
  id: string;
  description: string;
  version: number;
  body: string;
}

export const DEFAULT_SKILLS: ShippedSkill[] = [
  {
    id: "spec-first",
    description: "Pin down the contract before planning implementation.",
    version: 1,
    body: `Before planning implementation, pin down the contract: inputs, outputs, error behaviour, and what the caller sees. If the request is ambiguous on the contract, list the interpretations and ask. A plan built on a guessed contract is waste.`,
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
    version: 2,
    body: `Score the health of existing code (not a diff's correctness). Approximates CodeScene Code Health; a heuristic, say so once.
Scope: resolve from the request — file(s) via ReadFile; folder via FindFiles (max 20 files, skip node_modules/dist/generated; state what was skipped); file + lines via ReadFile start_line/end_line; function via Search then ReadFile; a pasted code block as given. State the resolved scope. When the briefing lists files, score every listed file — the max-20 cap applies only to folders you resolve yourself; if told to Report via submit_health, submit the structured report instead of text.
Measure first: call CodeMetrics on the files (or folder) in scope; cite its numbers as evidence for complexity, size, nesting and suppression findings; a lexical approximation — confirm with ReadFile if a number looks wrong; still read for cohesion, duplication, dead code. Scores remain your judgement.
Mode: "score" if asked for score only; otherwise "issues" (score + findings).
Scoring: each unit starts at 10.0; deduct per finding (high -2.0, med -1.0, low -0.3; max -4.0 per category); clamp 1.0-10.0. Bands: Green >=9.5, Yellow 7.0-9.4, Red <7.0. Folder: LOC-weighted mean, plus worst file and Red-file count. Lines/function/block: label "unit score, not file health".
Smells (with path:line evidence): high complexity (>10 med, >15 high branches), large functions (>60 / >120 lines) and files (>500 / >1000), deep nesting (4 / >=5), low cohesion, duplicated logic, closure-captured mutable state (>4 / >7 vars), dead code, suppressions or skipped/weakened tests, cross-package coupling. Coverage only if a report is readable; hotspots/history not checked.
Project checks task (briefing says 'Project checks'): do not score files. Detect the test/coverage command from build files (package.json, Makefile, build.gradle(.kts), pom.xml, pyproject.toml, Cargo.toml, go.mod, *.sln); prefer coverage; run it once with RunTerminal; submit_health with files [] and checks [{name, command, status, detail}]; detail = pass/fail + coverage % if printed; none found, denied or timed out → 'not run' with the reason. RunTerminal only inside a Project checks task; never install dependencies or modify files.
Output: line 1 "Scope · Mode · Checked · Not checked". Score: "<unit> — <n>/10 (<band>)". Issues: one per line "path:line | smell | high/med/low | refactor", most severe first; name a refactoring (extract function, guard clauses, split file) when one fits. Judge only what you opened; snippets cannot show coupling or cross-file duplication. Do not edit files. If healthy, say so.`,
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
