import * as E from 'src/enums'

type SuggestStatus = 'ok' | 'unsupported' | 'permission_denied' | 'no_candidates' | 'error'

interface SuggestedTab {
  id: ID
  title: string
  url: string
  similarity: number
  favIconUrl?: string
}

interface SuggestedGroup {
  key: string
  title: string
  similarity: number
  tabs: SuggestedTab[]
}

interface SuggestGroupsResult {
  status: SuggestStatus
  panelName?: string
  groups?: SuggestedGroup[]
}

interface CreateGroupResult {
  status: 'ok' | 'error'
  moved: number
}

interface GroupCard {
  data: SuggestedGroup
  cardEl: HTMLDivElement
  listEl: HTMLDivElement
  titleInputEl: HTMLInputElement
  createBtnEl: HTMLButtonElement
}

const MSG_ROOT = 'ai_groups_'

let winId = -1
let panelId: ID = ''
let inProgress = false
const cardsByKey = new Map<string, GroupCard>()

let titleEl: HTMLElement | null
let refreshBtnEl: HTMLButtonElement | null
let statusEl: HTMLElement | null
let groupsEl: HTMLElement | null

function msg(key: string, substitutions?: string | string[]): string {
  const out = browser.i18n.getMessage(MSG_ROOT + key, substitutions)
  return out || key
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text
}

function parseParams(): boolean {
  const info = new URL(location.href)
  const parsedWinId = Number(info.searchParams.get('winId') ?? '')
  const parsedPanelIdRaw = info.searchParams.get('panelId')
  if (!Number.isFinite(parsedWinId) || parsedWinId < 0 || !parsedPanelIdRaw) return false

  const parsedPanelIdNum = Number(parsedPanelIdRaw)
  const parsedPanelId: ID = Number.isFinite(parsedPanelIdNum) ? parsedPanelIdNum : parsedPanelIdRaw

  winId = parsedWinId
  panelId = parsedPanelId
  return true
}

async function sidebarRequest<T>(action: string, ...args: unknown[]): Promise<T> {
  return browser.runtime.sendMessage({
    dstType: E.InstanceType.sidebar,
    dstWinId: winId,
    action,
    args,
  }) as Promise<T>
}

function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)))
  return `${percent}%`
}

function getSelectedIds(card: GroupCard): ID[] {
  const selected: ID[] = []
  const checks = card.listEl.querySelectorAll<HTMLInputElement>('.card-check')
  for (const check of checks) {
    if (!check.checked) continue
    const id = Number(check.value)
    if (Number.isFinite(id)) selected.push(id)
  }
  return selected
}

function updateCreateButtonLabel(card: GroupCard): void {
  const selected = getSelectedIds(card).length
  card.createBtnEl.textContent =
    selected > 0 ? `${msg('create_btn')} (${selected})` : msg('create_btn')
  card.createBtnEl.disabled = selected === 0 || inProgress
}

function createTabRow(card: GroupCard, tab: SuggestedTab): HTMLLabelElement {
  const row = document.createElement('label')
  row.className = 'card-row is-selected'
  row.title = tab.url

  const check = document.createElement('input')
  check.className = 'card-check'
  check.type = 'checkbox'
  check.value = String(tab.id)
  check.checked = true

  const main = document.createElement('div')
  main.className = 'row-main'

  const fav = document.createElement('img')
  fav.className = 'row-fav'
  fav.alt = ''
  fav.src = tab.favIconUrl || 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

  const title = document.createElement('div')
  title.className = 'row-title'
  title.textContent = tab.title || tab.url

  const url = document.createElement('div')
  url.className = 'row-url'
  url.textContent = tab.url

  const score = document.createElement('div')
  score.className = 'row-score'
  score.textContent = formatPercent(tab.similarity)

  check.addEventListener('change', () => {
    row.classList.toggle('is-selected', check.checked)
    updateCreateButtonLabel(card)
  })

  main.append(title, url)
  row.append(check, fav, main, score)

  return row
}

