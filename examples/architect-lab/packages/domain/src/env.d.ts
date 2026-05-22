declare global {
  namespace Cloudflare {
    interface Env {
      readonly ARCHITECT_PUBLIC_ORIGIN?: string;
      readonly ARCHITECT_DEFAULT_ROOM_TITLE?: string;
      readonly ARCHITECT_FAKE_AI_STREAM_DELAY_MS?: number;
      readonly ARCHITECT_AI_PROVIDER?: string;
      readonly ARCHITECT_AI_PROVIDER_BASE_URL?: string;
      readonly ARCHITECT_AI_PROVIDER_API_KEY?: string;
      readonly ARCHITECT_AI_MODEL?: string;
      readonly ARCHITECT_AI_TIMEOUT_MS?: number;
      readonly ARCHITECT_AI_RETRY_ATTEMPTS?: number;
      readonly ARCHITECT_AI_MAX_TOOL_CALLS?: number;
      readonly ARCHITECT_AI_MAX_OUTPUT_TOKENS?: number;
      readonly ARCHITECT_AI_MAX_ESTIMATED_COST_CENTS?: number;
      readonly ARCHITECT_EXPORTS_DB?: D1Database;
      readonly ARCHITECT_EXPORTS?: R2Bucket;
      readonly ARCHITECT_EXPORT_WORKFLOW?: globalThis.Workflow<unknown>;
    }
  }
}

export {};
