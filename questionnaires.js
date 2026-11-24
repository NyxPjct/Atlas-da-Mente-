import { randomBytes } from 'node:crypto'

export const questionnaireSize = 20
export const defaultPeriod = 'nos últimos três meses'
export const questionnaireTemplate = {
  title: 'Meu questionário', description: '', period: 'nas últimas duas semanas',
  questions: Array.from({ length: questionnaireSize }, () => ({ theme: 'Geral', prompt: '' })),
}

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 })
}

const cleanText = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''

export function validateQuestionnaire(input) {
  const title = cleanText(input.title)
  const description = cleanText(input.description)
  const period = cleanText(input.period) || defaultPeriod
  if (!title || title.length > 80 || description.length > 250 || period.length > 80) {
    invalid('Informe um título de até 80 caracteres, uma descrição de até 250 e um período de até 80.')
  }
  if (!Array.isArray(input.questions) || input.questions.length !== questionnaireSize) {
    invalid(`Inclua exatamente ${questionnaireSize} perguntas.`)
  }
  const seen = new Set()
  const questions = input.questions.map((item, index) => {
    const theme = cleanText(item?.theme) || 'Geral'
    const prompt = cleanText(item?.prompt)
    if (!prompt || prompt.length > 500 || theme.length > 80) {
      invalid(`Revise o item ${index + 1}. Use até 80 caracteres no tema e 500 na pergunta.`)
    }
    const key = prompt.normalize('NFC').toLocaleLowerCase('pt-BR')
    if (seen.has(key)) invalid(`A pergunta ${index + 1} repete um item anterior.`)
    seen.add(key)
    return { theme, prompt }
  })
  return { title, description, period, questions }
}

export function publicModule({ questions, ...module }) {
  return { ...module, count: questions.length }
}

export function patientSection(module) {
  return { ...publicModule(module), questions: module.questions.map(({ theme, prompt, options }) => ({ theme, prompt, options })) }
}

export function questionnaireStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questionnaires (
      id TEXT PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES accounts(id),
      definition TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS questionnaires_owner ON questionnaires(professional_id);
  `)
  const one = db.prepare('SELECT id, definition, archived FROM questionnaires WHERE id = ? AND professional_id = ?')
  const list = db.prepare('SELECT id, definition, archived FROM questionnaires WHERE professional_id = ? ORDER BY rowid DESC')
  const insert = db.prepare('INSERT INTO questionnaires (id, professional_id, definition) VALUES (?, ?, ?)')
  const setArchived = db.prepare('UPDATE questionnaires SET archived = ? WHERE id = ? AND professional_id = ?')

  function read(row) {
    return row && {
      ...JSON.parse(row.definition),
      id: row.id, kind: 'reflection', color: 'purple', icon: 'notebook', custom: true, archived: Boolean(row.archived),
    }
  }

  return {
    get: (owner, id) => read(one.get(id, owner)),
    list: owner => list.all(owner).map(read),
    create(owner, input) {
      const definition = validateQuestionnaire(input)
      const id = 'q-' + randomBytes(18).toString('base64url')
      insert.run(id, owner, JSON.stringify(definition))
      return read(one.get(id, owner))
    },
    archive: (owner, id, archived) => setArchived.run(archived ? 1 : 0, id, owner).changes > 0,
  }
}
