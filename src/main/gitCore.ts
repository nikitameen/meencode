import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type GitFileStatus = { path: string; x: string; y: string; staged: boolean; untracked: boolean }
export type GitState = { repo: boolean; branch: string; ahead: number; behind: number; files: GitFileStatus[] }

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()))
      else resolve(String(stdout))
    })
  })
}

export function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'))
}

export async function initFor(root: string): Promise<void> {
  await git(['init'], root)
  try {
    await git(['config', 'user.email', 'meencode@local'], root)
    await git(['config', 'user.name', 'Meencode'], root)
  } catch { /* keep global config */ }
}

export async function stateFor(root: string): Promise<GitState> {
  if (!isRepo(root)) return { repo: false, branch: '', ahead: 0, behind: 0, files: [] }
  // rev-parse fails on a fresh repo with no commits — fall back to symbolic-ref
  let branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => '')).trim()
  if (!branch) {
    branch = (await git(['symbolic-ref', '--short', 'HEAD'], root).catch(() => '')).trim()
  }
  const porcelain = await git(['status', '--porcelain', '-z'], root).catch(() => '')
  const files: GitFileStatus[] = []
  for (const entry of porcelain.split('\0').filter(Boolean)) {
    if (entry.startsWith('R') || entry.startsWith('C')) {
      const parts = entry.split(' -> ')
      const xy = parts[0].slice(0, 2)
      files.push({ path: parts[parts.length - 1], x: xy[0], y: xy[1], staged: xy[0] !== ' ' && xy[0] !== '?', untracked: xy[0] === '?' })
      continue
    }
    const x = entry[0]
    const y = entry[1]
    files.push({ path: entry.slice(3), x, y, staged: x !== ' ' && x !== '?', untracked: x === '?' })
  }
  let ahead = 0
  let behind = 0
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root).catch(() => '')
  const m = counts.trim().match(/^(\d+)\s+(\d+)$/)
  if (m) {
    ahead = Number(m[1])
    behind = Number(m[2])
  }
  return { repo: true, branch, ahead, behind, files }
}

export async function stageFor(root: string, p: string): Promise<void> {
  await git(p === '.' ? ['add', '-A'] : ['add', '--', p], root)
}

export async function unstageFor(root: string, p: string): Promise<void> {
  await git(p === '.' ? ['reset'] : ['reset', 'HEAD', '--', p], root)
}

export async function discardFor(root: string, p: string): Promise<void> {
  await git(['checkout', '--', p], root)
}

export async function commitFor(root: string, message: string): Promise<void> {
  if (!message?.trim()) throw new Error('Commit message is required')
  await git(['commit', '-m', message.trim()], root)
}

export async function pushFor(root: string): Promise<void> {
  await git(['push', '-u', 'origin', 'HEAD'], root)
}

export async function pullFor(root: string): Promise<void> {
  await git(['pull', '--rebase'], root)
}

export async function addRemoteFor(root: string, remoteUrl: string): Promise<void> {
  await git(['remote', 'add', 'origin', remoteUrl], root).catch(async () => {
    await git(['remote', 'set-url', 'origin', remoteUrl], root)
  })
}

export async function logFor(root: string): Promise<string[]> {
  const out = await git(['log', '--pretty=format:%h %s', '-15'], root).catch(() => '')
  return out.split('\n').filter(Boolean)
}