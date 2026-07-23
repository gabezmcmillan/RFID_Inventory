import { redirect } from "next/navigation";

/**
 * Stale `/login` redirect — no app route lives here. The app's sign-in route is
 * `/sign-in` (see `proxy.ts` and `src/app/sign-in`); no code in this repo
 * redirects to `/login`. The repeated `GET /login 404` in the dev logs comes
 * from an external client with a stale URL (e.g. a parked browser tab or an
 * Entra app-registration logout/bookmark URL) that we cannot reconfigure from
 * here, so this minimal route redirects that traffic to the real sign-in page
 * instead of 404-ing. The unauthenticated case is also handled by `proxy.ts`
 * (which redirects to `/sign-in`); this route covers the authenticated case the
 * proxy passes through.
 */
export default function LoginPage() {
  redirect("/sign-in");
}
