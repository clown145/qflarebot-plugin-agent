import { describe, expect, it } from 'vitest'
import { parseAbsoluteTime, zonedTimeToEpoch } from '../src/tools/schedule.js'

describe('parseAbsoluteTime', () => {
  it('带时区偏移的 ISO 8601 直接解析', () => {
    const ms = parseAbsoluteTime('2026-10-29T09:00:00+08:00', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('Z 结尾的 ISO 按 UTC 解析', () => {
    const ms = parseAbsoluteTime('2026-10-29T01:00:00Z', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('不带时区的 "YYYY-MM-DD HH:mm" 按配置时区解释', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    // 北京时间 9 点 = UTC 1 点
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('同一个墙上时间在不同时区解析成不同时刻', () => {
    const shanghai = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    const utc = parseAbsoluteTime('2026-10-29 09:00', 'UTC')
    expect(shanghai).not.toBe(utc)
    // 上海比 UTC 早 8 小时
    expect(utc! - shanghai!).toBe(8 * 3600 * 1000)
  })

  it('支持 T 分隔符', () => {
    const withSpace = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    const withT = parseAbsoluteTime('2026-10-29T09:00', 'Asia/Shanghai')
    expect(withT).toBe(withSpace)
  })

  it('支持带秒', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00:30', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 30))
  })

  it('非法输入返回 null', () => {
    expect(parseAbsoluteTime('明天早上', 'Asia/Shanghai')).toBeNull()
    expect(parseAbsoluteTime('', 'Asia/Shanghai')).toBeNull()
  })

  it('时区非法时不崩，按 UTC 解释', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00', 'Not/AZone')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 9, 0, 0))
  })
})

describe('zonedTimeToEpoch', () => {
  it('北京时间 9 点换算成 UTC 1 点', () => {
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('UTC 时区不偏移', () => {
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'UTC')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 9, 0, 0))
  })

  it('跨日边界正确（洛杉矶比 UTC 晚 7 小时，夏令时）', () => {
    // 2026-10-29 洛杉矶是 PDT（UTC-7）
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'America/Los_Angeles')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 16, 0, 0))
  })
})
