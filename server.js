import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { moduleMap, modules, frequencies } from './modules.js'
import { createAccounts, normalizeEmail, transaction } from './accounts.js'
import { patientSection, publicModule, questionnaireStore, questionnaireTemplate } from './questionnaires.js'

const secure = process.env.NODE_ENV === 'production'
const demo = process.env.ATLAS_DEMO === '1' || (!secure && process.env.ATLAS_DEMO !== '0')
if (demo && secure) throw new Error('O modo demonstração é exclusivo do ambiente de desenvolvimento.')

const databasePath = resolve(process.env.ATLAS_DB || (demo ? 'data/demo.sqlite' : 'data/atlas.sqlite'))
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
process.umask(0o077)
const db = new DatabaseSync(databasePath)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS assignments (
    token TEXT PRIMARY KEY,
    patient TEXT NOT NULL,
    modules TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    revoked_at TEXT,
    answers TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY);
`)

const getSetting = db.prepare('SELECT key FROM settings WHERE key = ?')
const demoSeeded = getSetting.get('demo_seeded')
const dbMode = demo ? 'mode_demo' : 'mode_private'
const otherMode = demo ? 'mode_private' : 'mode_demo'
if (getSetting.get(otherMode) || (!demo && demoSeeded)) {
  throw new Error('O banco selecionado pertence a outro modo do Atlas. Use um banco separado.')
}
db.prepare('INSERT OR IGNORE INTO settings VALUES (?)').run(dbMode)

const accounts = createAccounts(db, { demo, secure })
const legacyEmail = normalizeEmail(process.env.ATLAS_LEGACY_EMAIL)
const newToken = () => randomBytes(24).toString('base64url')
const now = () => new Date().toISOString()

transaction(db, () => {
  const columns = new Set(db.prepare('PRAGMA table_info(assignments)').all().map(column => column.name))
  if (!columns.has('professional_id')) db.exec('ALTER TABLE assignments ADD COLUMN professional_id INTEGER REFERENCES accounts(id)')
  if (!columns.has('patient_id')) db.exec('ALTER TABLE assignments ADD COLUMN patient_id INTEGER REFERENCES accounts(id)')
  db.exec(`
    CREATE INDEX IF NOT EXISTS assignments_professional ON assignments(professional_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS assignments_patient ON assignments(patient_id, created_at DESC);
  `)
})

const createAssignment = db.prepare(`
  INSERT INTO assignments (token, patient, modules, message, created_at, started_at, completed_at, answers, professional_id, patient_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

transaction(db, () => {
  const assignLegacy = db.prepare('UPDATE assignments SET professional_id = ? WHERE professional_id IS NULL')
  if (!demo) {
    if (legacyEmail && db.prepare('SELECT 1 FROM assignments WHERE professional_id IS NULL LIMIT 1').get()) {
      assignLegacy.run(accounts.legacyOwner(legacyEmail, process.env.ATLAS_PASSWORD).id)
    }
    return
  }
  const sample = accounts.seedDemo()
  assignLegacy.run(sample.professional.id)
  db.prepare("UPDATE assignments SET patient_id = ? WHERE patient_id IS NULL AND professional_id = ? AND patient = 'Mariana Costa'")
    .run(sample.patient.id, sample.professional.id)
  if (getSetting.get('demo_seeded')) return

  const daysAgo = days => new Date(Date.now() - days * 86_400_000).toISOString()
  const answerSet = (id, count) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`${id}:${index}`, id === 'raciocinio'
      ? { choice: index % 4 === 0 ? (moduleMap[id].questions[index].correct + 1) % 4 : moduleMap[id].questions[index].correct }
      : { frequency: (index + 2) % 5, impact: index % 3 === 0 }]),
  )
  for (const [patient, ids, sent, started, completed, answers] of [
    ['Mariana Costa', ['tdah', 'raciocinio'], 0, 0, null, answerSet('tdah', 12)],
    ['Rafael Mendes', ['autismo', 'dislexia'], 1, null, null, {}],
    ['Beatriz Lima', ['dislexia'], 2, 2, 1, answerSet('dislexia', 20)],
    ['Lucas Almeida', ['comportamento', 'tdah'], 3, 3, 0, { ...answerSet('comportamento', 20), ...answerSet('tdah', 20) }],
    ['Camila Rocha', ['raciocinio'], 4, 4, 3, answerSet('raciocinio', 20)],
    ['Felipe Santos', ['autismo'], 5, 4, null, answerSet('autismo', 6)],
  ]) {
    createAssignment.run(newToken(), patient, JSON.stringify(ids), '', daysAgo(sent),
      started === null ? null : daysAgo(started), completed === null ? null : daysAgo(completed), JSON.stringify(answers),
      sample.professional.id, patient === sample.patient.name ? sample.patient.id : null)
  }
  db.prepare("INSERT INTO settings VALUES ('demo_seeded')").run()
})

