const form = document.querySelector('form')
const origin = document.querySelector('#origin')
const error = document.querySelector('#error')
const buttons = Array.from(form.querySelectorAll('button'))

window.atlasSettings.read().then(value => { origin.value = value })

async function save(value) {
  error.textContent = ''
  buttons.forEach(button => { button.disabled = true })
  try {
    const result = await window.atlasSettings.save(value)
    error.textContent = result?.error || ''
  } catch {
    error.textContent = 'Não foi possível salvar esta conexão.'
  } finally {
    buttons.forEach(button => { button.disabled = false })
  }
}

form.addEventListener('submit', event => {
  event.preventDefault()
  if (origin.value.trim()) save(origin.value)
  else error.textContent = 'Informe o endereço ou selecione a demonstração local.'
})
document.querySelector('#demo').addEventListener('click', () => save(''))
