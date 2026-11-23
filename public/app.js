const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const toast = document.querySelector('#toast')

const statusInfo = {
  pending: ['Aguardando', 'clock'],
  started: ['Em andamento', 'hourglass-medium'],
  completed: ['Concluída', 'check-circle'],
  revoked: ['Acesso desativado', 'link-break'],
}
const navigation = [
  ['/', 'Visão geral', 'squares-four'],
  ['/envios', 'Avaliações', 'clipboard-text'],
  ['/modulos', 'Módulos', 'stack'],
]
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Sao_Paulo' })
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 })
const patientMatch = /^\/avaliacao\/([^/]+)\/?$/.exec(location.pathname)
const patientApi = patientMatch && '/api/patient/' + encodeURIComponent(patientMatch[1])
const state = { page: location.pathname.replace(/\/$/, '') || '/', query: '', filter: 'all', active: null, session: null, library: 'atlas' }
let patient
let position = 0
let toastTimer
let pending = false

function e(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

const icon = (name, extra = '') => `<i class="ph ph-${name} ${extra}" aria-hidden="true"></i>`
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
const date = value => value ? dateFormat.format(new Date(value)) : '—'
const moduleById = id => state.data.catalog.find(module => module.id === id)
const assessmentPath = token => '/avaliacao/' + token
const patientLink = token => new URL(assessmentPath(token), location.origin).href
const currentAccount = () => state.session?.account
const demo = () => state.session?.demo
const logoutButton = () => `<button type="button" title="Sair" aria-label="Sair" class="icon-button logout" data-action="logout">${icon('sign-out')}</button>`

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw Object.assign(new Error(error.error || 'Não foi possível carregar os dados.'), { status: response.status })
  }
  return response.json()
}

function showToast(message) {
  clearTimeout(toastTimer)
  toast.innerHTML = `${icon('info')} ${e(message)}`
  toast.classList.add('visible')
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4400)
}

function setApp(html) {
  app.innerHTML = html
  app.setAttribute('aria-busy', 'false')
}

const brand = () => `<a class="brand" href="/" aria-label="Atlas da Mente">${icon('brain', 'brand-icon')}<span>Atlas da Mente</span></a>`
const button = (label, action, glyph, type = 'primary') => `<button class="btn ${type}" type="button" data-action="${action}">${glyph ? icon(glyph) : ''}${label}</button>`
const newButton = () => button('Nova avaliação', 'new', 'plus')
const moduleTag = module => `<span class="module-tag ${module.color}">${e(module.title)}</span>`
const moduleIcon = module => `<span class="tile-icon ${module.color}">${icon(module.icon)}</span>`
const badge = status => `<span class="status ${status}"><span></span>${statusInfo[status][0]}</span>`
const navLink = ([href, label, glyph]) => `<a href="${href}" data-nav class="nav-link ${state.page === href ? 'active' : ''}" ${state.page === href ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`

function professionalShell(content) {
  const pageName = [...navigation, ['/ajuda', 'Central de ajuda']].find(([href]) => href === state.page)?.[1] || 'Visão geral'
  document.title = `${pageName} | Atlas da Mente`
  setApp(`
    <div class="workspace">
      <aside class="sidebar">
        ${brand()}
        <div class="sidebar-content">
          <div class="menu-label">ESPAÇO PROFISSIONAL</div>
          <nav aria-label="Área profissional">${navigation.map(navLink).join('')}</nav>
        </div>
        <div class="sidebar-bottom">
          ${navLink(['/ajuda', 'Central de ajuda', 'question'])}
          <div class="sidebar-profile">
            <span class="avatar profile-avatar">${e(initials(currentAccount().name))}</span>
            <div><strong>${e(currentAccount().name)}</strong><small>Psicologia</small></div>
            ${logoutButton()}
          </div>
        </div>
      </aside>
      <div class="main-frame">
        <header class="topbar">
          <div class="mobile-brand">${brand()}</div>
          <div class="breadcrumb">${icon('house')} <span>Área profissional</span> ${icon('caret-right')} <strong>${pageName}</strong></div>
          <div class="topbar-side">${demo() ? `<span class="demo-tag">${icon('flask')}<span class="demo-label">Demonstração</span><span class="demo-label-short" aria-hidden="true">Demo</span></span>` : ''}
            <div class="mobile-logout">${logoutButton()}</div><a href="/ajuda" data-nav class="icon-button top-help" aria-label="Central de ajuda" title="Central de ajuda">${icon('question')}</a></div>
        </header>
        <main class="main-content" id="main">${content}</main>
      </div>
    </div>`)
}

function stats() {
  const active = state.data.assignments.filter(assignment => assignment.status !== 'revoked')
  return `<div class="stats" aria-label="Resumo das avaliações">${[
    ['Avaliações enviadas', active.length, 'clipboard-text', 'purple'],
    ['Em andamento', active.filter(row => row.status === 'started').length, 'hourglass-medium', 'gold'],
    ['Concluídas', active.filter(row => row.status === 'completed').length, 'check-circle', 'mint'],
    ['Aguardando início', active.filter(row => row.status === 'pending').length, 'clock', 'blue'],
  ].map(([label, count, glyph, color]) => `<div class="stat"><span class="tile-icon ${color}">${icon(glyph)}</span><div><span class="stat-label">${label}</span><strong>${count}</strong></div></div>`).join('')}</div>`
}

