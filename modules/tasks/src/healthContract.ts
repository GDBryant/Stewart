export const FINDING_EVIDENCE = ["verified", "unverified"] as const;
export const CHECK_STATUS = ["pass", "fail", "not run", "denied", "unavailable", "timeout"] as const;

export const HEALTH_REPORT_FORMAT = `{"files":[{"path":"src/a.ts","loc":0,"score":0,"band":"Green|Yellow|Red"}],"findings":[{"path":"src/a.ts","line":0,"smell":"...","severity":"high|med|low","refactor":"...","evidence":"verified|unverified","verification":"required when unverified"}],"notChecked":["src/b.ts"],"checks":[{"name":"...","command":"...","status":"${CHECK_STATUS.join("|")}","detail":"..."}]}`;

export function healthReportInstruction(scope?: string[]): string {
  if (!scope?.length)
    return `Project-checks report required. Detect and run the project's test or coverage command once. End the reply with exactly one \`\`\`json block matching ${HEALTH_REPORT_FORMAT}. files, findings and notChecked must be empty arrays; report only checks. Each check status is the observed tool outcome: pass, fail, not run, denied, unavailable or timeout; never infer an unavailable executable from a policy denial.`;
  return `Health report required. Declared scope (cover every entry exactly): ${scope.join(", ")}. End the reply with exactly one \`\`\`json block matching ${HEALTH_REPORT_FORMAT}. Paths are project-root-relative; omit files[].range entirely for a whole-file scope; a scope path:start-end needs files[].range "start-end". Mark each finding verified only when behavior was directly checked; use unverified for hypotheses or unavailable evidence and name the missing check in verification. Use denied, unavailable or timeout for checks instead of claiming a cause not observed.`;
}

export function healthRepairInstruction(errors: string): string {
  return `The previous health report failed validation: ${errors}. Rewrite the previous reply into the required health-report format, preserving the findings and check results already gathered. Do not use tools, re-read code, rerun checks, or change conclusions. Return only the corrected final answer ending with exactly one \`\`\`json block matching ${HEALTH_REPORT_FORMAT}.`;
}
