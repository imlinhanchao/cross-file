import { useMemo } from "react";

// Single icon source: the Lucide set checked into design/assets/icons (docs/04 §11).
const icons = import.meta.glob("../../../../design/assets/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const byName = new Map<string, string>();
for (const [path, raw] of Object.entries(icons)) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  byName.set(name, raw);
}

function normalize(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s(?:width|height)="24"/g, "")
    .replace(/\sclass="[^"]*"/g, "")
    .replace("<svg", '<svg class="icon" aria-hidden="true" focusable="false"');
}

export interface IconProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Icon({ name, size = "md", className }: IconProps) {
  const html = useMemo(() => {
    const raw = byName.get(name);
    if (!raw) return "";
    const svg = normalize(raw);
    if (size === "sm") return svg.replace('class="icon"', 'class="icon icon--sm"');
    if (size === "lg") return svg.replace('class="icon"', 'class="icon icon--lg"');
    return svg;
  }, [name, size]);

  if (!html) return null;
  return <span className={`icon-slot ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
