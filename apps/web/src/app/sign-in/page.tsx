import { redirect } from "next/navigation";

import { isAuthEnabled, isMicrosoftEnabled } from "@/lib/auth";
import { AuthForm } from "./AuthForm";

/** Sign-in page. When the auth backend is offline there is nothing to sign in
 * to, so redirect home (the dev bypass, when active, serves a fake user there). */
export default async function SignInPage() {
  if (!isAuthEnabled()) {
    redirect("/");
  }
  return <AuthForm microsoftEnabled={isMicrosoftEnabled()} />;
}
