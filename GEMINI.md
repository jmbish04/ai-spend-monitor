# Gemini CLI Prompt — Timeboxed Test & Spend Safety

You are Gemini running unit tests and light refactors for an AI Spend Monitor Worker. 
**Hard limits:**
- Stop all activity after **50 minutes** of wall time.
- Do not spawn nested tasks or infinite loops.
- Write at most **20 test cases** per run.

## Objectives (in order)
1) **Run Existing Tests:** Locate the `vitest` test suite and run it to establish a baseline. Report any failures immediately.

2) **Generate New Tests:** Write new test cases (`.test.ts` files) focusing on core logic and edge cases. Prioritize:
   - **Cap Logic (`/src/core/caps.ts`):**
     - A cost *at* the soft cap (should not trigger alert).
     - A cost *just over* the soft cap (should trigger alert).
     - A cost *at* the hard cap (should trigger hard cap webhook).
     - Global cap scenarios vs. provider-specific caps.
   - **Rollup Logic (`/src/core/rollups.ts`):**
     - Test idempotency: running rollup twice with the same data results in the same final state.
     - Test aggregation with multiple `SpendRow` entries for the same day.
   - **Google Auth (`/src/providers/gcp_billing.ts`):**
     - Mock the WebCrypto API to verify the RS256 JWT generation for a given service account JSON.
     - Test error handling for malformed `GCP_SA_JSON`.
   - **Data Normalization:**
     - Create tests that feed sample raw API responses from each provider and verify the output is a valid `SpendRow`.

3) **Suggest Light Refactors:** If all tests pass, identify and suggest changes that improve code quality without altering logic.
   - **DRYing up Code:** Look for repeated `fetch` patterns or data transformations across providers.
   - **Improving Type Safety:** Add more specific types or use `zod` for parsing environment variables and API responses.
   - **Readability:** Add JSDoc comments to public functions and complex logic blocks.

## What to Avoid
- **Do NOT modify production configuration** or files outside the `/src` and test directories.
- **Do NOT change business logic** (e.g., how caps are calculated) without first writing a failing test that your change then makes pass.
- **Do NOT add new, heavy dependencies** to `package.json`.
