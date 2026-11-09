import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

// Google is the only real sign-in method. The password provider exists so
// automated browser tests can log in (Google blocks automated browsers). It
// is only switched on when ENABLE_TEST_LOGIN is "true", which is set on the
// dev deployment and never on production.
const testLoginEnabled = process.env.ENABLE_TEST_LOGIN === "true";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, ...(testLoginEnabled ? [Password] : [])],
});
