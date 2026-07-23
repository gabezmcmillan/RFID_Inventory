import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

/**
 * Better Auth's catch-all handler, mounted at `/api/auth/*`. The instance comes
 * from the shared server config in `lib/auth.ts`; in offline mode (no
 * `AUTH_DATABASE_URL` + `AUTH_SECRET`) there is no backend, so both verbs
 * report 404 rather than crashing — the same offline gate the rest of the stack
 * uses (`effectivly` house style).
 */
const disabled = (): Response =>
  new Response("Authentication is disabled (no AUTH_DATABASE_URL + AUTH_SECRET).", {
    status: 404,
  });

const handle = async (method: "GET" | "POST", request: Request): Promise<Response> => {
  const auth = getAuth();
  if (auth === null) {
    return disabled();
  }
  return toNextJsHandler(auth)[method](request);
};

export const GET = (request: Request): Promise<Response> => handle("GET", request);
export const POST = (request: Request): Promise<Response> => handle("POST", request);
