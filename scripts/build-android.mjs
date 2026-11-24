import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw new Error('Defina ANDROID_HOME com o caminho do SDK Android.')
const tools = resolve(sdk, 'build-tools', '35.0.1')
const platform = resolve(sdk, 'platforms', 'android-35', 'android.jar')
const source = join(root, 'android', 'src', 'main')
const output = join(root, 'dist', 'android')
const javaSource = join(source, 'java', 'br', 'com', 'atlasdamente')
const { version } = JSON.parse(await readFile(join(root, 'package.json')))
const suffix = process.platform === 'win32' ? '.exe' : ''
const javaTool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name + suffix) : name
const aapt = join(tools, 'aapt2' + suffix)
const zipalign = join(tools, 'zipalign' + suffix)
const signer = join(tools, 'lib', 'apksigner.jar')
const dexer = join(tools, 'lib', 'd8.jar')
for (const component of [aapt, zipalign, signer, dexer, platform]) {
  try {
    await access(component)
  } catch {
    throw new Error('Componente ausente no SDK: ' + component)
  }
}

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const temporary = await mkdtemp(join(tmpdir(), 'atlas-android-'))
try {
  await mkdir(output, { recursive: true })
  const classes = join(temporary, 'classes')
  const dex = join(temporary, 'dex')
  await Promise.all([mkdir(classes), mkdir(dex)])
  const compiled = join(temporary, 'resources.zip')
  const unsigned = join(temporary, 'unsigned.apk')
  const aligned = join(temporary, 'aligned.apk')
  const bytecode = join(temporary, 'classes.jar')
  run(aapt, ['compile', '--dir', join(source, 'res'), '-o', compiled])
  run(aapt, ['link', '-I', platform, '--manifest', join(source, 'AndroidManifest.xml'),
    '--version-code', '1', '--version-name', version, '-o', unsigned, compiled])
  run(javaTool('javac'), ['--release', '17', '-encoding', 'UTF-8', '-classpath', platform, '-d', classes,
    join(javaSource, 'MainActivity.java'), join(javaSource, 'ServerAddress.java')])
  run(javaTool('jar'), ['--create', '--file', bytecode, '-C', classes, '.'])
  run(javaTool('java'), ['-cp', dexer, 'com.android.tools.r8.D8', '--lib', platform, '--min-api', '26', '--output', dex, bytecode])
  run(javaTool('jar'), ['--update', '--file', unsigned, '-C', dex, 'classes.dex'])
  run(zipalign, ['-f', '-p', '4', unsigned, aligned])

  const key = join(output, 'atlas-test.p12')
  try {
    await access(key)
  } catch {
    run(javaTool('keytool'), ['-genkeypair', '-alias', 'atlas-test', '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000', '-storetype', 'PKCS12', '-keystore', key,
      '-storepass', 'android', '-keypass', 'android', '-dname', 'CN=Atlas da Mente Teste'])
  }
  const apk = join(output, `Atlas-da-Mente-${version}-teste.apk`)
  run(javaTool('java'), ['-jar', signer, 'sign', '--ks', key, '--ks-pass', 'pass:android', '--out', apk, aligned])
  run(javaTool('java'), ['-jar', signer, 'verify', '--verbose', apk])
  console.log(apk)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
