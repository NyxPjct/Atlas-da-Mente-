import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const passwordWork = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const roles = ['professional', 'patient']
const expirySeconds = 8 * 60 * 60
const dummySalt = randomBytes(16).toString('hex')
const dummyHash = randomBytes(64)
const demoProfiles = {
  professional: { name: 'Dra. Ana Martins', email: 'ana@atlas.example', role: 'professional' },
  patient: { name: 'Mariana Costa', email: 'mariana@atlas.example', role: 'patient' },
}

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const normalizeEmail = input => typeof input === 'string' ? input.trim().toLowerCase() : ''
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
const validPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 128
const newPairCode = () => randomBytes(12).toString('hex').toUpperCase()

function error(status, message) {
  return Object.assign(new Error(message), { status })
}

export function createAccounts(db, { demo, secure }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professional', 'patient')),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      pair_code TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `)

  const byEmail = db.prepare('SELECT * FROM accounts WHERE email = ?')
  const insert = db.prepare('INSERT INTO accounts (name, email, role, salt, password_hash, pair_code) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
  const findPatient = db.prepare("SELECT id, name FROM accounts WHERE role = 'patient' AND pair_code = ?")
  const readSession = db.prepare('SELECT accounts.* FROM sessions JOIN accounts ON accounts.id = account_id WHERE token_hash = ? AND expires_at > ?')
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?')
  const expireSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  const saveSession = db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')

  function profile(account) {
    return account && {
      name: account.name, email: account.email, role: account.role,
      ...(account.pair_code && { pairCode: account.pair_code.match(/.{4}/g).join('-') }),
    }
  }

  function sessionHash(request) {
    const token = /(?:^|;\s*)atlas_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie || '')?.[1]
    return token && createHash('sha256').update(token).digest('hex')
  }

  function current(request) {
    const hash = sessionHash(request)
    return hash ? readSession.get(hash, Date.now()) : undefined
  }

  function cookie(value, maxAge) {
    const production = secure ? '; Secure' : ''
    return `atlas_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production}`
  }

  function startSession(request, account) {
    const token = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('hex')
    const previous = sessionHash(request)
    const time = Date.now()
    transaction(db, () => {
      if (previous) deleteSession.run(previous)
      expireSessions.run(time)
      saveSession.run(hash, account.id, time + expirySeconds * 1000)
    })
    return cookie(token, expirySeconds)
  }

  function signOut(request) {
    const hash = sessionHash(request)
    if (hash) deleteSession.run(hash)
    return cookie('', 0)
  }

  const authWindows = new Map()
  let windowEnd = 0
  let authAttempts = 0
  function throttle(request, email) {
    const time = Date.now()
    if (time >= windowEnd) {
      authWindows.clear()
      windowEnd = time + 600_000
      authAttempts = 0
    }
    const key = JSON.stringify([request.socket.remoteAddress, email])
    const count = authWindows.get(key) || 0
    if (count >= 16 || authAttempts >= 160) {
      const failure = error(429, 'Muitas tentativas. Aguarde alguns minutos.')
      failure.retryAfter = Math.ceil((windowEnd - time) / 1000)
      throw failure
    }
    authWindows.set(key, count + 1)
    authAttempts += 1
  }

  async function register(request, data) {
    const name = typeof data.name === 'string' ? data.name.trim() : ''
    const email = normalizeEmail(data.email)
    const { password, role } = data
    if (name.length < 2 || name.length > 80 || !validEmail(email) || !validPassword(password) || !roles.includes(role)) {
      throw error(400, 'Informe seu nome, e-mail, tipo de conta e uma senha de 12 a 128 caracteres.')
    }
    if (email.endsWith('@atlas.example')) throw error(400, 'Use um e-mail diferente dos exemplos do Atlas.')
    throttle(request, email)
    const duplicate = () => error(409, 'Não foi possível cadastrar esse e-mail. Se já tem conta, entre com sua senha.')
    if (byEmail.get(email)) throw duplicate()
    const salt = randomBytes(16).toString('hex')
    const hash = await derive(password, salt, 64, passwordWork)
    return transaction(db, () => {
      if (byEmail.get(email)) throw duplicate()
      return insert.get(name, email, role, salt, hash.toString('hex'), role === 'patient' ? newPairCode() : null)
    })
  }

  async function login(request, data) {
    const email = normalizeEmail(data.email)
    const { password } = data
    if (!validEmail(email) || !validPassword(password)) throw error(401, 'E-mail ou senha incorretos.')
    throttle(request, email)
    const account = byEmail.get(email)
    const hash = await derive(password, account?.salt || dummySalt, 64, passwordWork)
    if (!timingSafeEqual(hash, account ? Buffer.from(account.password_hash, 'hex') : dummyHash) || !account) {
      throw error(401, 'E-mail ou senha incorretos.')
    }
    return account
  }

  function provision(name, email, role, password) {
    const existing = byEmail.get(email)
    if (existing) {
      if (existing.role !== role || (password && !timingSafeEqual(
        Buffer.from(existing.password_hash, 'hex'), scryptSync(password, existing.salt, 64, passwordWork),
      ))) throw new Error('O e-mail configurado já pertence a outra conta.')
      return existing
    }
    const salt = randomBytes(16).toString('hex')
    const hash = password ? scryptSync(password, salt, 64, passwordWork) : randomBytes(64)
    return insert.get(name, email, role, salt, hash.toString('hex'), role === 'patient' ? newPairCode() : null)
  }

  function demoAccount(role) {
    return demo && Object.hasOwn(demoProfiles, role) ? byEmail.get(demoProfiles[role].email) : undefined
  }

  function seedDemo() {
    for (const { name, email, role } of Object.values(demoProfiles)) provision(name, email, role)
    return { professional: demoAccount('professional'), patient: demoAccount('patient') }
  }

  function legacyOwner(email, password) {
    if (!validEmail(email) || email.endsWith('@atlas.example') || !validPassword(password)) {
      throw new Error('A migração exige ATLAS_LEGACY_EMAIL e a senha profissional anterior em ATLAS_PASSWORD.')
    }
    return provision('Profissional Atlas', email, 'professional', password)
  }

  function byPairCode(input) {
    const code = typeof input === 'string' ? input.replace(/[\s-]/g, '').toUpperCase() : ''
    return /^[0-9A-F]{24}$/.test(code) ? findPatient.get(code) : undefined
  }

  return { profile, current, startSession, signOut, login, register, demoAccount, seedDemo, legacyOwner, byPairCode }
}
