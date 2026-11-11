// How install writes a hooks file it creates or merges: one line per top-level key,
// and each event's hooks on one line. A fresh file stays a few lines long, so the
// upgrade PR that adds it is a small change (one question) while the base branch's
// gate doesn't know the file yet.

import { isRecord } from "../../util.js";

export function compactHooksJson(file: Record<string, unknown>): string {
  const line = (key: string, value: unknown) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const top = Object.entries(file).map(([key, value]) =>
    key === "hooks" && isRecord(value)
      ? `  "hooks": {\n${Object.entries(value)
          .map(([event, list]) => `    ${line(event, list)}`)
          .join(",\n")}\n  }`
      : `  ${line(key, value)}`,
  );
  return `{\n${top.join(",\n")}\n}\n`;
}
