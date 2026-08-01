import { describe, expect, it } from 'vitest'
import { analyseSource, capabilitiesNotExercised } from './static-analysis'

const CLEAN = `
const fs = require('fs')
fs.writeFileSync('./build/out.txt', 'done')
`

/** Shaped like esbuild's real install.js: capable, legitimate, readable. */
const LEGITIMATE = `
const https = require('https')
const { execSync } = require('child_process')
const version = process.env.npm_package_version
https.get('https://registry.npmjs.org/esbuild', () => {})
execSync('./bin/esbuild --version')
`

const CONCEALED = `
const _0x=Buffer.from('${'QUJDRA'.repeat(60)}','base64');eval(_0x.toString());const h=require('https');process.env.HOME
`

const NOTHING_RAN = {
  readCredentials: false,
  madeNetworkRequest: false,
  spawnedProcess: false,
}

describe('analyseSource', () => {
  it('finds no capability in a script that only writes its own output', () => {
    expect(analyseSource({ 'a.js': CLEAN }).capabilities).toEqual([])
  })

  it('reports capabilities in legitimate build tooling', () => {
    const ids = analyseSource({ 'install.js': LEGITIMATE }).capabilities.map(
      (c) => c.id,
    )
    expect(ids).toContain('credential_access')
    expect(ids).toContain('network')
    expect(ids).toContain('process_spawn')
  })

  it('cites the literal source fragment, not a summary', () => {
    const cap = analyseSource({ 'install.js': LEGITIMATE }).capabilities.find(
      (c) => c.id === 'network',
    )
    expect(cap?.matches.join(' ')).toMatch(/require\("?'?https/)
  })

  it('flags packed source carrying a long base64 literal', () => {
    const ids = analyseSource({ 'x.js': CONCEALED }).capabilities.map(
      (c) => c.id,
    )
    expect(ids).toContain('obfuscation')
    expect(ids).toContain('dynamic_code')
  })

  it('reports what it scanned, so silence is distinguishable from not looking', () => {
    const r = analyseSource({ 'install.js': LEGITIMATE })
    expect(r.filesScanned).toEqual(['install.js'])
    expect(r.bytesScanned).toBeGreaterThan(0)
  })
})

describe('capabilitiesNotExercised', () => {
  it('does NOT escalate legitimate tooling that simply did not need its capabilities', () => {
    // This is the measured false positive: esbuild carries https + process.env
    // to fetch a platform binary. Escalating on that flags most install hooks.
    const statik = analyseSource({ 'install.js': LEGITIMATE })
    expect(capabilitiesNotExercised(statik, NOTHING_RAN)).toEqual([])
  })

  it('escalates when unused capability comes with concealed source', () => {
    const statik = analyseSource({ 'x.js': CONCEALED })
    const dormant = capabilitiesNotExercised(statik, NOTHING_RAN)
    expect(dormant.length).toBeGreaterThan(0)
    expect(dormant.map((c) => c.id)).toContain('obfuscation')
  })

  it('never treats process spawning alone as suspicious', () => {
    const statik = analyseSource({ 'x.js': CONCEALED })
    const dormant = capabilitiesNotExercised(statik, NOTHING_RAN)
    expect(dormant.map((c) => c.id)).not.toContain('process_spawn')
  })
})
