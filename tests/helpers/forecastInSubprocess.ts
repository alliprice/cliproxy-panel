/**
 * Runs projectQuota in a child process, so a projection that never ends fails
 * its test on a timeout instead of hanging the suite.
 *
 * The child reads the projection's arguments as JSON on stdin and prints its
 * result as JSON on stdout.
 */

import { projectQuota, type LiveReading } from '@/features/quota/forecast/forecastModel';

export interface ProjectionArguments {
  live: LiveReading[];
  drainPerHour: number;
  nowMs: number;
  untilMs: number;
}

export type SubprocessProjection =
  | { finished: true; result: ReturnType<typeof projectQuota> }
  | { finished: false; timedOut: boolean; stderr: string };

export function projectInSubprocess(
  args: ProjectionArguments,
  timeoutMs = 10_000
): SubprocessProjection {
  const run = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path],
    stdin: Buffer.from(JSON.stringify(args)),
    timeout: timeoutMs,
  });
  if (!run.success) {
    return {
      finished: false,
      timedOut: run.exitedDueToTimeout === true,
      stderr: run.stderr.toString(),
    };
  }
  return { finished: true, result: JSON.parse(run.stdout.toString()) };
}

if (import.meta.main) {
  const { live, drainPerHour, nowMs, untilMs } = (await Bun.stdin.json()) as ProjectionArguments;
  process.stdout.write(JSON.stringify(projectQuota(live, drainPerHour, nowMs, untilMs)));
}
