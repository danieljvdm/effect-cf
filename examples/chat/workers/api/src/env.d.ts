declare global {
  namespace Cloudflare {
    interface Env {
      readonly DEFAULT_USER_ID?: string;
      readonly CHAT_DEMO_SECRET?: string;
    }
  }
}

export {};
