declare global {
  namespace Cloudflare {
    interface Env {
      readonly ARCHITECT_PUBLIC_ORIGIN?: string;
      readonly ARCHITECT_DEFAULT_ROOM_TITLE?: string;
    }
  }
}

export {};
