// en · auth area (login, magic-link, OAuth callback). Filled by the auth pass.
export const auth = {
  // Hero / aside
  hero: {
    title: "A quiet machine,<br/>living inside the devices you already own.",
    lede: "Your account, conversations, and projects all live in the cloud.<br/>Tasks run on whichever of your machines happens to be online.",
  },

  // FormView eyebrows / titles / subs / CTAs
  form: {
    login: {
      eyebrow: "WELCOME",
      title: "Sign in to Cogni",
      sub: "One account, synced across every device",
      cta: "Sign in",
    },
    register: {
      eyebrow: "GET STARTED",
      title: "Sign up for Cogni",
      sub: "Create an account with your email and password",
      cta: "Sign up",
    },
    forgot: {
      eyebrow: "RESET",
      title: "Reset password",
      sub: "We'll send a reset link to your email",
      cta: "Send reset link",
    },
  },

  // Tabs
  tabLogin: "Sign in",
  tabRegister: "Sign up",

  // Buttons
  google: "Sign in with Google",
  orText: "OR",
  emailLabel: "Email",
  passwordLabel: "Password",
  emailPlaceholder: "you@somewhere.com",
  passwordPlaceholderRegister: "At least 8 characters",
  passwordPlaceholderLogin: "Your password",
  submitting: "Working…",
  sendingMagic: "Sending…",
  sendMagicLink: "Send sign-in link",

  // Alt links
  forgotPassword: "Forgot password?",
  backToLogin: "← Back to sign in",
  useMagicLink: "Use an email sign-in link instead",

  legal: "By signing in you agree to the Terms of Service and Privacy Policy. SP-1 is a development build.",

  // SentView
  sent: {
    magic: { eyebrow: "CHECK YOUR EMAIL", title: "Sign-in link sent" },
    register: { eyebrow: "CHECK YOUR EMAIL", title: "Confirmation email sent" },
    forgot: { eyebrow: "CHECK YOUR EMAIL", title: "Reset link sent" },
    body: "We sent the link to <0>{{email}}</0>.<1/>Open it on any device — it's valid for 30 minutes.",
    resendIn: "Resend in {{seconds}}s",
    resend: "Resend email",
    useOtherEmail: "Use a different email?",
  },

  // Client-side validation / error messages (Login.tsx + hooks)
  errors: {
    invalidEmail: "Please enter a valid email address",
    passwordTooShort: "Password must be at least 8 characters",
    network: "Network error, please try again",
    invalidCredentials: "Incorrect email or password",
    tooManyAttempts: "Too many attempts, please try again later",
  },

  // OAuth / magic / password callbacks (AuthCallback.tsx)
  callback: {
    signingIn: "Signing in…",
    confirming: "Confirming…",
    googleNoToken: "Sign-in failed: no token in URL",
    missingTokenParam: "Invalid link: missing token parameter",
    verifyFailed: "Confirmation failed: the link may have expired or already been used.",
    resetFailed: "Reset failed: the link may have expired or already been used.",
    backToLogin: "Back to sign in",
    signInFailed: "Sign-in failed: {{message}}",
    retry: "Please try again",
  },

  // Password reset form (AuthCallback.tsx)
  reset: {
    title: "Set a new password",
    newPasswordPlaceholder: "New password (at least 8 characters)",
    submit: "Set new password and sign in",
    submitting: "Working…",
  },
};
