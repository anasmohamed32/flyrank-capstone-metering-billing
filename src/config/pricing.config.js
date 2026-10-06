/**
 * Pinned Pricing Constants & Money Math Rules
 * Money is calculated and stored in integer micro-units (1 USD = 1,000,000 micros)
 * and cents (1 USD = 100 cents) to completely eliminate floating point rounding errors.
 */

const PRICING_CONFIG = {
  // AI Token Rates (USD per 1,000,000 tokens)
  AI_TOKENS: {
    // Standard un-cached input tokens: $2.50 per 1M tokens
    INPUT_PER_1M_USD: 2.50,
    INPUT_MICROS_PER_TOKEN: 2.5, // 2.5 micro-units per token ($0.0000025)

    // Cached input tokens (50% discount): $1.25 per 1M tokens
    CACHED_INPUT_PER_1M_USD: 1.25,
    CACHED_INPUT_MICROS_PER_TOKEN: 1.25, // 1.25 micro-units per token ($0.00000125)

    // Output tokens: $10.00 per 1M tokens
    OUTPUT_PER_1M_USD: 10.00,
    OUTPUT_MICROS_PER_TOKEN: 10.0, // 10.0 micro-units per token ($0.00001)

    // Reasoning tokens: count as output tokens ($10.00 per 1M tokens)
    REASONING_PER_1M_USD: 10.00,
    REASONING_MICROS_PER_TOKEN: 10.0 // 10.0 micro-units per token ($0.00001)
  },

  // API Call Rates
  API_CALLS: {
    // Default overage rate: $0.001 per extra API call = 1,000 micros
    OVERAGE_MICROS_PER_CALL: 1000
  },

  // Plan Definitions
  PLANS: {
    free: {
      id: 'free',
      name: 'Free Developer Plan',
      monthly_price_cents: 0,
      quota_api_calls: 1000,
      quota_ai_tokens: 100000
    },
    pro: {
      id: 'pro',
      name: 'Pro Scaling Plan',
      monthly_price_cents: 4900,
      quota_api_calls: 100000,
      quota_ai_tokens: 10000000
    },
    enterprise: {
      id: 'enterprise',
      name: 'Enterprise Dedicated Plan',
      monthly_price_cents: 29900,
      quota_api_calls: 1000000,
      quota_ai_tokens: 100000000
    }
  }
};

/**
 * Calculates exact AI token cost in integer micro-units
 * @param {object} params
 * @param {number} [params.inputTokens=0]
 * @param {number} [params.cachedInputTokens=0]
 * @param {number} [params.outputTokens=0]
 * @param {number} [params.reasoningTokens=0]
 * @returns {number} Integer cost in micro-units (1,000,000 micros = 1 USD)
 */
function calculateTokenCostMicros({
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0
}) {
  const inputCost = Math.round(inputTokens * PRICING_CONFIG.AI_TOKENS.INPUT_MICROS_PER_TOKEN);
  const cachedCost = Math.round(cachedInputTokens * PRICING_CONFIG.AI_TOKENS.CACHED_INPUT_MICROS_PER_TOKEN);
  const outputCost = Math.round(outputTokens * PRICING_CONFIG.AI_TOKENS.OUTPUT_MICROS_PER_TOKEN);
  const reasoningCost = Math.round(reasoningTokens * PRICING_CONFIG.AI_TOKENS.REASONING_MICROS_PER_TOKEN);

  return inputCost + cachedCost + outputCost + reasoningCost;
}

/**
 * Formats integer micro-units into exact USD string
 * @param {number} micros
 * @returns {string} e.g. "$0.025000"
 */
function microsToUsdString(micros) {
  return `$${(micros / 1000000).toFixed(6)}`;
}

/**
 * Formats integer cents into exact USD string
 * @param {number} cents
 * @returns {string} e.g. "$49.00"
 */
function centsToUsdString(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = {
  PRICING_CONFIG,
  calculateTokenCostMicros,
  microsToUsdString,
  centsToUsdString
};
