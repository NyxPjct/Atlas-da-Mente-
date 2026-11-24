import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { modules } from '../modules.js'

test('o catálogo oferece oito módulos de vinte questões', () => {
  assert.equal(modules.length, 8)
  assert.equal(new Set(modules.map(module => module.id)).size, 8)
  for (const module of modules) {
    assert.equal(module.questions.length, 20)
    assert.equal(new Set(module.questions.map(question => question.prompt)).size, 20)
    if (module.kind === 'logic') {
      for (const question of module.questions) {
        assert.equal(question.options.length, 4)
        assert.ok(question.options[question.correct])
        assert.ok(question.explanation)
      }
    }
  }
})

async function startAtlas(database, settings = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, ATLAS_DB: database, ATLAS_DEMO: '0', ATLAS_LEGACY_EMAIL: '', ATLAS_PASSWORD: '', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', ...settings },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = once(server, 'exit')
  const [startup] = await Promise.race([once(server.stdout, 'data'), exited])
  const port = /porta (\d+)/.exec(String(startup))?.[1]
  assert.ok(port, 'servidor iniciou')

  return {
    async stop() {
      server.kill()
      await exited
    },
    async api(path, { body, cookie, status = 200 } = {}) {
      const response = await fetch('http://127.0.0.1:' + port + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(cookie && { Cookie: cookie }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json()
      assert.equal(response.status, status, JSON.stringify(data))
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers }
    },
  }
}

const password = 'senha-ficticia-de-teste'
const registration = (name, role, email = name + '@example.net') => ({ name, role, email, password })

test('contas isoladas, progresso, resumo e desativação', { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-test-'))
  const database = join(folder, 'test.sqlite')
  let server
  try {
    server = await startAtlas(database)
    const { api } = server
    await api('/api/dashboard', { status: 401 })
    await api('/api/demo-login', { body: { role: 'professional' }, status: 404 })
    await api('/api/login', { body: { email: 'profissional@example.net', password }, status: 401 })
    const professional = await api('/api/register', { body: registration('Profissional', 'professional', 'profissional@example.net'), status: 201 })
    const otherProfessional = await api('/api/register', { body: registration('Outro', 'professional'), status: 201 })
    const patient = await api('/api/register', { body: registration('Paciente', 'patient'), status: 201 })
    const otherPatient = await api('/api/register', { body: registration('Outra', 'patient'), status: 201 })
    await api('/api/register', { body: registration('Outra Pessoa', 'patient', '  PACIENTE@example.net '), status: 409 })
    const cookieHeader = professional.headers.get('set-cookie')
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookieHeader.includes(flag))
    const cookie = professional.cookie
    const patientCookie = patient.cookie
    const patientCode = patient.data.account.pairCode
    assert.match(patientCode, /^[0-9A-F-]{29}$/)
    assert.notEqual(patientCode, otherPatient.data.account.pairCode)
    assert.equal(professional.data.account.pairCode, undefined)
    await api('/api/dashboard', { cookie: patientCookie, status: 403 })
    await api('/api/patient-dashboard', { cookie, status: 403 })
    await api('/api/assignments', { cookie, status: 400, body: { patientCode, modules: ['toString'] } })
    await api('/api/assignments', { cookie, status: 400, body: { patientCode: 'fake', modules: ['tdah'] } })
    const { data: created } = await api('/api/assignments', {
      cookie, status: 201, body: { patientCode: patientCode.toLowerCase(), modules: ['tdah', 'raciocinio'], message: 'Leia com calma.' },
    })

    const professionalPath = '/api/assignments/' + created.assignment.token
    const patientPath = '/api/patient/' + created.assignment.token
    const innocentDashboard = await api('/api/dashboard', { cookie: otherProfessional.cookie })
    assert.deepEqual(innocentDashboard.data.assignments, [])
    const otherInbox = await api('/api/patient-dashboard', { cookie: otherPatient.cookie })
    assert.deepEqual(otherInbox.data.assignments, [])
    const inbox = await api('/api/patient-dashboard', { cookie: patientCookie })
    assert.equal(inbox.data.assignments[0].token, created.assignment.token)
    assert.equal(inbox.data.assignments[0].professional, 'Profissional')
    assert.equal(inbox.data.assignments[0].answers, undefined)

    await api(professionalPath, { status: 401 })
    await api(professionalPath, { cookie: otherProfessional.cookie, status: 404 })
    await api(professionalPath + '/revoke', { cookie: otherProfessional.cookie, body: {}, status: 404 })
    await api(professionalPath, { cookie: patientCookie, status: 403 })
    await api(patientPath, { status: 401 })
    await api(patientPath, { cookie, status: 403 })
    await api(patientPath, { cookie: otherPatient.cookie, status: 404 })
    await api(patientPath + '/start', { cookie: otherPatient.cookie, body: {}, status: 404 })

    const { data: invitation } = await api(patientPath, { cookie: patientCookie })
    assert.equal(invitation.assignment.message, 'Leia com calma.')
    assert.equal(invitation.sections[1].questions[0].correct, undefined)
    assert.equal(invitation.report, undefined)

    await api(patientPath + '/start', { cookie: patientCookie, body: {} })
    await api(patientPath + '/complete', { cookie: patientCookie, body: {}, status: 409 })
    const example = 'Perdi a etapa após uma interrupção.'
    const first = { frequency: 2, impact: true, example }
    await Promise.all([
      api(patientPath + '/answer', { cookie: patientCookie, body: { moduleId: 'tdah', index: 0, answer: first } }),
      api(patientPath + '/answer', { cookie: patientCookie, body: { moduleId: 'raciocinio', index: 0, answer: { choice: 2 } } }),
    ])
    const { data: inProgress } = await api(professionalPath, { cookie })
    assert.equal(inProgress.assignment.status, 'started')
    assert.equal(inProgress.assignment.answerCount, 2)
    assert.equal(inProgress.assignment.answers, undefined)
    assert.equal(inProgress.report, undefined)

    await server.stop()
    server = undefined
    server = await startAtlas(database)
    const { api: reopened } = server
    const { data: resumed } = await reopened(patientPath, { cookie: patientCookie })
    assert.deepEqual(resumed.assignment.answers, { 'tdah:0': first, 'raciocinio:0': { choice: 2 } })

    for (const moduleId of ['tdah', 'raciocinio']) {
      for (let index = 1; index < 20; index += 1) {
        await reopened(patientPath + '/answer', { cookie: patientCookie, body: { moduleId, index, answer: { skip: true } } })
      }
    }
    const { data: completed } = await reopened(patientPath + '/complete', { cookie: patientCookie, body: {} })
    assert.equal(completed.assignment.status, 'completed')
    assert.equal(completed.report[0].entries[0].answer.example, example)
    assert.equal(completed.report[1].entries[0].correct, 2)

    await reopened(professionalPath + '/revoke', { cookie, body: {} })
    await reopened(patientPath, { cookie: patientCookie, status: 404 })
    const { data: retained } = await reopened(professionalPath, { cookie })
    assert.equal(retained.assignment.status, 'revoked')
    assert.deepEqual(retained.report, completed.report)
    await reopened('/api/logout', { cookie, body: {} })
    await reopened(professionalPath, { cookie, status: 401 })
    const loggedIn = await reopened('/api/login', { body: { email: 'profissional@example.net', password } })
    await reopened(professionalPath, { cookie: loggedIn.cookie })
  } finally {
    if (server) await server.stop()
    await rm(folder, { recursive: true, force: true })
  }
})