const ownedAssignment = db.prepare('SELECT * FROM assignments WHERE token = ? AND professional_id = ?')
const patientAssignment = db.prepare('SELECT * FROM assignments WHERE token = ? AND patient_id = ? AND revoked_at IS NULL')
const overview = db.prepare('SELECT * FROM assignments WHERE professional_id = ? ORDER BY created_at DESC, rowid DESC')
const patientOverview = db.prepare(`
  SELECT assignments.*, accounts.name AS professional_name
  FROM assignments JOIN accounts ON professional_id = accounts.id
  WHERE patient_id = ? AND revoked_at IS NULL
  ORDER BY created_at DESC, assignments.rowid DESC
`)
const questionnaires = questionnaireStore(db)
const catalog = modules.map(publicModule)
const findModule = (owner, id) => Object.hasOwn(moduleMap, id) ? moduleMap[id] : questionnaires.get(owner, id)
const assignedModules = row => JSON.parse(row.modules).map(id => findModule(row.professional_id, id))

function serialize(row, includeAnswers = false) {
  return {
    token: row.token, patient: row.patient, modules: JSON.parse(row.modules),
    linked: row.patient_id !== null,
    ...(row.professional_name && { professional: row.professional_name }),
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    status: row.revoked_at ? 'revoked' : row.completed_at ? 'completed' : row.started_at ? 'started' : 'pending',
    ...(includeAnswers ? { message: row.message, answers: JSON.parse(row.answers) } : {}),
  }
}

function projectReport(row, sections = assignedModules(row)) {
  const answers = JSON.parse(row.answers)
  return sections.map(module => {
    const entries = module.questions.map((question, index) => ({
      index: index + 1,
      theme: question.theme,
      prompt: question.prompt,
      answer: answers[`${module.id}:${index}`],
      ...(module.kind === 'logic' && {
        options: question.options, correct: question.correct,
        explanation: question.explanation,
      }),
    }))
    return { ...publicModule(module), entries }
  })
}

function json(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  response.end(JSON.stringify(data))
}

async function readBody(request, maxBytes = 16_384) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw Object.assign(new Error('Formato de dados inválido.'), { status: 415 })
  }
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBytes) {
      request.resume()
      throw Object.assign(new Error('Dados acima do limite.'), { status: 413 })
    }
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw Object.assign(new Error('Dados inválidos.'), { status: 400 })
  }
}

function cleanAnswer(answer, question, isLogic) {
  if (answer?.skip === true) return { skip: true }
  if (isLogic && Number.isInteger(answer?.choice) && question.options[answer.choice] !== undefined) {
    return { choice: answer.choice }
  }
  if (!isLogic && Number.isInteger(answer?.frequency) && frequencies[answer.frequency] !== undefined && typeof answer.impact === 'boolean') {
    const example = typeof answer.example === 'string' ? answer.example.trim().slice(0, 500) : ''
    return { frequency: answer.frequency, impact: answer.impact, ...(example && { example }) }
  }
  return null
}

const invalidPatientLink = { error: 'Avaliação indisponível para esta conta. Confira com seu psicólogo.' }

