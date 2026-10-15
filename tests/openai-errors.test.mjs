import test from "node:test";
import assert from "node:assert/strict";
import { openAiFailure } from "../lib/openai-errors.mjs";

test("specific billing limits remain distinct even with a broad quota error type", () => {
  for (const [upstreamCode, code, text] of [
    ["credit_balance_exhausted", "OPENAI_CREDIT_EXHAUSTED", /exhausted its prepaid/],
    ["project_spend_limit_exceeded", "OPENAI_PROJECT_SPEND_LIMIT", /project.*spending limit/],
    ["organization_spend_limit_exceeded", "OPENAI_ORGANIZATION_SPEND_LIMIT", /organization.*spending limit/],
    ["organization_usage_limit_exceeded", "OPENAI_USAGE_LIMIT", /OpenAI-assigned usage limit/],
    ["insufficient_quota", "OPENAI_QUOTA_LIMIT", /does not establish.*zero/]
  ]) {
    const e = openAiFailure({ upstreamStatus: 429, upstreamCode, upstreamType: "insufficient_quota", retryAfter: 5 });
    assert.equal(e.code, code);
    assert.match(e.message, text);
    assert.match(e.message, /No automatic paid retry/);
    assert.doesNotMatch(e.message, /Wait at least/);
  }
});

test("temporary speed limits respect Retry-After without claiming credit is exhausted", () => {
  for (const upstreamCode of ["rate_limit_exceeded", "slow_down", undefined]) {
    const e = openAiFailure({ upstreamStatus: 429, upstreamCode, upstreamType: "rate_limit_error", retryAfter: 12.2 });
    assert.equal(e.code, "OPENAI_RATE_LIMIT");
    assert.match(e.message, /Wait at least 13 seconds/);
    assert.doesNotMatch(e.message, /exhausted|buy.*credit/i);
  }
  for (const retryAfter of [-1, Infinity, NaN, 1e10]) {
    assert.doesNotMatch(openAiFailure({ upstreamStatus: 429, upstreamCode: "slow_down", retryAfter }).message, /Wait at least/);
  }
});

test("unknown usage limits stay unknown and provider text is never displayed", () => {
  const e = openAiFailure({ upstreamStatus: 429, message: "PRIVATE KEY", upstreamCode: "PRIVATE ACCOUNT" });
  assert.equal(e.code, "OPENAI_UNCLASSIFIED_LIMIT");
  assert.match(e.message, /does not identify which/);
  assert.doesNotMatch(e.message, /PRIVATE/);
  assert.match(openAiFailure({ upstreamStatus: 401 }).message, /rejected the API key/);
  assert.match(openAiFailure({ upstreamStatus: 503 }).message, /temporarily unavailable/);
});
