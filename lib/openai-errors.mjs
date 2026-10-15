import { AppError } from "./errors.mjs";

export const OPENAI_ERROR_METADATA = Object.freeze({
  codes: ["rate_limit_exceeded", "slow_down", "insufficient_quota", "credit_balance_exhausted",
    "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"],
  types: ["rate_limit_error", "insufficient_quota"]
});

export function openAiFailure(error) {
  let code = "OPENAI_REQUEST_FAILED";
  let message = { 400: "OpenAI rejected the model or structured-output settings.",
    401: "OpenAI rejected the API key.",
    403: "OpenAI denied this request. Check this key's project permissions and model access.",
    404: "The model ID is unavailable to this OpenAI project." }[error.upstreamStatus]
    || "OpenAI is temporarily unavailable.";
  if (error.upstreamStatus === 429) {
    const billing = {
      credit_balance_exhausted: ["OPENAI_CREDIT_EXHAUSTED", "OpenAI reports that the organization linked to this API key has exhausted its prepaid API credit. Check that key's organization and billing balance."],
      organization_spend_limit_exceeded: ["OPENAI_ORGANIZATION_SPEND_LIMIT", "The organization linked to this API key has reached its enforced spending limit. Remaining credit does not override that limit."],
      project_spend_limit_exceeded: ["OPENAI_PROJECT_SPEND_LIMIT", "The project linked to this API key has reached its enforced spending limit. Remaining credit does not override that limit."],
      organization_usage_limit_exceeded: ["OPENAI_USAGE_LIMIT", "The organization linked to this API key has reached an OpenAI-assigned usage limit. Check its API limits; remaining credit does not override this cap."]
    }[error.upstreamCode];
    if (billing) [code, message] = billing;
    else if (error.upstreamCode === "insufficient_quota" || error.upstreamType === "insufficient_quota") {
      code = "OPENAI_QUOTA_LIMIT";
      message = "OpenAI reports an API billing or quota limit for this key. Check its organization, project and billing settings. This response alone does not establish that your credit balance is zero.";
    } else if (["rate_limit_exceeded", "slow_down"].includes(error.upstreamCode) || error.upstreamType === "rate_limit_error") {
      code = "OPENAI_RATE_LIMIT";
      const wait = Number.isFinite(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86400
        ? ` Wait at least ${Math.ceil(error.retryAfter)} seconds before trying again.` : " Wait before trying again.";
      message = "OpenAI temporarily limited the request rate or token rate. API credit pays for usage but does not remove these speed limits." + wait;
    } else {
      code = "OPENAI_UNCLASSIFIED_LIMIT";
      message = "OpenAI returned a usage-limit response without a recognized reason. It could be a temporary rate limit or a billing/usage cap; the response does not identify which.";
    }
  }
  return new AppError(code, message + " No automatic paid retry was made. Your local portfolio report is still available.", 502);
}
