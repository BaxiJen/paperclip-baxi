import { cn } from "../lib/utils";

export function KiroLogoIcon({ className }: { className?: string }) {
  return (
    <img
      src="/brands/adapters/kiro-color.svg"
      alt="Kiro"
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
