/** Log JSON một dòng — CloudWatch Logs Insights truy vấn được theo trường. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === '1') return;
  const line = JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
