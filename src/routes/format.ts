/**
 * 时间格式化。
 *
 * 管理页要显示「10-29 20:11」这种本地时间；时区配错时退回 ISO，
 * 不该让整个接口因为一个配置错误而 500。
 */
export function formatLocal(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(epochMs))
  } catch {
    return new Date(epochMs).toISOString()
  }
}