async function onCreateGroup(card: GroupCard): Promise<void> {
  if (inProgress) return

  const selectedIds = getSelectedIds(card)
  if (!selectedIds.length) {
    setStatus(msg('select_one'))
    updateCreateButtonLabel(card)
    return
  }

  inProgress = true
  if (refreshBtnEl) refreshBtnEl.disabled = true
  setStatus(msg('creating'))

  card.createBtnEl.disabled = true
  card.titleInputEl.disabled = true
  const checks = card.listEl.querySelectorAll<HTMLInputElement>('.card-check')
  checks.forEach(check => (check.disabled = true))

  try {
    const result = await sidebarRequest<CreateGroupResult>(
      'createSuggestedGroupViaAI',
      panelId,
      card.data.key,
      selectedIds,
      card.titleInputEl.value.trim()
    )

    if (result.status === 'ok' && result.moved > 0) {
      setStatus(msg('created', String(result.moved)))
      cardsByKey.delete(card.data.key)
      card.cardEl.remove()
      if (!cardsByKey.size) setStatus(msg('none'))
    } else if (result.status === 'ok') {
      setStatus(msg('none'))
      card.createBtnEl.disabled = false
      card.titleInputEl.disabled = false
      checks.forEach(check => (check.disabled = false))
      updateCreateButtonLabel(card)
    } else {
      setStatus(msg('failed'))
      card.createBtnEl.disabled = false
      card.titleInputEl.disabled = false
      checks.forEach(check => (check.disabled = false))
      updateCreateButtonLabel(card)
    }
  } catch {
    setStatus(msg('failed'))
    card.createBtnEl.disabled = false
    card.titleInputEl.disabled = false
    checks.forEach(check => (check.disabled = false))
    updateCreateButtonLabel(card)
  } finally {
    inProgress = false
    if (refreshBtnEl) refreshBtnEl.disabled = false
  }
}

function createGroupCard(group: SuggestedGroup): GroupCard {
  const cardEl = document.createElement('article')
  cardEl.className = 'card'

  const headEl = document.createElement('div')
  headEl.className = 'card-head'

  const titleInputEl = document.createElement('input')
  titleInputEl.className = 'group-title-input'
  titleInputEl.type = 'text'
  titleInputEl.value = group.title

  const metaEl = document.createElement('div')
  metaEl.className = 'group-meta'

  const tabsCountEl = document.createElement('div')
  tabsCountEl.textContent = msg('tabs_count', String(group.tabs.length))

  const similarityEl = document.createElement('div')
  similarityEl.textContent = msg('similarity', formatPercent(group.similarity))

  metaEl.append(tabsCountEl, similarityEl)
  headEl.append(titleInputEl, metaEl)

  const listEl = document.createElement('div')
  listEl.className = 'card-list'

  const footEl = document.createElement('div')
  footEl.className = 'card-foot'

  const createBtnEl = document.createElement('button')
  createBtnEl.className = 'create-btn'
  createBtnEl.type = 'button'

  const card: GroupCard = {
    data: group,
    cardEl: cardEl,
    listEl: listEl,
    titleInputEl: titleInputEl,
    createBtnEl: createBtnEl,
  }

  for (const tab of group.tabs) {
    listEl.append(createTabRow(card, tab))
  }

  updateCreateButtonLabel(card)
  createBtnEl.addEventListener('click', () => {
    void onCreateGroup(card)
  })

  footEl.append(createBtnEl)
  cardEl.append(headEl, listEl, footEl)

  return card
}

function clearGroups(): void {
  cardsByKey.clear()
  if (groupsEl) groupsEl.textContent = ''
}

function renderGroups(groups: SuggestedGroup[]): void {
  clearGroups()
  if (!groupsEl) return

  for (const group of groups) {
    const card = createGroupCard(group)
    cardsByKey.set(group.key, card)
    groupsEl.append(card.cardEl)
  }
}

async function findGroups(): Promise<void> {
  if (inProgress) return
  inProgress = true
  if (refreshBtnEl) refreshBtnEl.disabled = true
  setStatus(msg('working'))
  clearGroups()

  try {
    const result = await sidebarRequest<SuggestGroupsResult>('suggestGroupsForPanelViaAI', panelId)

    if (result.panelName && titleEl) {
      titleEl.textContent = `${msg('page_title')}: ${result.panelName}`
      document.title = titleEl.textContent
    }

    if (result.status === 'ok' && result.groups?.length) {
      renderGroups(result.groups)
      setStatus(msg('found', String(result.groups.length)))
    } else if (result.status === 'no_candidates') {
      setStatus(msg('none'))
    } else if (result.status === 'permission_denied') {
      setStatus(msg('permission'))
    } else if (result.status === 'unsupported') {
      setStatus(msg('unavailable'))
    } else {
      setStatus(msg('failed'))
    }
  } catch {
    setStatus(msg('failed'))
  } finally {
    inProgress = false
    if (refreshBtnEl) refreshBtnEl.disabled = false
  }
}

function initText(): void {
  const pageTitle = msg('page_title')
  if (titleEl) titleEl.textContent = pageTitle
  if (refreshBtnEl) refreshBtnEl.textContent = msg('refresh_btn')
  document.title = pageTitle
}

async function main(): Promise<void> {
  titleEl = document.getElementById('title')
  refreshBtnEl = document.getElementById('refresh_btn') as HTMLButtonElement | null
  statusEl = document.getElementById('status')
  groupsEl = document.getElementById('groups')

  initText()

  if (!parseParams()) {
    setStatus(msg('bad_url'))
    if (refreshBtnEl) refreshBtnEl.disabled = true
    return
  }

  refreshBtnEl?.addEventListener('click', () => {
    void findGroups()
  })

  await findGroups()
}

void main()
