export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(0, "The local application service could not be reached.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    const fallback = response.status === 503
      ? "This feature needs a configured database or local service. You can continue with non-persisted workflows."
      : `Request failed (${response.status})`;
    throw new ApiError(response.status, body.error || fallback);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
