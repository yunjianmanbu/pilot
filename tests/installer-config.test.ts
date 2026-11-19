import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

describe('installer configuration', () => {
  it('installs per user and never requests elevation', () => {
    const yml = read('electron-builder.yml')
    expect(yml).toMatch(/perMachine:\s*false/)
    expect(yml).toMatch(/allowElevation:\s*false/)
  })

  it('forces per-user mode even when a machine-wide copy exists', () => {
    const nsh = read('build/installer.nsh')
    expect(nsh).toContain('!macro customInit')
    expect(nsh).toContain('StrCpy $hasPerMachineInstallation "0"')
    expect(nsh).toContain('StrCpy $hasPerUserInstallation "1"')
    expect(nsh).toContain('!insertmacro setInstallModePerUser')
    expect(nsh).toContain('!macro customInstallMode')
    expect(nsh).toContain('StrCpy $isForceCurrentInstall "1"')
  })
})
