/**
 * Resolve merged YAML server listen ports (same as Vite proxy / Python read_config).
 * Used by next.config for dev rewrites.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

function pickPython() {
  const unixVenv = path.join(projectRoot, '.venv', 'bin', 'python')
  if (fs.existsSync(unixVenv)) return unixVenv
  const winVenv = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(winVenv)) return winVenv
  return 'python3'
}

export function loadServerPorts() {
  const py = pickPython()
  const code = [
    'import json,sys',
    `sys.path.insert(0, ${JSON.stringify(projectRoot)})`,
    'from src.app.config import read_config',
    'c,_=read_config()',
    'print(json.dumps(c["server"]))',
  ].join('; ')
  const out = execFileSync(py, ['-c', code], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: { ...process.env },
  }).trim()
  return JSON.parse(out)
}
