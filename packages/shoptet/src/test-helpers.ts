// Test-only helpers. Not exported from the package entry point.

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

export const FAKE_TOKEN = "test-token-not-real-000000";
export const BASE_URL = "https://api.shop.example";
