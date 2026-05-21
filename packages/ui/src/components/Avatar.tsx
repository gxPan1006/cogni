import "./avatar.css";

/**
 * User avatar: renders the uploaded image when present, else a colored circle
 * with the name's first letter. One place for the fallback so the sidebar
 * footer and the Account page stay in sync.
 *
 * `size` is the diameter in px (sidebar uses 26, Account uses 32+). The letter
 * scales to ~half the diameter.
 */
export function Avatar({ name, avatar, size = 26, className }: {
  name: string;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  const cls = "avatar" + (className ? " " + className : "");
  if (avatar) {
    return <img className={cls} src={avatar} alt={name} width={size} height={size} style={{ width: size, height: size }} />;
  }
  const initial = (name.slice(0, 1) || "?").toUpperCase();
  return (
    <span className={cls} style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {initial}
    </span>
  );
}
