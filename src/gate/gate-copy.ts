// How a repo's gate.mjs differs from the plugin's copy. The plugin's session start
// sets up git's hook only for an identical copy, and install says how they differ.

const withLfEndings = (bytes: Buffer) => Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");

export type GateCopyDifference = "none" | "repo-crlf" | "plugin-crlf" | "content";

/** How a repo's gate.mjs differs from the plugin's: not at all, only in CRLF
 *  line endings on one side (git's core.autocrlf on Windows), or in content.
 *  Only "none" is trusted: the other answers just change what the user is told. */
export function gateCopyDifference(repoCopy: Buffer, pluginCopy: Buffer): GateCopyDifference {
  if (repoCopy.equals(pluginCopy)) return "none";
  if (!withLfEndings(repoCopy).equals(withLfEndings(pluginCopy))) return "content";
  return repoCopy.includes("\r\n") ? "repo-crlf" : "plugin-crlf";
}
