// Match the original API page contract, including its evaluation order.
{
  /**
   * The unchecked shape permits property reads without coercing input; the
   * individual fields remain unknown until the original checks validate them.
   * @param {unknown} data
   * @param {number} expectedPage
   * @param {number} expectedPageSize
   * A custom results.every can return any value; preserve the original result.
   * @returns {unknown}
   */
  function validateSearchResponse(data, expectedPage, expectedPageSize) {
    const input = /** @type {{results?: unknown, total?: unknown, page?: unknown, page_size?: unknown} | null | undefined} */ (data);
    if (!input || !Array.isArray(input.results) || !Number.isSafeInteger(input.total) || /** @type {number} */ (input.total) < 0
        || !Number.isInteger(input.page) || input.page !== expectedPage
        || !Number.isInteger(input.page_size) || input.page_size !== expectedPageSize) return false;
    const remaining = Math.max(0, /** @type {number} */ (input.total) - (expectedPage - 1) * expectedPageSize);
    return input.results.length === Math.min(expectedPageSize, remaining)
      && input.results.every(record => record && typeof record === "object" && !Array.isArray(record));
  }
  /** @type {typeof globalThis & {VoiceOfMLSearchValidation: typeof VoiceOfMLSearchValidation}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchValidation = {isValidSearchResponse: validateSearchResponse};
}
