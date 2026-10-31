// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_HTML_BODY } from '../src/page-html.js'
import { PAGE_SCRIPT } from '../src/page/script.js'
import { defaultConfig } from '../src/config/index.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const input = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })) }
const change = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) }
const byId = (id) => document.getElementById(id)
let listeners
beforeEach(() => {
  document.body.innerHTML = PAGE_HTML_BODY
  vi.stubGlobal('requestAnimationFrame', () => 0)
  listeners = vi.spyOn(window, 'addEventListener')
})
afterEach(() => {
  for (const [type, listener, options] of listeners.mock.calls) window.removeEventListener(type, listener, options)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(options = {}) {
  let config = structuredClone({ ...defaultConfig, model: 'chat', system_prompt: 'saved prompt', personas: [{ name: 'helper', prompt: 'saved persona' }], overriddenKeys: [] })
  const posts = []
  let fail = false
  let release
  let holdGet = false
  let releaseGet
  const fetch = vi.fn(async (path, init) => {
    if (path === '/api/settings') {
      const body = JSON.parse(init.body)
      posts.push(body)
      if (options.hold) await new Promise((resolve) => { release = resolve })
      if (fail) return Response.json({ error: 'service unavailable' }, { status: 503 })
      config = { ...config, ...body.patch }
      if (body.reset) for (const key of body.reset) config[key] = defaultConfig[key]
      return Response.json({ ok: true, overriddenKeys: Object.keys(body.patch ?? {}) })
    }
    const response = Response.json({ config: structuredClone(config), modelStatus: { models: ['chat', 'reasoner'] }, tools: { list: [{ name: 'time.now', permission: { level: 1 } }], disabled: [] }, skills: [{ id: 'report', name: 'Report' }], bindings: [], schedules: [], audits: [], stats: [] })
    if (holdGet) { holdGet = false; await new Promise((resolve) => { releaseGet = resolve }) }
    return response
  })
  const source = PAGE_SCRIPT.replace("await import('/bridge.js')", '({ createBridge: async () => mockBridge })')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const setDirty = vi.fn()
  const app = await new AsyncFunction('mockBridge', source + '\nreturn { load, savePatch, openSkillEditor, openToolConfig };')({ embedded: false, fetch, resize() {}, setTitle() {}, onTheme() {}, toast: vi.fn(), setDirty })
  return { ...app, posts, fetch, setDirty, holdLoad: () => { holdGet = true }, releaseLoad: () => releaseGet?.(), setFail: (value) => { fail = value }, release: () => release?.() }
}

describe('Agent browser save flows', () => {
  it('reports unsaved drafts through the bridge until the save finishes', async () => {
    const app = await setup({ hold: true })
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    input(byId('promptBox'), 'draft')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    byId('savePrompt').click()
    await flush()
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    app.release()
    await flush()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('includes partially typed keyword chips in the host draft guard', async () => {
    const app = await setup()
    const keyword = byId('filterKeywords').querySelector('input')
    input(keyword, 'unfinished')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    input(keyword, '')
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('tracks a skill editor draft and releases it after confirmed discard', async () => {
    const app = await setup()
    await app.openSkillEditor()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    input(byId('skillBodyInput'), 'unsaved skill')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    document.querySelector('[data-act="cancel"]').click()
    document.querySelector('[data-act="ok"]').click()
    await flush()
    expect(byId('skillBodyInput')).toBeNull()
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
  })

  it('tracks tool configuration edits without sending their contents to the host', async () => {
    const app = await setup()
    await app.openToolConfig({ name: 'test', configFields: [{ key: 'key', label: 'Key', type: 'secret' }] })
    input(document.querySelector('.modal input'), 'test-value')
    expect(app.setDirty).toHaveBeenLastCalledWith(true)
    input(document.querySelector('.modal input'), '')
    expect(app.setDirty).toHaveBeenLastCalledWith(false)
    expect(app.setDirty.mock.calls.every((args) => args.length === 1 && typeof args[0] === 'boolean')).toBe(true)
  })

  it('preserves input entered while a refresh is in flight and rejects stale refresh responses after saving', async () => {
    const app = await setup()
    app.holdLoad()
    const loading = app.load()
    await flush()
    input(byId('promptBox'), 'typed during refresh')
    await app.savePatch({ model: 'reasoner' })
    app.releaseLoad()
    await loading
    expect(byId('promptBox').value).toBe('typed during refresh')
    expect(byId('modelSelect').value).toBe('reasoner')
  })

  it('refuses to silently drop a half-written opening dialogue', async () => {
    const app = await setup()
    ;[...document.querySelectorAll('button')].find((el) => el.textContent === '新增一对').click()
    input(document.querySelector('[data-dialog-role="用户"]'), 'hello')
    byId('savePersonaList').click()
    await flush()
    expect(app.posts).toHaveLength(0)
    expect(document.querySelector('[data-dialog-role="角色"]').getAttribute('aria-invalid')).toBe('true')
  })

  it('autosaving a switch and refreshing tool data preserve both manual drafts and DOM focus', async () => {
    const app = await setup()
    const prompt = byId('promptBox')
    const persona = document.querySelector('[data-persona-name]')
    input(prompt, 'unsaved prompt')
    input(persona, 'unsaved persona')
    byId('friendPrefix').click()
    await flush()
    await app.load()
    expect(prompt.value).toBe('unsaved prompt')
    expect(document.querySelector('[data-persona-name]')).toBe(persona)
    expect(persona.value).toBe('unsaved persona')
    expect(app.posts[0].patch).toEqual({ friend_needs_wake_prefix: true })
    expect(byId('saveStatus').textContent).toContain('未保存')
  })

  it('serializes settings writes and preserves edits made during a prompt save', async () => {
    const app = await setup({ hold: true })
    input(byId('promptBox'), 'first draft')
    byId('savePrompt').click()
    await flush()
    input(byId('promptBox'), 'newer draft')
    const next = app.savePatch({ model: 'reasoner' })
    await flush()
    expect(app.posts).toHaveLength(1)
    app.release()
    await flush()
    expect(app.posts).toHaveLength(2)
    app.release()
    await next
    expect(byId('promptBox').value).toBe('newer draft')
    expect(byId('savePrompt').disabled).toBe(false)
  })

  it('keeps failed input visible and lets the user retry without re-entering it', async () => {
    const app = await setup()
    app.setFail(true)
    input(byId('promptBox'), 'keep me')
    byId('savePrompt').click()
    await flush()
    expect(byId('promptBox').value).toBe('keep me')
    expect(byId('saveStatus').textContent).toContain('保存失败')
    expect(document.querySelector('.toast.error')?.textContent).toContain('service unavailable')
    app.setFail(false)
    byId('retrySave').click()
    await flush()
    expect(app.posts.at(-1).patch.system_prompt).toBe('keep me')
    expect(byId('saveStatus').textContent).toBe('已保存')
  })

  it('validates persona names inline instead of silently discarding unnamed drafts', async () => {
    const app = await setup()
    byId('addPersona').click()
    byId('savePersonaList').click()
    await flush()
    const last = [...document.querySelectorAll('[data-persona-name]')].at(-1)
    expect(app.posts).toHaveLength(0)
    expect(last.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(last)
  })

  it('maps all / selected / none to omitted / nonempty / empty permission properties', async () => {
    const app = await setup()
    const scope = document.querySelector('.permission-field select')
    expect(scope.value).toBe('all')
    change(scope, 'none')
    byId('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1).patch.personas[0].tools).toEqual([])
    change(scope, 'some')
    document.querySelector('.permission-field button').click()
    byId('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1).patch.personas[0].tools).toEqual(['time.now'])
    change(scope, 'all')
    byId('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1).patch.personas[0]).not.toHaveProperty('tools')
  })

  it('new personas inherit all tools and skills; deleting one remains an unsaved draft', async () => {
    const app = await setup()
    byId('addPersona').click()
    input([...document.querySelectorAll('[data-persona-name]')].at(-1), 'new')
    byId('savePersonaList').click()
    await flush()
    expect(app.posts.at(-1).patch.personas[1]).not.toHaveProperty('tools')
    expect(app.posts.at(-1).patch.personas[1]).not.toHaveProperty('skills')
    ;[...document.querySelectorAll('button')].find((el) => el.textContent === '删除这套人格').click()
    document.querySelector('[data-act="ok"]').click()
    await flush()
    expect(app.posts).toHaveLength(1)
    expect(byId('savePersonaList').disabled).toBe(false)
  })

  it('supports roving tab focus and restores focus after canceling a dialog', async () => {
    await setup()
    byId('tab-model').focus()
    byId('tab-model').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(byId('tab-behavior'))
    expect(byId('panel-model').hidden).toBe(true)
    expect(byId('tab-model').tabIndex).toBe(-1)
    byId('resetPrompt').focus()
    byId('resetPrompt').click()
    expect(document.querySelector('[role="dialog"]').getAttribute('aria-label')).toBeTruthy()
    document.querySelector('[data-act="cancel"]').click()
    await flush()
    expect(document.activeElement).toBe(byId('resetPrompt'))
  })
})