function table(assignments, filtered = false) {
  if (!assignments.length) {
    return `<div class="empty">${icon(filtered ? 'magnifying-glass' : 'clipboard-text')}<h3>${filtered ? 'Nenhuma avaliação encontrada' : 'Suas avaliações aparecem aqui'}</h3><p>${filtered ? 'Tente outro nome ou status.' : 'Escolha os módulos e faça seu primeiro envio.'}</p>${filtered ? '' : newButton()}</div>`
  }
  return `<div class="table-wrap"><table role="table" aria-label="Avaliações">
    <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Paciente</th><th role="columnheader" scope="col">Módulos atribuídos</th><th role="columnheader" scope="col">Enviado em</th><th role="columnheader" scope="col">Status</th><th role="columnheader" scope="col"><span class="sr-only">Ações</span></th></tr></thead>
    <tbody role="rowgroup">${assignments.map((row, index) => `<tr role="row">
      <td role="cell"><div class="table-person"><span aria-hidden="true" class="avatar avatar-${index % 5}">${e(initials(row.patient))}</span><strong>${e(row.patient)}</strong></div></td>
      <td role="cell"><div class="table-modules">${row.modules.map(id => moduleTag(moduleById(id))).join('')}</div></td>
      <td role="cell" class="table-date">${date(row.createdAt)}</td>
      <td role="cell" class="table-status">${badge(row.status)}</td>
      <td role="cell" class="table-action"><button class="icon-button row-button" type="button" data-action="detail" data-token="${row.token}" aria-label="Ver avaliação de ${e(row.patient)}" title="Ver avaliação">${icon('arrow-up-right')}</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`
}

function dashboard() {
  const assessments = state.data.assignments.filter(row => row.status !== 'revoked').slice(0, 5)
  professionalShell(`
    <section class="page-heading"><div><h1>Visão geral</h1><p>Acompanhe seus envios e organize as avaliações dos seus pacientes.</p></div>${newButton()}</section>
    <section class="welcome">
      <div class="welcome-content">
        <h2>Olá, ${e(currentAccount().name === 'Dra. Ana Martins' ? 'Dra. Ana' : currentAccount().name.split(/\s+/)[0])}!</h2>
        <p>Escolha os módulos, envie para a conta do paciente e acompanhe as respostas em um só lugar.</p>
        <a href="/modulos" data-nav class="welcome-link">Explorar módulos ${icon('arrow-right')}</a>
      </div>
      <div class="welcome-art" aria-hidden="true"></div>
    </section>
    ${stats()}
    <section class="panel activity">
      <div class="panel-heading"><div><h2>Avaliações recentes</h2><p>Acompanhe o progresso dos seus últimos envios.</p></div><div class="panel-actions">${button('Atualizar', 'refresh', 'arrows-clockwise', 'secondary')}<a href="/envios" data-nav class="btn secondary">Ver todas ${icon('arrow-right')}</a></div></div>
      ${table(assessments)}
    </section>`)
}

function normalized(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function filteredAssignments() {
  return state.data.assignments.filter(row => (state.filter === 'all' || row.status === state.filter)
    && normalized(row.patient).includes(normalized(state.query.trim())))
}

function assessments() {
  professionalShell(`
    <section class="page-heading"><div><h1>Avaliações</h1><p>Acompanhe os envios para seus pacientes e consulte os resumos concluídos.</p></div>${newButton()}</section>
    <section class="panel">
      <div class="toolbar">
        <label class="search">${icon('magnifying-glass')}<span class="sr-only">Buscar paciente</span><input id="search" type="search" placeholder="Buscar por nome ou código" value="${e(state.query)}"></label>
        <label class="select-filter"><span class="sr-only">Filtrar por status</span><select id="status-filter"><option value="all">Todos os status</option>${Object.entries(statusInfo).map(([id, [label]]) => `<option value="${id}" ${id === state.filter ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        ${button('Atualizar', 'refresh', 'arrows-clockwise', 'secondary')}
      </div>
      <div id="assessment-results">${table(filteredAssignments(), Boolean(state.query || state.filter !== 'all'))}</div>
    </section>`)
}

function moduleCards(modules) {
  return `<div class="module-grid">${modules.map(module => `<article class="panel module-card">
    ${moduleIcon(module)}<span class="module-count">${module.count} questões</span>
    <h2>${e(module.title)}</h2>${module.description ? `<p>${e(module.description)}</p>` : ''}
    <button class="text-button" type="button" data-action="module" data-module="${module.id}" aria-label="Ver as ${module.count} questões de ${e(module.title)}">Ver as ${module.count} questões ${icon('arrow-right')}</button>
  </article>`).join('')}</div>`
}

function modulePage() {
  const own = state.library === 'own'
  const available = state.data.catalog.filter(module => Boolean(module.custom) === own && !module.archived)
  const archived = state.data.catalog.filter(module => module.archived)
  professionalShell(`
    <section class="page-heading"><div><h1>Banco de módulos</h1><p>Escolha os questionários para cada avaliação. Cada módulo tem 20 questões.</p></div>${newButton()}</section>
    <div class="library-toolbar"><div class="library-tabs" role="group" aria-label="Origem dos módulos">
      <button class="btn secondary" type="button" data-action="atlas-library" aria-pressed="${!own}">Módulos do Atlas</button>
      <button class="btn secondary" type="button" data-action="own-library" aria-pressed="${own}">Meus questionários</button>
    </div>${button('Importar questionário', 'import', 'upload-simple', 'secondary')}</div>
    ${available.length ? moduleCards(available) : '<section class="panel empty library-empty"><h2>Nenhum questionário ativo</h2><p>Importe um arquivo JSON ou cole uma lista com 20 perguntas.</p></section>'}
    ${own && archived.length ? `<details class="library-archived"><summary>Arquivados (${archived.length})</summary>${moduleCards(archived)}</details>` : ''}
    <div class="notice">${icon('info')}<p>Os questionários do Atlas apoiam a conversa clínica. As respostas de autorrelato mostram frequência, impacto e exemplos. O app não gera diagnóstico nem pontuação de instrumentos padronizados.</p></div>`)
}

function help() {
  professionalShell(`<section class="page-heading"><div><h1>Central de ajuda</h1><p>Como usar o Atlas da Mente com seus pacientes.</p></div></section>
    <section class="panel faq">
      <details open><summary>Como envio uma avaliação?</summary><p>Em <strong>Nova avaliação</strong>, informe o código que o paciente compartilhou e selecione os módulos. A avaliação aparecerá na conta dele. Você também pode enviar o link direto.</p></details>
      <details><summary>O paciente pode voltar depois?</summary><p>Sim. A cada resposta ou questão pulada, salvamos o progresso. A avaliação reabre por <strong>Minhas avaliações</strong> ou pelo link direto, sempre na conta vinculada.</p></details>
      <details><summary>Como interpretar os resultados?</summary><p>Em autorrelato, o percentual mostra a proporção de situações respondidas em que houve impacto. Questões puladas ficam fora do cálculo. Em lógica, o resultado é o total de acertos e as explicações. Use exemplos na consulta para entender contexto e necessidades.</p></details>
      <details><summary>Como encerro o acesso do paciente?</summary><p>Abra a avaliação e selecione <strong>Desativar acesso</strong>. O resumo de uma avaliação concluída continua disponível no painel profissional.</p></details>
    </section>`)
}

function renderProfessional() {
  if (state.page === '/envios') return assessments()
  if (state.page === '/modulos') return modulePage()
  if (state.page === '/ajuda') return help()
  dashboard()
}

function navigate(path, push = true) {
  state.page = path
  if (push) history.pushState(null, '', path)
  renderProfessional()
  window.scrollTo({ top: 0 })
}

async function refreshProfessional() {
  state.data = await request('/api/dashboard')
  renderProfessional()
}

function showDialog(title, body, wide = false) {
  dialog.className = wide ? 'wide-dialog' : ''
  dialog.setAttribute('aria-labelledby', 'dialog-title')
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-button" aria-label="Fechar" data-action="close">${icon('x')}</button></div>${body}`
  if (!dialog.open) dialog.showModal()
  dialog.scrollTop = 0
}

function moduleChoices(modules) {
  return modules.map(module => `<label class="module-choice"><input name="modules" value="${module.id}" type="checkbox">${moduleIcon(module)}<span><strong>${e(module.title)}</strong><small>${e(module.description)}</small></span><small>${module.count} questões</small></label>`).join('')
}

function openNew() {
  const own = state.data.catalog.filter(module => module.custom && !module.archived)
  showDialog('Nova avaliação', `<form id="new-form" class="dialog-body">
    <p class="intro-note">Use o código de vínculo que aparece na conta do paciente.</p>
    ${demo() ? `<div class="notice">${icon('flask')}<p>Esta é uma demonstração. Use somente dados fictícios.</p></div>` : ''}
    ${pairCodeField()}
    <fieldset class="module-picker"><legend>Módulos do Atlas</legend>${moduleChoices(state.data.catalog.filter(module => !module.custom))}</fieldset>
    ${own.length ? `<fieldset class="module-picker"><legend>Meus questionários</legend>${moduleChoices(own)}</fieldset>` : ''}
    <label class="field">Orientação ao paciente <span class="muted">(opcional)</span><textarea name="message" maxlength="500" rows="2" placeholder="Adicione uma orientação para este envio"></textarea></label>
    <p class="form-error" id="new-error" role="alert"></p>
    <div class="dialog-actions">${button('Cancelar', 'close', '', 'secondary')}<button type="submit" class="btn primary">${icon('paper-plane-tilt')} Enviar avaliação</button></div>
  </form>`)
}

function linkPanel(assignment) {
  return `<div class="link-box">
    <label for="patient-link">Link direto da avaliação</label>
    <div class="link-line"><input id="patient-link" readonly value="${e(patientLink(assignment.token))}">${button('Copiar link', 'copy', 'copy', 'secondary')}</div>
    <p>Somente a conta do paciente vinculado pode abrir a avaliação.</p>
  </div>`
}

const pairCodeField = () => `<label class="field">Código de vínculo do paciente<input name="patientCode" required maxlength="40" placeholder="Cole o código do paciente" autocomplete="off" spellcheck="false"></label>`

function showCreated(assignment) {
  showDialog('Avaliação enviada', `<div class="dialog-body">
    <div class="notice success">${icon('check-circle')}<p>A avaliação já aparece na conta de <strong>${e(assignment.patient)}</strong>.</p></div>
    ${linkPanel(assignment)}
    <div class="dialog-actions">${button('Concluir', 'close', 'check')}</div>
  </div>`)
}

function legacyLinkPanel() {
  return `<form id="link-form" class="link-box">
    <p>Esta avaliação foi criada antes das contas. Confirme a identidade do paciente antes de vincular o acesso.</p>
    ${pairCodeField()}
    <p class="form-error" id="link-error" role="alert"></p>
    <button class="btn secondary" type="submit">${icon('link')} Vincular conta</button>
  </form>`
}

function reportSection(module, frequencies) {
  const answered = module.entries.filter(entry => entry.answer && !entry.answer.skip)
  const isLogic = module.kind === 'logic'
  const total = answered.filter(entry => isLogic ? entry.answer.choice === entry.correct : entry.answer.impact).length
  const themes = [...new Set(module.entries.map(entry => entry.theme))]
  return `<section class="report-module">
    <div class="report-title">${moduleIcon(module)}<div><h3>${e(module.title)}</h3><p>${answered.length} de ${module.entries.length} respondidas · ${module.entries.length - answered.length} puladas</p></div></div>
    <div class="report-highlight">
      <strong>${isLogic ? `${total} / ${module.entries.length}` : answered.length ? percent.format(total / answered.length) : '—'}</strong>
      <span>${isLogic ? 'acertos no conjunto de desafios' : answered.length ? `Impacto relatado em ${total} de ${answered.length} situações respondidas` : 'Nenhuma situação respondida para calcular impacto'}</span>
    </div>
    ${!isLogic ? `<ul class="theme-list">${themes.map(theme => {
      const subset = answered.filter(entry => entry.theme === theme)
      const impactCount = subset.filter(entry => entry.answer.impact).length
      return `<li><span>${e(theme)}</span><strong>${subset.length ? `${impactCount} de ${subset.length} com impacto` : 'Sem respostas'}</strong></li>`
    }).join('')}</ul>` : ''}
    <details class="answer-details"><summary>${isLogic ? 'Ver respostas e gabarito comentado' : 'Ver respostas por questão'}</summary>
      <ol>${module.entries.map(entry => `<li><strong>${e(entry.prompt)}</strong>
        <p>${!entry.answer || entry.answer.skip ? 'Questão pulada' : isLogic ? e(entry.options[entry.answer.choice]) : `${e(frequencies[entry.answer.frequency])} · ${entry.answer.impact ? 'Com impacto relatado' : 'Sem impacto relatado'}`}</p>
        ${isLogic ? `<p><strong>Resposta esperada:</strong> ${e(entry.options[entry.correct])}. ${e(entry.explanation)}</p>` : ''}
        ${entry.answer?.example ? `<p><strong>Exemplo relatado:</strong> ${e(entry.answer.example)}</p>` : ''}</li>`).join('')}</ol>
    </details>
  </section>`
}

function reportContent(report, frequencies) {
  return `${report.map(module => reportSection(module, frequencies)).join('')}
    <div class="notice"><p>O resumo descreve as respostas deste envio. Os resultados não geram diagnóstico nem estimativa de QI. Se alguma situação causa sofrimento ou atrapalha sua rotina, converse com o profissional que enviou a avaliação.</p></div>`
}

async function showDetail(token) {
  const data = await request('/api/assignments/' + token)
  state.active = data
  const { assignment, report } = data
  const answerCount = assignment.answerCount
  const total = assignment.modules.reduce((sum, id) => sum + moduleById(id).count, 0)
  showDialog(`Avaliação de ${e(assignment.patient)}`, `<div class="dialog-body">
    <div class="detail-meta">${badge(assignment.status)}<span>Enviada em ${date(assignment.createdAt)}</span>${assignment.completedAt ? `<span>Concluída em ${date(assignment.completedAt)}</span>` : ''}</div>
    ${report ? reportContent(report, state.data.frequencies) : `
      <div class="detail-modules">${assignment.modules.map(id => moduleTag(moduleById(id))).join('')}</div>
      <div class="detail-progress"><label for="detail-progress">${answerCount} de ${total} questões vistas</label><progress id="detail-progress" max="${total}" value="${answerCount}"></progress></div>`}
    ${assignment.status !== 'revoked' ? (assignment.linked ? linkPanel(assignment) : legacyLinkPanel()) : ''}
    <div class="dialog-actions spaced">
      ${assignment.status !== 'revoked' ? button('Desativar acesso', 'confirm-revoke', 'link-break', 'danger-ghost') : '<span></span>'}
      ${report ? button('Imprimir resumo', 'print', 'printer', 'secondary') : ''}
    </div>
  </div>`, Boolean(report))
}

async function showModule(id) {
  const { module } = await request('/api/catalog/' + id)
  showDialog(e(module.title), `<div class="dialog-body">
    <p class="intro-note">${module.questions.length} questões${module.description ? ' · ' + e(module.description) : ''}${module.period ? ' · ' + e(module.period) : ''}</p>
    ${module.archived ? '<div class="notice"><p>Arquivado para novos envios. As avaliações anteriores mantêm o questionário.</p></div>' : ''}
    ${module.custom ? `<div class="library-controls" data-module="${module.id}" data-archived="${module.archived}">
      ${button('Exportar JSON', 'export-module', 'download-simple', 'secondary')}
      ${button(module.archived ? 'Reativar' : 'Arquivar', 'archive-module', module.archived ? 'arrow-counter-clockwise' : 'archive', 'secondary')}
    </div>` : ''}
    <ol class="question-list">${module.questions.map(question => `<li><span class="module-tag ${module.color}">${e(question.theme)}</span><p>${e(question.prompt)}</p></li>`).join('')}</ol>
  </div>`, true)
}

function openImport() {
  showDialog('Importar questionário', `<form id="import-form" class="dialog-body">
    <p class="intro-note">Crie um questionário de frequência e impacto com exatamente 20 perguntas. Cole uma lista ou envie um arquivo JSON.</p>
    <fieldset class="account-roles"><legend>Como você quer importar?</legend>
      <label class="radio-option"><input type="radio" name="source" value="text" checked> Colar perguntas</label>
      <label class="radio-option"><input type="radio" name="source" value="file"> Arquivo JSON</label>
    </fieldset>
    <fieldset class="import-fields" data-import-source="text">
      <label class="field">Título<input name="title" required maxlength="80" placeholder="Ex.: Organização da rotina"></label>
      <label class="field">Descrição <span class="muted">(opcional)</span><input name="description" maxlength="250"></label>
      <label class="field">Período de referência <span class="muted">(opcional)</span><input name="period" maxlength="80" placeholder="Ex.: nas últimas duas semanas"></label>
      <label class="field">Perguntas <small id="import-hint">Cole uma por linha. Para agrupar por tema, use “Tema | Pergunta”.</small>
        <textarea name="questions" required maxlength="14000" rows="7" aria-describedby="import-hint"></textarea>
      </label>
    </fieldset>
    <fieldset class="import-fields" data-import-source="file" hidden disabled>
      <label class="field">Arquivo JSON<input name="file" type="file" accept=".json,application/json" required></label>
      ${button('Baixar modelo JSON', 'import-template', 'download-simple', 'secondary')}
    </fieldset>
    <p class="form-error" id="import-error" role="alert"></p>
    <div class="dialog-actions">${button('Cancelar', 'close', '', 'secondary')}<button class="btn primary" type="submit">${icon('upload-simple')} Importar</button></div>
  </form>`)
}

async function importContent(data) {
  if (data.get('source') === 'file') {
    const file = data.get('file')
    if (!file?.size || file.size > 65_536) throw new Error('Selecione um arquivo JSON de até 64 KB.')
    try {
      return JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('O arquivo não contém JSON válido.')
    }
  }
  const questions = data.get('questions').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const split = line.indexOf(' | ')
    return split < 0 ? { prompt: line } : { theme: line.slice(0, split), prompt: line.slice(split + 3) }
  })
  return { title: data.get('title'), description: data.get('description'), period: data.get('period'), questions }
}