test('migração preserva registros e pede vínculo explícito da conta do paciente', { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-legacy-test-'))
  const database = join(folder, 'previous.sqlite')
  const token = 'a'.repeat(32)
  let server
  try {
    const previous = new DatabaseSync(database)
    previous.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY);
      INSERT INTO settings VALUES ('mode_private');
      CREATE TABLE assignments (token TEXT PRIMARY KEY, patient TEXT NOT NULL, modules TEXT NOT NULL, message TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, revoked_at TEXT, answers TEXT NOT NULL DEFAULT '{}');
      INSERT INTO assignments VALUES ('${token}', 'Código anterior', '["tdah"]', 'Orientação anterior', '2026-01-01', '2026-01-01', NULL, NULL,
        '{"tdah:0":{"frequency":3,"impact":true}}');
    `)
    previous.close()
    const email = 'anterior@example.net'
    server = await startAtlas(database, { ATLAS_LEGACY_EMAIL: email, ATLAS_PASSWORD: password })
    const { api } = server
    const owner = await api('/api/login', { body: { email, password } })
    const patient = await api('/api/register', { body: registration('Paciente', 'patient'), status: 201 })
    const second = await api('/api/register', { body: registration('Segunda', 'patient'), status: 201 })
    const professionalPath = '/api/assignments/' + token
    const patientPath = '/api/patient/' + token
    const detail = await api(professionalPath, { cookie: owner.cookie })
    assert.equal(detail.data.assignment.linked, false)
    assert.equal(detail.data.assignment.answerCount, 1)
    await api(patientPath, { cookie: patient.cookie, status: 404 })
    await api(professionalPath + '/link', { cookie: owner.cookie, body: { patientCode: patient.data.account.pairCode } })
    await api(professionalPath + '/link', { cookie: owner.cookie, body: { patientCode: second.data.account.pairCode }, status: 409 })
    const linked = await api(patientPath, { cookie: patient.cookie })
    assert.deepEqual(linked.data.assignment.answers['tdah:0'], { frequency: 3, impact: true })
    assert.equal(linked.data.assignment.message, 'Orientação anterior')
  } finally {
    if (server) await server.stop()
    await rm(folder, { recursive: true, force: true })
  }
})

test('questionário de 20 perguntas fica privado e seus envios sobrevivem ao arquivamento', { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-custom-test-'))
  const database = join(folder, 'custom.sqlite')
  let server
  try {
    server = await startAtlas(database)
    const { api } = server
    const { cookie } = await api('/api/register', { body: registration('Profissional', 'professional'), status: 201 })
    const other = await api('/api/register', { body: registration('Outro', 'professional'), status: 201 })
    const patient = await api('/api/register', { body: registration('Paciente', 'patient'), status: 201 })
    const questions = Array.from({ length: 20 }, (_, index) => ({
      theme: index < 10 ? 'Rotina' : 'Planejamento',
      prompt: `Como foi a atividade ${index + 1}?`,
    }))
    const input = { title: ' Rotina e planejamento ', description: 'Autorrelato', period: 'neste mês', questions }
    await api('/api/questionnaires', { cookie, body: { ...input, questions: questions.slice(1) }, status: 400 })
    await api('/api/questionnaires', {
      cookie, body: { ...input, questions: [questions[1], ...questions.slice(1)] }, status: 400,
    })
    await api('/api/questionnaires', { cookie: patient.cookie, body: input, status: 403 })
    const { data: created } = await api('/api/questionnaires', { cookie, body: input, status: 201 })
    const id = created.module.id
    const assignment = { patientCode: patient.data.account.pairCode, modules: [id] }
    const route = '/api/catalog/' + id
    const template = await api('/api/questionnaires/template', { cookie })
    assert.equal(template.data.questions.length, 20)
    assert.match(template.headers.get('content-disposition'), /^attachment;/)
    assert.equal(created.module.count, 20)
    assert.equal(created.module.title, input.title.trim())
    assert.equal(created.module.questions, undefined)
    assert.deepEqual((await api(route, { cookie })).data.module.questions, questions)
    const exportRoute = '/api/questionnaires/' + id + '/export'
    const exported = await api(exportRoute, { cookie })
    assert.deepEqual(exported.data.questions, questions)
    assert.match(exported.headers.get('content-disposition'), /^attachment;/)
    await api(exportRoute, { cookie: other.cookie, status: 404 })
    await api(route, { cookie: other.cookie, status: 404 })
    await api(route, { cookie: patient.cookie, status: 403 })
    await api('/api/assignments', { cookie: other.cookie, body: assignment, status: 400 })
    const archive = '/api/questionnaires/' + id + '/archive'
    await api(archive, { cookie: other.cookie, body: { archived: true }, status: 404 })

    const { data: sent } = await api('/api/assignments', { cookie, body: assignment, status: 201 })
    const token = sent.assignment.token
    await api(archive, { cookie, body: { archived: true } })
    await api('/api/assignments', { cookie, body: assignment, status: 400 })
    const patientRoute = '/api/patient/' + token
    const patientCookie = patient.cookie
    const { data: inbox } = await api('/api/patient-dashboard', { cookie: patientCookie })
    assert.deepEqual(inbox.catalog.map(module => module.id), [id])
    const { data: received } = await api(patientRoute, { cookie: patientCookie })
    assert.equal(received.sections[0].period, input.period)
    assert.deepEqual(received.sections[0].questions, questions)
    await api(patientRoute + '/start', { cookie: patientCookie, body: {} })
    for (let index = 0; index < 20; index++) {
      const answer = index === 0 ? { frequency: 2, impact: true } : { skip: true }
      await api(patientRoute + '/answer', { cookie: patientCookie, body: { moduleId: id, index, answer } })
    }
    await api(patientRoute + '/complete', { cookie: patientCookie, body: {} })

    await server.stop()
    server = undefined
    server = await startAtlas(database)
    const { api: resumed } = server
    const { data: detail } = await resumed('/api/assignments/' + token, { cookie })
    assert.equal(detail.report[0].entries[0].prompt, questions[0].prompt)
    assert.deepEqual(detail.report[0].entries[0].answer, { frequency: 2, impact: true })
    const { data: professional } = await resumed('/api/dashboard', { cookie })
    assert.equal(professional.catalog.find(module => module.id === id).archived, true)
    await resumed(archive, { cookie, body: { archived: false } })
    await resumed('/api/assignments', { cookie, body: assignment, status: 201 })
  } finally {
    if (server) await server.stop()
    await rm(folder, { recursive: true, force: true })
  }
})
