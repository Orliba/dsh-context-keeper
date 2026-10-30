/**
 * Unit tests for handoff packaging (src/handoff.mjs). Pure + a temp-dir write.
 * Run: node test/handoff.test.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractPaths,
  buildMaterials,
  renderPackage,
  renderArchive,
  writeHandoff,
  slugFor,
  stamp,
  clip,
  isInjectedUserText,
} from '../src/handoff.mjs'

let failures = 0
let checks = 0
function check(label, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`)
  }
}

console.log('handoff packaging')

// clip
check('clip short unchanged', clip('abc', 10) === 'abc')
check('clip long marked', clip('a'.repeat(50), 10).includes('已截断'))

// injected user text detection
check('memory snapshot is injected', isInjectedUserText('MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: x'))
check('huge paste is injected', isInjectedUserText('x'.repeat(2000)))
check('a normal ask is not injected', !isInjectedUserText('帮我把插件做出来，谢啦'))

// extractPaths
{
  const fromJson = extractPaths('{"path":"H:\\\\proj\\\\a.mjs","command":"node bin/cli.mjs"}')
  check('extractPaths finds JSON path', fromJson.some((p) => p.endsWith('a.mjs')), JSON.stringify(fromJson))
  check('extractPaths finds relative .mjs', fromJson.some((p) => p.endsWith('bin/cli.mjs') || p.endsWith('cli.mjs')), JSON.stringify(fromJson))
  const winCmd = extractPaths('{"command":"Get-Content H:\\\\Deepseekstudio\\\\x\\\\y.ps1 | more"}')
  check('extractPaths finds windows path', winCmd.some((p) => p.endsWith('y.ps1')), JSON.stringify(winCmd))
}

// slugFor + stamp
{
  const slug = slugFor({ session: { id: 'session-abc12345' } }, '测试 会话!!')
  check('slug has title + id tail', slug.includes('abc12345') && slug.includes('测试'), slug)
  check('stamp shape', /^\d{8}-\d{6}$/.test(stamp(Date.now())), stamp(Date.now()))
}

// A synthetic detail
const detail = {
  path: 'C:/fake/session.v4.jsonl.zstd',
  name: 'session.v4.jsonl.zstd',
  frames: 3,
  failedFrames: 0,
  session: { id: 'session-abc12345', cwd: 'H:\\proj', agentPreset: 'standard', createdAt: 0 },
  title: '构建插件测试',
  requestContext: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 100000 },
  turns: 2,
  steps: 4,
  users: [
    { seq: 1, text: '第一个请求：把插件做出来' },
    { seq: 5, text: '最近的请求：加上上下文提醒' },
  ],
  assistantTexts: [{ seq: 6, turn: 2, step: 1, text: '正在做事，这是最后一段回复。' }],
  toolCalls: [
    { seq: 2, turn: 1, step: 1, callId: 'c1', name: 'pwsh', args: '{"command":"node bin/cli.mjs handoff x","description":"run"}', description: 'run' },
    { seq: 3, turn: 1, step: 2, callId: 'c2', name: 'read', args: '{"path":"H:\\\\proj\\\\a.mjs"}', description: 'read a' },
  ],
  toolResults: [{ seq: 4, turn: 1, step: 2, callId: 'c2', isError: true, text: 'Error: boom\nat stack' }],
  compactions: [{ seq: 7, summary: '## Primary Request and Intent\n- 早期摘要内容', shadowedSeqs: [1, 2, 3] }],
}

const m = buildMaterials(detail, { now: '2026-10-29T00:00:00.000Z' })
check('title carried', m.title === '构建插件测试', m.title)
check('intent quotes first and recent', m.intent.includes('最初') && m.intent.includes('最近'), m.intent)
check('files include a.mjs', m.files.some((f) => f.path.endsWith('a.mjs')), JSON.stringify(m.files))
check('one command captured', m.commands.length === 1, JSON.stringify(m.commands))
check('one error captured, tool read', m.errors.length === 1 && m.errors[0].tool === 'read', JSON.stringify(m.errors))
check('early context reuses compaction summary', m.earlyContext.includes('Primary Request'), m.earlyContext)
check('current is last answer', m.current.includes('最后一段'), m.current)
check('next points at last user ask', m.next.includes('最近的请求'), m.next)
check('stats counted', m.stats.users === 2 && m.stats.toolCalls === 2 && m.stats.errors === 1 && m.stats.compactions === 1, JSON.stringify(m.stats))

const pkg = renderPackage(m)
check('package has section 1', pkg.includes('## 1. 要做的事'), pkg.slice(0, 80))
check('package has section 6', pkg.includes('## 6. 当前进行到哪'))
check('package has section 8 archive', pkg.includes('## 8. 全文归档'))
check('package has usage line', pkg.includes('开新会话后第一条粘贴'))

const arc = renderArchive(detail, { generatedAt: '2026-10-29T00:00:00.000Z' })
check('archive quotes user verbatim', arc.includes('第一个请求：把插件做出来'))
check('archive marks the error', arc.includes('ERROR'))

// writeHandoff writes both files
{
  const dir = mkdtempSync(join(tmpdir(), 'context-keeper-handoff-'))
  try {
    const res = writeHandoff(detail, { dir, now: new Date('2026-10-29T01:02:03') })
    check('package file exists', existsSync(res.packagePath), res.packagePath)
    check('archive file exists', existsSync(res.archivePath), res.archivePath)
    check('materials archivePath filled', res.materials.archivePath === res.archivePath)
    check('materials packagePath filled', res.materials.packagePath === res.packagePath)
    const pkgText = readFileSync(res.packagePath, 'utf8')
    check('paste line points at the package itself', pkgText.includes(res.packagePath) && pkgText.includes('先读第 1、6 节'), 'paste target wrong')
    check('paste line does NOT point at the archive', !/详细交接见 [^\n]*\.archive\.md/.test(pkgText), 'points at archive')
    const arcText0 = readFileSync(res.archivePath, 'utf8')
    check('archive notes it is not the numbered package', arcText0.includes('没有') && arcText0.includes(res.packagePath), 'archive note missing')
    const arcText = readFileSync(res.archivePath, 'utf8')
    check('archive contains user text', arcText.includes('最近的请求'))
    check('filename has timestamp', /20261029-010203/.test(res.packagePath), res.packagePath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
