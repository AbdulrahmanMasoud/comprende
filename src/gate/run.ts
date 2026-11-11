// Running a program without a shell: the one place the gate spawns processes (git,
// and a platform's CLI such as gh). A missing program throws an error with code ENOENT.

import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer | undefined; timeout?: number } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    maxBuffer: 1 << 30,
    timeout: opts.timeout,
    windowsHide: true,
  });
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw Object.assign(new Error(`${cmd}: not found`), { code: "ENOENT" });
    throw err;
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
}
