// 文件开头说明：team-test 只使用这一条顺序清理入口。每类任务最多执行一次；
// 某类失败不会掩盖其他类的结果，最终以非零退出码交给平台下一轮重试。
import { spawn } from 'child_process'

const cleanupTasks = [
  'cleanup:assets',
  'cleanup:works',
  'cleanup:security',
  'cleanup:inventory-imports',
]

const runTask = (script: string): Promise<number> => new Promise((resolve) => {
  const child = spawn('pnpm', ['run', script], { stdio: 'inherit', env: process.env })
  child.once('error', () => resolve(1))
  child.once('exit', (code) => resolve(code ?? 1))
})

const run = async (): Promise<void> => {
  let failures = 0
  for (const task of cleanupTasks) {
    const exitCode = await runTask(task)
    if (exitCode !== 0) failures += 1
  }
  if (failures > 0) {
    throw new Error(`${failures} 个清理子任务失败。`)
  }
}

run().catch(() => {
  console.error('team-test 清理未全部完成；下一轮任务将重试失败类别。')
  process.exitCode = 1
})
