// zh · auth area (login, magic-link, OAuth callback). Filled by the auth pass.
export const auth = {
  // Hero / aside
  hero: {
    title: "一台安静的机器,<br/>住在你已有的设备里。",
    lede: "你的账号、对话、项目都在云端。<br/>任务跑在你哪台机器正巧在线。",
  },

  // FormView eyebrows / titles / subs / CTAs
  form: {
    login: {
      eyebrow: "WELCOME",
      title: "登录 Cogni",
      sub: "一个账号,所有设备同步",
      cta: "登录",
    },
    register: {
      eyebrow: "GET STARTED",
      title: "注册 Cogni",
      sub: "用邮箱和密码创建账号",
      cta: "注册",
    },
    forgot: {
      eyebrow: "RESET",
      title: "重置密码",
      sub: "我们会把重置链接发到你的邮箱",
      cta: "发送重置链接",
    },
  },

  // Tabs
  tabLogin: "登录",
  tabRegister: "注册",

  // Buttons
  google: "用 Google 登录",
  orText: "OR",
  emailLabel: "邮箱",
  passwordLabel: "密码",
  emailPlaceholder: "you@somewhere.com",
  passwordPlaceholderRegister: "至少 8 位",
  passwordPlaceholderLogin: "你的密码",
  submitting: "处理中…",
  sendingMagic: "发送中…",
  sendMagicLink: "发送登录链接",

  // Alt links
  forgotPassword: "忘记密码?",
  backToLogin: "← 返回登录",
  useMagicLink: "改用邮箱登录链接",

  legal: "登录即代表同意《服务条款》与《隐私政策》。SP-1 是开发版本。",

  // SentView
  sent: {
    magic: { eyebrow: "CHECK YOUR EMAIL", title: "登录链接已发送" },
    register: { eyebrow: "CHECK YOUR EMAIL", title: "确认邮件已发送" },
    forgot: { eyebrow: "CHECK YOUR EMAIL", title: "重置链接已发送" },
    body: "我们把链接发到了 <0>{{email}}</0>。<1/>在任意设备上点开都可以,30 分钟内有效。",
    resendIn: "{{seconds}}s 后可重发",
    resend: "重发邮件",
    useOtherEmail: "用其他邮箱?",
  },

  // Client-side validation / error messages (Login.tsx + hooks)
  errors: {
    invalidEmail: "请输入合法的邮箱地址",
    passwordTooShort: "密码至少 8 位",
    network: "网络错误,请重试",
    invalidCredentials: "邮箱或密码不正确",
    tooManyAttempts: "尝试过于频繁,请稍后再试",
  },

  // OAuth / magic / password callbacks (AuthCallback.tsx)
  callback: {
    signingIn: "正在登录…",
    confirming: "正在确认…",
    googleNoToken: "登录失败：URL 中没有 token",
    missingTokenParam: "链接无效：缺少 token 参数",
    verifyFailed: "确认失败：链接可能已过期或被使用过。",
    resetFailed: "重置失败：链接可能已过期或被使用过。",
    backToLogin: "返回登录",
    signInFailed: "登录失败：{{message}}",
    retry: "请重试",
  },

  // Password reset form (AuthCallback.tsx)
  reset: {
    title: "设置新密码",
    newPasswordPlaceholder: "新密码（至少 8 位）",
    submit: "设置新密码并登录",
    submitting: "处理中…",
  },
};