function requireRole(request, role) {
  const account = accounts.current(request)
  if (!account) throw Object.assign(new Error('Entre na sua conta para continuar.'), { status: 401 })
  if (account.role !== role) {
    throw Object.assign(new Error(role === 'patient' ? 'Abra a avaliação com uma conta de paciente.' : 'Use uma conta de psicólogo para acessar o painel.'), { status: 403 })
  }
  return account
}

function updatePatient(account, token, action, data) {
  return transaction(db, () => {
    const row = patientAssignment.get(token, account.id)
    if (!row) return [404, invalidPatientLink]
    const assignment = serialize(row, true)
    if (assignment.completedAt) {
      return action === 'complete'
        ? [200, { assignment, report: projectReport(row) }]
        : [409, { error: 'Esta avaliação já foi concluída. Atualize a página para ver o resumo.' }]
    }
    if (action === 'start') {
      db.prepare('UPDATE assignments SET started_at = COALESCE(started_at, ?) WHERE token = ?').run(now(), token)
      return [200, { assignment: serialize(patientAssignment.get(token, account.id), true) }]
    }
    if (!assignment.startedAt) return [409, { error: 'Inicie a avaliação antes de responder.' }]
    if (action === 'answer') {
      const { moduleId, index, answer } = data
      const module = assignment.modules.includes(moduleId) && findModule(row.professional_id, moduleId)
      const question = Number.isInteger(index) && index >= 0 && module && module.questions[index]
      const validated = question && cleanAnswer(answer, question, module.kind === 'logic')
      if (!validated) return [400, { error: 'Selecione uma resposta válida ou pule a questão.' }]
      assignment.answers[`${moduleId}:${index}`] = validated
      db.prepare('UPDATE assignments SET answers = ? WHERE token = ?').run(JSON.stringify(assignment.answers), token)
      return [200, { answers: assignment.answers }]
    }
    const sections = assignedModules(row)
    const allVisited = sections.every(module => module.questions.every((_, index) => assignment.answers[`${module.id}:${index}`]))
    if (!allVisited) return [409, { error: 'Responda ou pule as questões restantes antes de concluir.' }]
    db.prepare('UPDATE assignments SET completed_at = ? WHERE token = ?').run(now(), token)
    const completed = patientAssignment.get(token, account.id)
    return [200, { assignment: serialize(completed, true), report: projectReport(completed, sections) }]
  })
}

