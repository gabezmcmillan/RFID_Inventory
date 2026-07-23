import { createAuthClient } from "better-auth/react";

type AuthClient = ReturnType<typeof createAuthClient>;

/**
 * The browser-side Better Auth client. It talks to this app's same-origin
 * `/api/auth/*` handler (mounted from the server instance in `lib/auth.ts`)
 * over fetch and stores reactive session state. Sign-in (Microsoft Entra ID)
 * and sign-out happen here, so the `Set-Cookie` response is applied directly
 * and no Next cookie plugin is needed — the `effectivly` house style.
 */
export const authClient: AuthClient = createAuthClient();
