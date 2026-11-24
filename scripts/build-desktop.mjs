import { packager } from '@electron/packager'
import { readFile } from 'node:fs/promises'

const platform = process.argv[2] || process.platform
if (!['linux', 'win32'].includes(platform)) {
  throw new Error('Selecione linux ou win32 para empacotar a versão desktop.')
}
const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const included = new Set(['', 'accounts.js', 'desktop', 'modules.js', 'node_modules', 'package.json', 'public', 'questionnaires.js', 'server.js'])
const outputs = await packager({
  dir: '.',
  name: 'Atlas da Mente',
  executableName: 'Atlas-da-Mente',
  asar: true,
  platform,
  arch: 'x64',
  electronVersion: devDependencies.electron,
  download: { cacheRoot: process.env.electron_config_cache },
  electronZipDir: process.env.ATLAS_ELECTRON_ARCHIVES,
  out: 'dist/desktop',
  overwrite: true,
  ignore: relativePath => !included.has(relativePath.split('/').filter(Boolean)[0] || ''),
})
for (const output of outputs) console.log(output)
