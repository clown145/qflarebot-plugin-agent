// @vitest-environment jsdom
/** 执行最终内联脚本，验证保存、草稿恢复和键盘操作；不在这里重复检查静态 HTML。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_HTML_BODY } from '../page-html.js'
import { PAGE_SCRIPT } from './script.js'
import { defaultConfig, type AgentConfig } from '../config/index.js'

const flush = () => vi.advanceTimersByTimeAsync(0)

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function input(el: FormControl, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function change(el: FormControl, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error('找不到测试控件：' + id)
  return el as T
}

let removeListeners: () => void

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = PAGE_HTML_BODY
  vi.stubGlobal('requestAnimationFrame', () => 0)
  const listeners = vi.spyOn(window, 'addEventListener')
  const documentListeners = vi.spyOn(document, 'addEventListener')
  removeListeners = () => {
    for (const [type, listener, options] of listeners.mock.calls) {
      window.removeEventListener(type, listener, options)
    }
    for (const [type, listener, options] of documentListeners.mock.calls) {
      document.removeEventListener(type, listener, options)
    }
  }
})

afterEach(() => {
  removeListeners()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

interface SettingsWrite {
  patch: Partial<AgentConfig>
  reset?: true | Array<keyof AgentConfig>
}

interface PageActions {
  load(): Promise<boolean>
  savePatch(patch: Partial<AgentConfig>): Promise<boolean>
  openSkillEditor(id?: string): Promise<void>
  openToolConfig(tool: {
    name: string
    configFields: Array<{ key: string; label: string; type: string }>
  }): Promise<void>
}

async function setup(options: { hold?: boolean } = {}) {
  let config = structuredClone({
    ...defaultConfig,
    model: 'chat',
    system_prompt: 'saved prompt',
    personas: [{ name: 'helper', prompt: 'saved persona', begin_dialogs: '' }],
    overriddenKeys: [] as string[],
  })
  const posts: SettingsWrite[] = []
  let fail = false
  let release: (() => void) | undefined
  let holdGet = false
  let releaseGet: (() => void) | undefined
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/settings') {
      const body = JSON.parse(String(init?.body)) as SettingsWrite
      posts.push(body)
      if (options.hold) await new Promise<void>((resolve) => { release = resolve })
      if (fail) return Response.json({ error: 'service unavailable' }, { status: 503 })
      config = { ...config, ...body.patch }
      if (body.reset) {
        const keys = body.reset === true ? Object.keys(defaultConfig) as Array<keyof AgentConfig> : body.reset
        for (const key of keys) Object.assign(config, { [key]: defaultConfig[key] })
      }
      return Response.json({ ok: true, overriddenKeys: Object.keys(body.patch ?? {}) })
    }
    const response = Response.json({
      config: structuredClone(config),
      modelStatus: { models: ['chat', 'reasoner'] },
      tools: { list: [{ name: 'time.now', permission: { level: 1 } }], disabled: [] },
      skills: [{ id: 'report', name: 'Report' }],
      bindings: [], schedules: [], audits: [], stats: [],
    })
    if (holdGet) {
      holdGet = false
      await new Promise<void>((resolve) => { releaseGet = resolve })
    }
    return response
  })
  const bridge = {
    embedded: false,
    fetch,
    resize() {},
    setTitle() {},
    onTheme() {},
    toast: vi.fn(),
    setDirty: vi.fn<(dirty: boolean) => void>(),
  }
  // 与 page-syntax.test.ts 一样执行 AsyncFunction；只替换宿主模块入口。
  const source = PAGE_SCRIPT.replace("await import('/bridge.js')", '({ createBridge: async () => mockBridge })')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (mockBridge: typeof bridge) => Promise<PageActions>
  const app = await new AsyncFunction('mockBridge', source + '\nreturn { load, savePatch, openSkillEditor, openToolConfig };')(bridge)
  return {
    ...app,
    posts,
    fetch,
    setDirty: bridge.setDirty,
    holdLoad: () => { holdGet = true },
    releaseLoad: () => releaseGet?.(),
    setFail: (value: boolean) => { fail = value },
    release: () => release?.(),
  }
}

describe('管理页的保存与草稿保护', () => {
  it('保存完成前一直向宿主上报未保存状态', async () => {
    const app = await setup({ hold: true })
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    input(byId<HTMLTextAreaElement>('promptBox'), 'draft')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    byId<HTMLButtonElement>('savePrompt').click()
    await flush()
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    app.release()
    await flush()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('还没按回车的关键词也计入未保存状态', async () => {
    const app = await setup()
    const keyword = byId('filterKeywords').querySelector<HTMLInputElement>('input')!
    input(keyword, 'unfinished')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    input(keyword, '')
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('技能编辑需要确认放弃，关闭后清除草稿状态', async () => {
    const app = await setup()
    await app.openSkillEditor()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    input(byId<HTMLTextAreaElement>('skillBodyInput'), 'unsaved skill')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    document.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click()
    document.querySelector<HTMLButtonElement>('[data-act="ok"]')!.click()
    await flush()
    expect(document.getElementById('skillBodyInput')).toBeNull()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('工具配置只向宿主上报布尔状态，不传编辑内容', async () => {
    const app = await setup()
    await app.openToolConfig({ name: 'test', configFields: [{ key: 'key', label: 'Key', type: 'secret' }] })
    input(document.querySelector<HTMLInputElement>('.modal input')!, 'test-value')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    input(document.querySelector<HTMLInputElement>('.modal input')!, '')
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    expect(app.setDirty.mock.calls.every((args) => args.length === 1 && typeof args[0] === 'boolean')).toBe(true)
  })

  it('刷新期间输入的草稿保留，保存后的旧刷新响应不覆盖新值', async () => {
    const app = await setup()
    app.holdLoad()
    const loading = app.load()
    await flush()
    input(byId<HTMLTextAreaElement>('promptBox'), 'typed during refresh')
    await app.savePatch({ model: 'reasoner' })
    app.releaseLoad()
    await loading
    expect(byId<HTMLTextAreaElement>('promptBox').value).toBe('typed during refresh')
    expect(byId<HTMLSelectElement>('modelSelect').value).toBe('reasoner')
  })

  it('开场对话只填一半时提示补全，不静默丢弃', async () => {
    const app = await setup()
    ;[...document.querySelectorAll('button')].find((el) => el.textContent === '新增一对')!.click()
    input(document.querySelector<HTMLTextAreaElement>('[data-dialog-role="用户"]')!, 'hello')
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    expect(app.posts).toHaveLength(0)
    expect(document.querySelector('[data-dialog-role="角色"]')!.getAttribute('aria-invalid')).toBe('true')
  })

  it('开关自动保存和刷新工具数据不覆盖手动草稿或替换输入节点', async () => {
    const app = await setup()
    const prompt = byId<HTMLTextAreaElement>('promptBox')
    const persona = document.querySelector<HTMLInputElement>('[data-persona-name]')!
    input(prompt, 'unsaved prompt')
    input(persona, 'unsaved persona')
    byId('friendPrefix').click()
    await flush()
    await app.load()
    expect(prompt.value).toBe('unsaved prompt')
    expect(document.querySelector<HTMLInputElement>('[data-persona-name]')!).toBe(persona)
    expect(persona.value).toBe('unsaved persona')
    expect(app.posts[0]!.patch).toEqual({ friend_needs_wake_prefix: true })
    expect(byId('saveStatus').textContent).toContain('未保存')
  })

  it('保存请求串行执行，等待期间的新提示词草稿保留', async () => {
    const app = await setup({ hold: true })
    input(byId<HTMLTextAreaElement>('promptBox'), 'first draft')
    byId<HTMLButtonElement>('savePrompt').click()
    await flush()
    input(byId<HTMLTextAreaElement>('promptBox'), 'newer draft')
    const next = app.savePatch({ model: 'reasoner' })
    await flush()
    expect(app.posts).toHaveLength(1)
    app.release()
    await flush()
    expect(app.posts).toHaveLength(2)
    app.release()
    await next
    expect(byId<HTMLTextAreaElement>('promptBox').value).toBe('newer draft')
    expect(byId<HTMLButtonElement>('savePrompt').disabled).toBe(false)
  })

  it('保存失败保留输入，重试时不需要重新填写', async () => {
    const app = await setup()
    app.setFail(true)
    input(byId<HTMLTextAreaElement>('promptBox'), 'keep me')
    byId<HTMLButtonElement>('savePrompt').click()
    await flush()
    expect(byId<HTMLTextAreaElement>('promptBox').value).toBe('keep me')
    expect(byId('saveStatus').textContent).toContain('保存失败')
    expect(document.querySelector('.toast.error')?.textContent).toContain('service unavailable')
    app.setFail(false)
    byId('retrySave').click()
    await flush()
    expect(app.posts.at(-1)!.patch.system_prompt).toBe('keep me')
    expect(byId('saveStatus').textContent).toBe('已保存')
  })

  it('人格缺少名字时就地提示并聚焦，不静默丢弃草稿', async () => {
    const app = await setup()
    byId('addPersona').click()
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    const last = [...document.querySelectorAll<HTMLInputElement>('[data-persona-name]')].at(-1)!
    expect(app.posts).toHaveLength(0)
    expect(last.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(last)
  })

  it('全部允许、指定部分、全部禁用分别对应缺省、非空和空权限列表', async () => {
    const app = await setup()
    const scope = document.querySelector<HTMLSelectElement>('.permission-field select')!
    expect(scope.value).toBe('all')
    change(scope, 'none')
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1)!.patch.personas![0]!.tools).toEqual([])
    change(scope, 'some')
    document.querySelector<HTMLButtonElement>('.permission-field button')!.click()
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1)!.patch.personas![0]!.tools).toEqual(['time.now'])
    change(scope, 'all')
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1)!.patch.personas![0]).not.toHaveProperty('tools')
  })

  it('新增人格默认继承全部工具和技能，删除后仍需手动保存', async () => {
    const app = await setup()
    byId('addPersona').click()
    input([...document.querySelectorAll<HTMLInputElement>('[data-persona-name]')].at(-1)!, 'new')
    byId<HTMLButtonElement>('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1)!.patch.personas![1]).not.toHaveProperty('tools')
    expect(app.posts.at(-1)!.patch.personas![1]).not.toHaveProperty('skills')
    ;[...document.querySelectorAll('button')].find((el) => el.textContent === '删除这套人格')!.click()
    document.querySelector<HTMLButtonElement>('[data-act="ok"]')!.click()
    await flush()
    expect(app.posts).toHaveLength(1)
    expect(byId<HTMLButtonElement>('savePersonaList').disabled).toBe(false)
  })

  it('方向键切换标签，取消弹窗后焦点回到触发按钮', async () => {
    await setup()
    byId('tab-model').focus()
    byId('tab-model').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(byId('tab-behavior'))
    expect(byId('panel-model').hidden).toBe(true)
    expect(byId('tab-model').tabIndex).toBe(-1)
    byId('resetPrompt').focus()
    byId('resetPrompt').click()
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBeTruthy()
    document.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click()
    await flush()
    expect(document.activeElement).toBe(byId('resetPrompt'))
  })
})