async function api(request, response, path) {
  const method = request.method
  if (method === 'GET' && path === '/api/session') {
    return json(response, 200, { account: accounts.profile(accounts.current(request)) || null, demo })
  }
  if (method === 'POST' && ['/api/login', '/api/register', '/api/demo-login'].includes(path)) {
    if (path === '/api/demo-login' && !demo) return json(response, 404, { error: 'Página não encontrada.' })
    const data = await readBody(request)
    const account = path === '/api/demo-login' ? accounts.demoAccount(data.role)
      : path === '/api/register' ? await accounts.register(request, data) : await accounts.login(request, data)
    if (!account) return json(response, 400, { error: 'Escolha um perfil de demonstração.' })
    return json(response, path === '/api/register' ? 201 : 200, { account: accounts.profile(account), demo },
      { 'Set-Cookie': accounts.startSession(request, account) })
  }
  if (method === 'POST' && path === '/api/logout') {
    await readBody(request)
    return json(response, 200, {}, { 'Set-Cookie': accounts.signOut(request) })
  }

  if (method === 'GET' && path === '/api/patient-dashboard') {
    const account = requireRole(request, 'patient')
    const rows = patientOverview.all(account.id)
    const available = new Map()
    for (const row of rows) {
      for (const id of JSON.parse(row.modules)) {
        if (!available.has(id)) available.set(id, publicModule(findModule(row.professional_id, id)))
      }
    }
    return json(response, 200, { catalog: [...available.values()], assignments: rows.map(row => serialize(row)) })
  }
  if (path.startsWith('/api/patient/')) {
    const match = /^\/api\/patient\/([A-Za-z0-9_-]{32})(?:\/(start|answer|complete))?$/.exec(path)
    if (!match) return json(response, 404, invalidPatientLink)
    const [, token, action] = match
    const account = requireRole(request, 'patient')
    if (method === 'GET' && !action) {
      const row = patientAssignment.get(token, account.id)
      if (!row) return json(response, 404, invalidPatientLink)
      const assignment = serialize(row, true)
      const sections = assignedModules(row)
      return json(response, 200, {
        assignment, sections: sections.map(patientSection), frequencies,
        ...(assignment.completedAt && { report: projectReport(row, sections) }),
      })
    }
    if (method !== 'POST' || !action) return json(response, 405, { error: 'Operação indisponível.' })
    const data = await readBody(request)
    const current = requireRole(request, 'patient')
    return json(response, ...updatePatient(current, token, action, data))
  }

  const account = requireRole(request, 'professional')
  if (method === 'GET' && path === '/api/dashboard') {
    return json(response, 200, {
      catalog: [...catalog, ...questionnaires.list(account.id).map(publicModule)],
      frequencies, assignments: overview.all(account.id).map(row => serialize(row)),
    })
  }
  if (method === 'GET' && path === '/api/catalog') {
    return json(response, 200, { sections: [...modules, ...questionnaires.list(account.id)].map(patientSection) })
  }
  if (method === 'GET' && path === '/api/questionnaires/template') {
    return json(response, 200, questionnaireTemplate, { 'Content-Disposition': 'attachment; filename="atlas-modelo-questionario.json"' })
  }
  const exportMatch = /^\/api\/questionnaires\/(q-[a-zA-Z0-9_-]{24})\/export$/.exec(path)
  if (method === 'GET' && exportMatch) {
    const module = questionnaires.get(account.id, exportMatch[1])
    if (!module) return json(response, 404, { error: 'Questionário não encontrado.' })
    const { title, description, period, questions } = module
    return json(response, 200, { title, description, period, questions }, {
      'Content-Disposition': `attachment; filename="atlas-${module.id}.json"`,
    })
  }
  if (method === 'POST' && path === '/api/questionnaires') {
    const data = await readBody(request, 65_536)
    const current = requireRole(request, 'professional')
    return json(response, 201, { module: publicModule(questionnaires.create(current.id, data)) })
  }
  const moduleMatch = /^\/api\/catalog\/([a-zA-Z0-9_-]+)$/.exec(path)
  if (method === 'GET' && moduleMatch) {
    const module = findModule(account.id, moduleMatch[1])
    if (!module) return json(response, 404, { error: 'Questionário não encontrado.' })
    return json(response, 200, { module: patientSection(module) })
  }
  const archiveMatch = /^\/api\/questionnaires\/(q-[a-zA-Z0-9_-]{24})\/archive$/.exec(path)
  if (method === 'POST' && archiveMatch) {
    const { archived } = await readBody(request)
    const current = requireRole(request, 'professional')
    if (typeof archived !== 'boolean') return json(response, 400, { error: 'Informe se deseja arquivar ou reativar o questionário.' })
    if (!questionnaires.archive(current.id, archiveMatch[1], archived)) {
      return json(response, 404, { error: 'Questionário não encontrado.' })
    }
    return json(response, 200, { archived })
  }
  if (method === 'POST' && path === '/api/assignments') {
    const data = await readBody(request)
    const current = requireRole(request, 'professional')
    const recipient = accounts.byPairCode(data.patientCode)
    const message = typeof data.message === 'string' ? data.message.trim() : ''
    const ids = Array.isArray(data.modules) ? [...new Set(data.modules)] : []
    if (!recipient) return json(response, 400, { error: 'Confira o código de vínculo com o paciente.' })
    if (message.length > 500 || !ids.length || ids.some(id => typeof id !== 'string')) {
      return json(response, 400, { error: 'Selecione pelo menos um módulo e use até 500 caracteres na orientação.' })
    }
    const row = transaction(db, () => {
      const available = ids.every(id => {
        const module = findModule(current.id, id)
        return module && !module.archived
      })
      if (!available) return null
      const token = newToken()
      createAssignment.run(token, recipient.name, JSON.stringify(ids), message, now(), null, null, '{}', current.id, recipient.id)
      return ownedAssignment.get(token, current.id)
    })
    if (!row) return json(response, 400, { error: 'Selecione apenas módulos disponíveis na sua conta.' })
    return json(response, 201, { assignment: serialize(row) })
  }
  const assignmentMatch = /^\/api\/assignments\/([A-Za-z0-9_-]{32})(?:\/(revoke|link))?$/.exec(path)
  if (assignmentMatch) {
    const [, token, action] = assignmentMatch
    const row = ownedAssignment.get(token, account.id)
    if (!row) return json(response, 404, { error: 'Avaliação não encontrada.' })
    if (method === 'GET' && !action) {
      const assignment = serialize(row, true)
      return json(response, 200, {
        assignment: { ...assignment, answers: undefined, answerCount: Object.keys(assignment.answers).length },
        ...(row.completed_at && { report: projectReport(row) }),
      })
    }
    if (method === 'POST' && action) {
      const data = await readBody(request)
      const current = requireRole(request, 'professional')
      if (action === 'revoke') {
        db.prepare('UPDATE assignments SET revoked_at = COALESCE(revoked_at, ?) WHERE token = ? AND professional_id = ?').run(now(), token, current.id)
      } else {
        const recipient = accounts.byPairCode(data.patientCode)
        if (!recipient) return json(response, 400, { error: 'Confira o código de vínculo com o paciente.' })
        const result = db.prepare(`
          UPDATE assignments SET patient_id = ?
          WHERE token = ? AND professional_id = ? AND patient_id IS NULL AND revoked_at IS NULL
        `).run(recipient.id, token, current.id)
        if (!result.changes) return json(response, 409, { error: 'Esta avaliação já está vinculada ou desativada.' })
      }
      return json(response, 200, { assignment: serialize(ownedAssignment.get(token, current.id)) })
    }
  }
  return json(response, 404, { error: 'Página não encontrada.' })
}

