import type { SVGProps } from "react";
import { BRAND_NAME, UPSTREAM_URL } from "../lib/brand";
import { cn } from "../lib/utils";

/** Original BXat monogram. Color comes from the active theme. */
export function BaXiJenMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 129 129" fill="none" aria-hidden="true" {...props}>
<path fillRule="evenodd" clipRule="evenodd" d="M68.9941 72.6555V114.759L81.8693 107.126V78.9228L87.5376 74.6643L93.1249 78.9228V100.537L105.919 93.1448V72.5752L93.7727 62.9332L106 53.2108V35.6945L93.1249 28.0613V46.7828L87.3756 50.8003L81.9502 46.7828V21.6333L68.9941 14V53.2108L81.2215 62.9332L68.9941 72.6555Z" fill="currentColor"/>
<path fillRule="evenodd" clipRule="evenodd" d="M50.3698 64.2188L60.4107 58.3532V14L23 35.8552V54.5768L26.7249 57.389V72.7359L23 74.6643V92.9841L60.4107 115V70.6468L50.3698 64.2188ZM47.5356 36.1766V53.2912L41.2195 56.9873L35.6322 53.8536V42.926L47.5356 36.1766ZM41.1385 71.4503L35.7132 74.6643V85.6722L47.4546 92.502V75.3071L41.1385 71.4503Z" fill="currentColor"/>
    </svg>
  );
}

export function BaXiJenBrand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-primary", className)}>
      <BaXiJenMark className="h-8 w-8 shrink-0" />
      <span className={compact ? "sr-only" : "text-lg font-semibold tracking-tight"}>{BRAND_NAME}</span>
    </div>
  );
}

export function PaperclipAttribution({ className }: { className?: string }) {
  return <a href={UPSTREAM_URL} className={cn("text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:underline", className)}>Powered by Paperclip</a>;
}
