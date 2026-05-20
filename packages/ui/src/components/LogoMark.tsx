export function LogoMark({
  className,
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="5" width="54" height="54" rx="16" fill="#ffffff" />
      <rect x="5" y="5" width="54" height="54" rx="16" fill="none" stroke="#ddd8d2" strokeWidth="1.4" />
      <path
        d="M21.3 45.1C13.4 40.9 10.4 31.6 14.5 24.1C19.2 15.6 30.4 12.9 39.5 18.6C48.3 24.1 52 35.1 46 42.3C40.4 49 28.9 49 21.3 45.1Z"
        fill="none"
        stroke="#2c241f"
        strokeWidth="7.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="39.8" cy="35.7" r="5.4" fill="#5f9877" />
    </svg>
  );
}