const types = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
}
const appDirectory = fileURLToPath(new URL('.', import.meta.url))
const indexPage = readFileSync(resolve(appDirectory, 'public/index.html'))
const assetRoots = [
  ['/assets/', 'public/assets'],
  ['/fonts/dm-sans/', 'node_modules/@fontsource-variable/dm-sans'],
  ['/fonts/manrope/', 'node_modules/@fontsource-variable/manrope'],
  ['/icons/', 'node_modules/@phosphor-icons/web/src/regular'],
]

function getAsset(path) {
  if (path === '/app.js' || path === '/styles.css') return resolve(appDirectory, 'public', path.slice(1))
  for (const [prefix, folder] of assetRoots) {
    if (!path.startsWith(prefix)) continue
    const name = path.slice(prefix.length)
    if (/^(?:files\/)?[a-z0-9_.-]+$/i.test(name) && types[extname(name)]) return resolve(appDirectory, folder, name)
  }
  return null
}

const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'")
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) return await api(request, response, path)
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Operação indisponível.' })
    if (/^\/(?:avaliacao\/[^/]+\/?|modulos\/?|envios\/?|ajuda\/?|paciente\/?)?$/.test(path)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return response.end(request.method === 'HEAD' ? undefined : indexPage)
    }
    const asset = getAsset(path)
    const info = asset && statSync(asset, { throwIfNoEntry: false })
    if (info?.isFile()) {
      response.writeHead(200, { 'Content-Type': types[extname(asset)], 'Content-Length': info.size })
      if (request.method === 'HEAD') return response.end()
      return createReadStream(asset).on('error', () => response.destroy()).pipe(response)
    }
    return json(response, 404, { error: 'Página não encontrada.' })
  } catch (error) {
    if (!error.status) console.error(error.stack)
    if (!response.headersSent) {
      json(response, error.status || 500, { error: error.status ? error.message : 'Não foi possível concluir. Tente novamente.' },
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {})
    }
  }
})

server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => {
  const { port } = server.address()
  process.parentPort?.postMessage({ port })
  console.log(`Atlas da Mente disponível na porta ${port}${demo ? ' (demonstração)' : ''}`)
})
