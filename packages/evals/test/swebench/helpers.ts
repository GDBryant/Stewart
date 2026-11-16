import type { SweResult } from "../../src/swebench/run.js";

export const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  instance_id: "django__django-11099",
  repo: "django/django",
  base_commit: "d26b2424437dabeeca94d7900b37d2df4410da0c",
  problem_statement: "UsernameValidator allows trailing newline in usernames",
  patch: "diff --git a/a b/a\n",
  FAIL_TO_PASS: ["test_ascii_validator (auth_tests.test_validators.UsernameValidatorsTests)"],
  PASS_TO_PASS: ["test_help_text (auth_tests.test_validators.MinimumLengthValidatorTest)"],
  image: "swebench/sweb.eval.x86_64.django_1776_django-11099:latest",
  eval_script: "#!/bin/bash\n: '>>>>> Start Test Output'\n./tests/runtests.py\n: '>>>>> End Test Output'\n",
  log_parser: "parse_log_django",
  difficulty: "<15 min fix",
  ...over,
});

export const result = (over: Partial<SweResult> = {}): SweResult => ({
  id: "django__django-1",
  repo: "django/django",
  status: "resolved",
  reason: "all FAIL_TO_PASS and PASS_TO_PASS tests pass",
  f2p: { passed: 1, total: 1 },
  p2p: { passed: 7, total: 7 },
  failed: [],
  patch: "diff --git a/f b/f\n",
  durationMs: 12_000,
  costUsd: 0.12345,
  ...over,
});
