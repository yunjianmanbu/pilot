import { describe, expect, it } from 'vitest'
import { createEvolutionControls } from '../src/core/evolution'

/**
 * `pilot serve` runs the same evolution controls as the desktop panel, but it
 * has no pristine source tree, so the personal-fork actions must fail with a
 * message that names that reason instead of telling the user to update an app
 * that is already current.
 */
describe('computeEvolutionControls without a personal host', () => {
  const build = () =>
    createEvolutionControls({
      store: { getApiKey: () => '', activeWorkspace: () => null } as never,
      runner: {} as never,
      publish: () => undefined,
    })

  it('reports personal status as unavailable instead of failing later', async () => {
    await expect(build().personal()).rejects.toThrow('服务器模式不支持个人版本')
  })

  it('keeps the snapshot API so the panel can still paint the tab', () => {
    expect(typeof build().snapshot).toBe('function')
    expect(typeof build().action).toBe('function')
  })

  it('answers personal actions with the same reason', async () => {
    await expect(build().action('personalSave', { name: 'v1' })).rejects.toThrow(
      '服务器模式不支持个人版本',
    )
  })
})