function downloadQuestionnaire({ title, description, period, questions }, filename) {
  const blob = new Blob([JSON.stringify({ title, description, period, questions }, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function login(register = false) {
  document.title = `${register ? 'Criar conta' : 'Entrar'} | Atlas da Mente`
  setApp(`<main class="access-shell">
    <header class="access-header">${brand()}${demo() ? `<span class="demo-tag">${icon('flask')} Demonstração</span>` : ''}</header>
    <div class="access-layout">
      <section class="access-welcome"><h1>Avaliações e respostas em um só lugar</h1><p>Psicólogos enviam os módulos e acompanham o progresso. Pacientes respondem e consultam seus resumos na própria conta.</p><div class="access-art" aria-hidden="true"></div></section>
      <section class="panel access-card">
        <h2>${register ? 'Crie sua conta' : 'Entre na sua conta'}</h2>
        <p>${patientApi ? 'Use a conta de paciente vinculada a esta avaliação.' : register ? 'Escolha como você vai usar o Atlas da Mente.' : 'Acesse seu painel com e-mail e senha.'}</p>
        <form id="${register ? 'register-form' : 'login-form'}" class="access-form">
          ${register ? `<fieldset class="account-roles"><legend>Tipo de conta</legend>
            <label class="radio-option"><input required name="role" type="radio" value="professional" ${patientApi ? '' : 'checked'}> Psicólogo</label>
            <label class="radio-option"><input required name="role" type="radio" value="patient" ${patientApi ? 'checked' : ''}> Paciente</label></fieldset>
            <label class="field">Nome<input required name="name" autocomplete="name" minlength="2" maxlength="80"></label>` : ''}
          <label class="field">E-mail<input required name="email" type="email" autocomplete="username" maxlength="254"></label>
          <label class="field">Senha<input required name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="12"' : ''} maxlength="128">${register ? '<small>Use pelo menos 12 caracteres.</small>' : ''}</label>
          <p class="form-error" id="login-error" role="alert"></p>
          <button class="btn primary" type="submit">${register ? 'Criar conta' : 'Entrar'} ${icon('arrow-right')}</button>
        </form>
        <p class="access-switch">${register ? 'Já tem conta?' : 'Primeira vez no Atlas?'} <button class="text-button" type="button" data-action="${register ? 'show-login' : 'show-register'}">${register ? 'Entrar' : 'Criar conta'}</button></p>
        ${demo() && !register ? `<section class="demo-access"><h3>Testar com contas fictícias</h3><p>Os perfis de demonstração são compartilhados. Use apenas dados fictícios.</p><div>${button('Psicólogo demo', 'demo-professional', 'stethoscope', 'secondary')}${button('Paciente demo', 'demo-patient', 'user', 'secondary')}</div></section>` : ''}
      </section>
    </div>
  </main>`)
}

function patientShell(content) {
  document.title = `${patientApi ? 'Sua avaliação' : 'Minhas avaliações'} | Atlas da Mente`
  setApp(`<div class="patient-shell"><header class="patient-header">
    ${brand()}<div class="patient-header-actions">${patientApi && currentAccount()?.role === 'patient' ? '<a href="/paciente" class="text-button">Minhas avaliações</a>' : ''}${currentAccount() ? logoutButton() : ''}</div>
    </header><main class="patient-content">${demo() ? `<div class="notice demo-notice">${icon('flask')}<p>Demonstração. Use apenas informações fictícias.</p></div>` : ''}${content}</main></div>`)
}

async function patientDashboard() {
  const { catalog, assignments } = await request('/api/patient-dashboard')
  const account = currentAccount()
  patientShell(`
    <section class="page-heading patient-heading"><div><h1>Minhas avaliações</h1><p>Olá, ${e(account.name)}. Veja o que seu psicólogo enviou.</p></div>${button('Atualizar', 'patient-refresh', 'arrows-clockwise', 'secondary')}</section>
    <section class="panel pairing-card">
      <span class="tile-icon purple">${icon('link')}</span><div><h2>Código de vínculo</h2><p>Compartilhe este código com seu psicólogo para receber avaliações nesta conta.</p>
      <div class="pairing-code"><label class="sr-only" for="pair-code">Seu código de vínculo</label><input id="pair-code" readonly value="${e(account.pairCode)}">${button('Copiar código', 'copy-pair', 'copy', 'secondary')}</div></div>
    </section>
    <section class="patient-inbox" aria-label="Avaliações recebidas">
      ${assignments.length ? assignments.map(assignment => `<article class="panel inbox-card">
        <div class="inbox-top"><div><h2>${e(assignment.professional)}</h2><p>Enviada em ${date(assignment.createdAt)}</p></div>${badge(assignment.status)}</div>
        <div class="detail-modules">${assignment.modules.map(id => {
          const module = catalog.find(item => item.id === id)
          return moduleTag(module)
        }).join('')}</div>
        <a href="${assessmentPath(assignment.token)}" class="btn secondary">${assignment.status === 'completed' ? 'Ver resumo' : assignment.status === 'started' ? 'Continuar' : 'Abrir avaliação'} ${icon('arrow-right')}</a>
      </article>`).join('') : '<div class="panel empty"><h2>Nenhuma avaliação recebida</h2><p>Quando seu psicólogo enviar uma avaliação, ela aparecerá aqui.</p></div>'}
    </section>`)
}

async function routeAccount() {
  const account = currentAccount()
  if (!account) return login()
  if (patientApi) {
    if (account.role !== 'patient') {
      return showFailure({ status: 403, message: 'Saia desta conta e entre com a conta de paciente vinculada à avaliação.' })
    }
    try {
      return await startPatient()
    } catch (error) {
      if (error.status !== 404) throw error
      return showFailure(error)
    }
  }
  if (account.role === 'patient') {
    if (state.page !== '/paciente') {
      history.replaceState(null, '', '/paciente')
      state.page = '/paciente'
    }
    return patientDashboard()
  }
  if (state.page === '/paciente') {
    history.replaceState(null, '', '/')
    state.page = '/'
  }
  return refreshProfessional()
}

function questionPositions() {
  return patient.sections.flatMap(module => module.questions.map((question, index) => ({ module, question, index })))
}

function patientIntro() {
  patientShell(`<section class="panel patient-card">
    <span class="tile-icon purple">${icon('hand-waving')}</span>
    <h1>Olá, ${e(patient.assignment.patient)}!</h1>
    <p>Seu psicólogo preparou esta avaliação. Você pode responder no seu ritmo e voltar pela sua conta quando precisar.</p>
    ${patient.assignment.message ? `<div class="notice"><div><strong>Orientação do profissional</strong><p>${e(patient.assignment.message)}</p></div></div>` : ''}
    <h2>Módulos da sua avaliação</h2><ul class="patient-modules">${patient.sections.map(module => `<li>${moduleIcon(module)}<div><strong>${e(module.title)}</strong><small>${e(module.description)}</small></div><span>${module.questions.length} questões</span></li>`).join('')}</ul>
    <p class="muted">Suas respostas ficam disponíveis ao profissional que enviou a avaliação após a conclusão. Você pode pular qualquer questão.</p>
    ${button('Iniciar avaliação', 'patient-start', 'arrow-right')}
    <p class="form-error" id="patient-error" role="alert"></p>
  </section>`)
}

const radio = (name, value, label, checked) => `<label class="radio-option"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span>${e(label)}</span></label>`

function patientQuestion() {
  const positions = questionPositions()
  if (position >= positions.length) {
    const visited = Object.keys(patient.assignment.answers).length
    patientShell(`<section class="panel patient-card"><span class="tile-icon mint">${icon('list-checks')}</span><h1>Pronto para enviar?</h1>
      <p>Você passou por ${visited} de ${positions.length} questões. Depois de concluir, poderá consultar o resumo na sua conta.</p>
      <p class="form-error" id="patient-error" role="alert"></p><div class="patient-actions">${button('Revisar', 'patient-back', 'arrow-left', 'secondary')}${button('Concluir avaliação', 'patient-complete', 'check')}</div></section>`)
    return
  }
  const { module, question, index } = positions[position]
  const answer = patient.assignment.answers[`${module.id}:${index}`]
  const visited = Object.keys(patient.assignment.answers).length
  patientShell(`
    <div class="progress-card"><div><strong>${e(module.title)}</strong><span>Questão ${position + 1} de ${positions.length}</span></div><progress max="${positions.length}" value="${visited}" aria-label="${visited} de ${positions.length} questões registradas"></progress></div>
    <section class="panel patient-card question-card">
      <span class="module-tag ${module.color}">${e(question.theme)}</span>
      <h1>${e(question.prompt)}</h1>
      <form id="patient-form">
      ${module.kind === 'logic' ? `<fieldset class="answer-options"><legend class="sr-only">Opções de resposta</legend>${question.options.map((option, optionIndex) => radio('choice', optionIndex, option, answer?.choice === optionIndex)).join('')}</fieldset>` : `
        <p class="muted">Pense em como isso ocorreu ${e(module.period || 'nos últimos três meses')}.</p>
        <fieldset class="answer-options"><legend class="sr-only">Frequência</legend>${patient.frequencies.map((option, optionIndex) => radio('frequency', optionIndex, option, answer?.frequency === optionIndex)).join('')}</fieldset>
        <fieldset class="answer-options impact-options"><legend>Isso dificultou sua rotina ou suas relações nesse período?</legend>${radio('impact', 'yes', 'Sim', answer?.impact === true)}${radio('impact', 'no', 'Não', answer?.impact === false)}</fieldset>
        <details class="example-details" ${answer?.example ? 'open' : ''}><summary>Adicionar exemplo (opcional)</summary><label class="field">Conte o que aconteceu e o que ajudou ou dificultou.<textarea name="example" rows="2" maxlength="500">${e(answer?.example)}</textarea></label></details>`}
      <p class="form-error" id="patient-error" role="alert"></p>
      <div class="patient-actions"><div>${position > 0 ? button('Voltar', 'patient-back', 'arrow-left', 'secondary') : ''}</div>
        <div>${button('Pular', 'patient-skip', '', 'ghost')}<button type="submit" class="btn primary">Continuar ${icon('arrow-right')}</button></div></div>
      </form>
    </section>`)
}

function patientSummary() {
  patientShell(`<section class="panel patient-card patient-report">
    <span class="tile-icon mint">${icon('check-circle')}</span>
    <h1>Avaliação concluída</h1><p>O profissional já pode consultar suas respostas. Veja o seu resumo abaixo.</p>
    ${reportContent(patient.report, patient.frequencies)}
    <div class="patient-actions">${button('Imprimir resumo', 'print', 'printer', 'secondary')}</div>
  </section>`)
}

async function startPatient() {
  patient = await request(patientApi)
  if (patient.assignment.completedAt) return patientSummary()
  if (!patient.assignment.startedAt) return patientIntro()
  const positions = questionPositions()
  const next = positions.findIndex(({ module, index }) => !patient.assignment.answers[`${module.id}:${index}`])
  position = next < 0 ? positions.length : next
  patientQuestion()
}

function movePatient(next) {
  position = next
  patientQuestion()
  window.scrollTo({ top: 0 })
  const heading = document.querySelector('.patient-card h1')
  heading.setAttribute('tabindex', '-1')
  heading.focus({ preventScroll: true })
}

async function savePatientAnswer(answer) {
  const { module, index } = questionPositions()[position]
  const result = await request(patientApi + '/answer', { moduleId: module.id, index, answer })
  patient.assignment.answers = result.answers
  movePatient(position + 1)
}

function showFailure(error) {
  const content = `<section class="panel patient-card"><span class="tile-icon purple">${icon('warning-circle')}</span><h1>${[403, 404].includes(error.status) ? 'Avaliação indisponível' : 'Não foi possível abrir'}</h1><p>${e(error.message)}</p>${[403, 404].includes(error.status) ? `<a href="/" class="btn secondary">${icon('arrow-left')} Voltar ao painel</a>` : button('Tentar novamente', 'reload', 'arrow-clockwise')}</section>`
  if (patientApi) patientShell(content)
  else setApp(`<main class="standalone-shell">${brand()}${content}</main>`)
}

function setError(id, message) {
  const field = document.getElementById(id)
  if (field) field.textContent = message
  else showToast(message)
}

async function perform(control, operation, errorId) {
  if (pending) return
  pending = true
  if (control) control.disabled = true
  try {
    await operation()
  } catch (error) {
    if (error.status === 401 && errorId !== 'login-error') {
      if (dialog.open) dialog.close()
      state.session.account = null
      state.data = null
      state.active = null
      patient = null
      login()
      showToast(error.message)
    } else setError(errorId, error.message)
  } finally {
    pending = false
    if (control) control.disabled = false
  }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]')
  if (nav && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    navigate(nav.getAttribute('href'))
    return
  }
  const control = event.target.closest('[data-action]')
  if (!control) return
  const { action, token, module } = control.dataset
  if (action === 'show-register') login(true)
  if (action === 'show-login') login()
  if (action === 'demo-professional' || action === 'demo-patient') await perform(control, async () => {
    state.session = await request('/api/demo-login', { role: action.slice(5) })
    await routeAccount()
  }, 'login-error')
  if (action === 'patient-refresh') await perform(control, async () => {
    await patientDashboard()
    document.querySelector('[data-action="patient-refresh"]')?.focus()
    showToast('Avaliações atualizadas.')
  })
  if (action === 'new') openNew()
  if (action === 'close') dialog.close()
  if (action === 'reload') location.reload()
  if (action === 'print') window.print()
  if (action === 'refresh') await perform(control, async () => {
    await refreshProfessional()
    document.querySelector('[data-action="refresh"]')?.focus()
    showToast('Avaliações atualizadas.')
  })
  if (action === 'atlas-library' || action === 'own-library') {
    state.library = action === 'own-library' ? 'own' : 'atlas'
    modulePage()
    document.querySelector(`[data-action="${action}"]`)?.focus()
  }
  if (action === 'import') openImport()
  if (action === 'import-template') downloadQuestionnaire({
    title: 'Meu questionário', description: '', period: 'nas últimas duas semanas',
    questions: Array.from({ length: 20 }, () => ({ theme: 'Geral', prompt: '' })),
  }, 'atlas-modelo-questionario.json')
  if (action === 'module') await perform(control, () => showModule(module))
  if (action === 'export-module') await perform(control, async () => {
    const { module: id } = control.closest('.library-controls').dataset
    const { module: questionnaire } = await request('/api/catalog/' + id)
    downloadQuestionnaire(questionnaire, `atlas-${id}.json`)
  })
  if (action === 'archive-module') await perform(control, async () => {
    const { module: id, archived } = control.closest('.library-controls').dataset
    const result = await request('/api/questionnaires/' + id + '/archive', { archived: archived === 'false' })
    await refreshProfessional()
    await showModule(id)
    showToast(result.archived ? 'Questionário arquivado. Os envios anteriores continuam disponíveis.' : 'Questionário disponível para novos envios.')
  })
  if (action === 'detail') await perform(control, () => showDetail(token))
  if (action === 'logout') await perform(control, async () => {
    await request('/api/logout', {})
    if (dialog.open) dialog.close()
    state.session.account = null
    state.data = null
    state.active = null
    state.library = 'atlas'
    patient = null
    login()
  })
  if (action === 'confirm-revoke') {
    showDialog('Desativar acesso?', `<div class="dialog-body"><p>${e(state.active.assignment.patient)} perderá o acesso a esta avaliação na conta e pelo link direto.</p><div class="dialog-actions">${button('Voltar', 'revoke-back', '', 'secondary')}${button('Desativar acesso', 'revoke', 'link-break', 'danger')}</div></div>`)
  }
  if (action === 'revoke-back') await perform(control, () => showDetail(state.active.assignment.token))
  if (action === 'revoke') await perform(control, async () => {
    const token = state.active.assignment.token
    await request('/api/assignments/' + token + '/revoke', {})
    await refreshProfessional()
    await showDetail(token)
    showToast('Acesso desativado.')
  })
  if (action === 'copy' || action === 'copy-pair') {
    const input = document.querySelector(action === 'copy' ? '#patient-link' : '#pair-code')
    try {
      await navigator.clipboard.writeText(input.value)
      showToast(action === 'copy' ? 'Link copiado.' : 'Código copiado.')
    } catch {
      input.select()
      showToast('Use o comando de copiar do seu dispositivo.')
    }
  }
  if (action === 'patient-start') await perform(control, async () => {
    const { assignment } = await request(patientApi + '/start', {})
    patient.assignment = assignment
    const next = questionPositions().findIndex(({ module, index }) => !assignment.answers[`${module.id}:${index}`])
    movePatient(next < 0 ? questionPositions().length : next)
  }, 'patient-error')
  if (action === 'patient-back' && !pending) movePatient(Math.max(0, position - 1))
  if (action === 'patient-skip') await perform(control, () => savePatientAnswer({ skip: true }), 'patient-error')
  if (action === 'patient-complete') await perform(control, async () => {
    Object.assign(patient, await request(patientApi + '/complete', {}))
    patientSummary()
    window.scrollTo({ top: 0 })
  }, 'patient-error')
})

document.addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  const data = new FormData(form)
  if (form.id === 'new-form') {
    if (!data.getAll('modules').length) return setError('new-error', 'Selecione pelo menos um módulo.')
    await perform(event.submitter, async () => {
      const result = await request('/api/assignments', {
        patientCode: data.get('patientCode'), modules: data.getAll('modules'), message: data.get('message'),
      })
      showCreated(result.assignment)
      await refreshProfessional()
    }, 'new-error')
  }
  if (form.id === 'import-form') await perform(event.submitter, async () => {
    const content = await importContent(data)
    const { module } = await request('/api/questionnaires', content)
    state.library = 'own'
    await refreshProfessional()
    await showModule(module.id)
  }, 'import-error')
  if (form.id === 'link-form') await perform(event.submitter, async () => {
    const token = state.active.assignment.token
    await request('/api/assignments/' + token + '/link', { patientCode: data.get('patientCode') })
    await refreshProfessional()
    await showDetail(token)
    showToast('Conta vinculada.')
  }, 'link-error')
  if (form.id === 'login-form' || form.id === 'register-form') await perform(event.submitter, async () => {
    const path = form.id === 'register-form' ? '/api/register' : '/api/login'
    state.session = await request(path, Object.fromEntries(data))
    await routeAccount()
  }, 'login-error')
  if (form.id === 'patient-form') {
    const { module } = questionPositions()[position]
    const valid = module.kind === 'logic' ? data.has('choice') : data.has('frequency') && data.has('impact')
    if (!valid) return setError('patient-error', 'Selecione as opções ou pule esta questão.')
    const answer = module.kind === 'logic' ? { choice: Number(data.get('choice')) }
      : { frequency: Number(data.get('frequency')), impact: data.get('impact') === 'yes', example: data.get('example') }
    await perform(event.submitter, () => savePatientAnswer(answer), 'patient-error')
  }
})

function updateResults() {
  document.querySelector('#assessment-results').innerHTML = table(filteredAssignments(), Boolean(state.query || state.filter !== 'all'))
}

document.addEventListener('input', event => {
  if (event.target.id !== 'search') return
  state.query = event.target.value
  updateResults()
})
document.addEventListener('change', event => {
  if (event.target.matches('#import-form input[name="source"]')) {
    for (const group of dialog.querySelectorAll('[data-import-source]')) {
      const inactive = group.dataset.importSource !== event.target.value
      group.hidden = inactive
      group.disabled = inactive
    }
    setError('import-error', '')
  }
  if (event.target.matches('#patient-form input[type="radio"]')) {
    setError('patient-error', '')
  }
  if (event.target.id === 'status-filter') {
    state.filter = event.target.value
    updateResults()
  }
})
window.addEventListener('popstate', () => {
  if (patientApi || !state.data) return
  navigate(location.pathname.replace(/\/$/, '') || '/', false)
})

try {
  state.session = await request('/api/session')
  await routeAccount()
} catch (error) {
  showFailure(error)
}
