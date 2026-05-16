import * as Utils from 'src/utils'
import { Tab, GroupConfig, GroupInfo, GroupedTabInfo, GroupPin } from 'src/types'
import { GroupConfigResult } from 'src/enums'
import { translate } from 'src/dict'
import { GroupMsg } from 'src/injections/group.ipc'
import * as Windows from 'src/services/windows.fg'
import * as Settings from 'src/services/settings'
import * as Tabs from 'src/services/tabs.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Favicons from 'src/services/favicons.fg'
import * as IPC from 'src/services/ipc'
import * as Logs from 'src/services/logs'
import * as Notifications from 'src/services/notifications.fg'
import * as Popups from 'src/services/popups.fg'

// AI mode: suggest tabs for an existing group page
const GROUP_REFERENCE_TABS_LIMIT = 10
const DEFAULT_GROUP_SUGGESTION_MIN_GROUP_SIMILARITY = 0.3
const DEFAULT_GROUP_SUGGESTION_MIN_SIMILARITY = 0.42

// AI mode: suggest new groups for a tabs panel
const DEFAULT_PANEL_GROUP_LINK_SIMILARITY = 0.45
const DEFAULT_PANEL_GROUP_MEMBER_SIMILARITY = 0.3
const DEFAULT_PANEL_GROUP_MIN_SIZE = 4
const MAX_PANEL_GROUP_MIN_SIZE = 12

// Shared AI thresholds/clamps
const MIN_GROUP_SUGGESTION_THRESHOLD = 0.05
const MAX_GROUP_SUGGESTION_THRESHOLD = 0.99
const TRIAL_ML_PERMISSION = 'trialML'
const TRIAL_ML_FEATURE_EXTRACTION_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const TRIAL_ML_MODEL_HUB = 'huggingface'
const TRIAL_ML_SMART_TAB_FEATURE_ID = 'smart-tab-embedding'
const AI_GROUPS_PAGE_PATH = '/page.group/ai-groups.html'

interface TrialMlApi {
  createEngine: (args: {
    taskName?: string
    modelHub?: string
    modelId?: string
    featureId?: string
    pipelineOptions?: {
      taskName?: string
      modelHub?: string
      modelId?: string
      featureId?: string
    }
  }) => Promise<unknown>
  runEngine: (args: { args: [string] | [string[]]; options?: Record<string, unknown> }) => Promise<unknown>
}

interface GroupAICandidate {
  tab: Tab
  similarity: number
}

export type GroupAISuggestResultStatus =
  | 'ok'
  | 'unsupported'
  | 'permission_denied'
  | 'no_candidates'
  | 'error'

export interface GroupAISuggestResult {
  status: GroupAISuggestResultStatus
  suggestions?: GroupAISuggestedTab[]
}

export interface GroupAISuggestOptions {
  minSimilarity?: number
  minGroupSimilarity?: number
}

export interface GroupAISuggestedTab {
  id: ID
  title: string
  url: string
  similarity: number
  favIconUrl?: string
}

export interface GroupAIPanelSuggestOptions {
  linkSimilarity?: number
  memberSimilarity?: number
  minGroupSize?: number
}

export interface GroupAISuggestedPanelGroup {
  key: string
  title: string
  similarity: number
  tabs: GroupAISuggestedTab[]
}

export interface GroupAIPanelSuggestResult {
  status: GroupAISuggestResultStatus
  panelName?: string
  groups?: GroupAISuggestedPanelGroup[]
}

export interface GroupAIApplyResult {
  status: 'ok' | 'error'
  moved: number
}

export interface GroupAICreateGroupResult {
  status: 'ok' | 'error'
  moved: number
}

let groupSuggestAIEngineReady = false
let groupSuggestAIEngineInit: Promise<boolean | undefined> | undefined
const lastAiSuggestedTabsByGroup = new Map<ID, Set<ID>>()
const lastAiSuggestedGroupsByPanel = new Map<ID, Map<string, Set<ID>>>()

/**
 * Set relGroupId prop in related pinned and group tabs
 */
export function linkGroupWithPinnedTab(groupTab: Tab, tabs: Tab[]): void {
  const info = new URL(groupTab.url)
  const pin = info.searchParams.get('pin')
  if (!pin) return

  const [ctx, url] = pin.split('::')
  let pinnedTab: Tab | undefined
  for (const tab of tabs) {
    if (!tab.pinned) break
    if (tab.pinned && tab.cookieStoreId === ctx && tab.url === url) {
      pinnedTab = tab
      break
    }
  }

  if (!pinnedTab) {
    info.searchParams.delete('pin')
    groupTab.url = info.href
    browser.tabs.update(groupTab.id, { url: info.href }).catch(err => {
      Logs.err('Tabs.linkGroupWithPinnedTab: Cannot update url:', err)
    })
    return
  }

  pinnedTab.relGroupId = groupTab.id
}

/**
 * ...
 */
export async function replaceRelGroupWithPinnedTab(groupTab: Tab, pinnedTab: Tab): Promise<void> {
  await browser.tabs.move(pinnedTab.id, { index: groupTab.index - 1 })

  groupTab.parentId = pinnedTab.id
  Tabs.updateTabsTree()

  await browser.tabs.remove(groupTab.id)
}

/**
 * Group tabs
 */
export async function groupTabs(tabIds: ID[], conf?: GroupConfig): Promise<void> {
  const noConfig = !conf
  if (!conf) conf = {}

  // Get sorted list of tabs
  const tabs = []
  for (const t of Tabs.list) {
    if (tabIds.includes(t.id)) tabs.push(t)
    else if (tabIds.includes(t.parentId)) {
      tabIds.push(t.id)
      tabs.push(t)
    }
  }

  if (!tabs.length) return
  if (Settings.state.tabsTreeLimit !== 'none' && tabs[0].lvl >= Settings.state.tabsTreeLimit) return

  // Find title for group tab
  if (!conf.title) {
    const titles = tabs.map(t => t.title)
    const commonPart = Utils.commonSubStr(titles)
    const isOk = commonPart ? commonPart[0] === commonPart[0].toUpperCase() : false
    let groupTitle = commonPart
      .replace(/^(\s|\.|_|-|—|–|\(|\)|\/|=|;|:)+/g, ' ')
      .replace(/(\s|\.|_|-|—|–|\(|\)|\/|=|;|:)+$/g, ' ')
      .trim()

    if (!isOk || groupTitle.length < 4) {
      const hosts = tabs.filter(t => !t.url.startsWith('about:')).map(t => t.url.split('/')[2])
      groupTitle = Utils.commonSubStr(hosts)
      if (groupTitle.startsWith('.')) groupTitle = groupTitle.slice(1)
      groupTitle = groupTitle.replace(/^www\./, '')
    }

    if (!isOk || groupTitle.length < 4) groupTitle = tabs[0].title

    conf.title = groupTitle
  }

  // Show config popup
  if (noConfig && Settings.state.showNewGroupConf) {
    const result = await Tabs.openGroupConfigPopup(conf)
    if (result === GroupConfigResult.Cancel) return
  }

  // Get panel
  const panelId = tabs[0].panelId
  const panel = Sidebar.panelsById[panelId]
  if (!Utils.isTabsPanel(panel)) return

  // Find index and create group tab
  Tabs.setNewTabPosition(tabs[0].index, tabs[0].parentId, tabs[0].panelId)
  const groupTab = await browser.tabs.create({
    active: !!conf.active,
    cookieStoreId: tabs[0].cookieStoreId,
    index: tabs[0].index,
    url: Utils.createGroupUrl(conf.title, conf),
    windowId: Windows.id,
  })

  // Set link between group and pinned tabs
  if (conf.pinnedTab) {
    conf.pinnedTab.relGroupId = groupTab.id
  }

  // Move tabs if needed
  let properIndex = tabs[0].index
  const tabsToMove: Tab[] = []
  let indexToMoveTo = -1
  for (const tab of tabs) {
    if (tab.index !== properIndex) {
      if (indexToMoveTo === -1) indexToMoveTo = properIndex
      tabsToMove.push(tab)
    }
    properIndex++
  }
  const dst = { index: groupTab.index + 1, panelId: panel.id, parentId: groupTab.id }
  await Tabs.move(tabs, {}, dst)
}

export async function openGroupConfigPopup(config: GroupConfig): Promise<GroupConfigResult> {
  return new Promise<GroupConfigResult>(ok => {
    Popups.reactive.groupConfigPopup = {
      config,
      done: result => ok(result),
    }
  })
}

function getPinInfo(groupUrl: string): GroupPin | undefined {
  if (!groupUrl.includes('pin=')) return

  const urlInfo = new URL(groupUrl)
  const pinValue = urlInfo.searchParams.get('pin')
  if (!pinValue) return

  const [ctr, url] = pinValue.split('::')
  const pinnedTab = Tabs.list.find(t => t.pinned && t.cookieStoreId === ctr && t.url === url)
  if (pinnedTab) {
    return {
      id: pinnedTab.id,
      title: pinnedTab.title,
      url: pinnedTab.url,
      favIconUrl: pinnedTab.favIconUrl ?? '',
    }
  }
}

/**
 * Get grouped tabs (for group page)
 */
export async function getGroupInfo(groupTabId: ID): Promise<GroupInfo | null> {
  if (!Tabs.ready) await Tabs.waitForTabsReady()
  if (!Favicons.ready) await Favicons.waitForFaviconsReady()

  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab) {
    Logs.warn('Tabs.getGroupInfo: No group tab:', groupTabId)
    return null
  }

  const out: GroupInfo = {
    id: groupTab.id,
    index: groupTab.index,
    len: 0,
    tabs: [] as GroupedTabInfo[],
  }

  const parentTab = Tabs.byId[groupTab.parentId]
  if (parentTab && parentTab.isGroup) {
    out.parentId = parentTab.id
  }

  const pinInfo = getPinInfo(groupTab.url)
  if (pinInfo) out.pin = pinInfo

  let subGroupLvl = null
  for (let i = groupTab.index + 1; i < Tabs.list.length; i++) {
    const tab = Tabs.list[i]
    if (tab.lvl <= groupTab.lvl) break
    out.len++

    if (subGroupLvl && tab.lvl > subGroupLvl) continue
    else subGroupLvl = null
    if (tab.isGroup) subGroupLvl = tab.lvl

    out.tabs.push({
      id: tab.id,
      index: tab.index,
      lvl: tab.lvl - groupTab.lvl - 1,
      title: tab.customTitle ?? tab.title,
      url: tab.url,
      discarded: !!tab.discarded,
      favIconUrl: tab.favIconUrl ?? '',
    })
  }

  return out
}

export function getGroupTab(tab?: Tab): Tab | undefined {
  if (!tab) return
  if (!Settings.state.tabsTree && !tab.lvl) return

  let i = tab.lvl || 0
  while (i--) {
    tab = Tabs.byId[tab.parentId]
    if (!tab) return
    if (tab && tab.isGroup) return tab
  }
}

function collectGroupBranch(groupTab: Tab): Tab[] {
  const out: Tab[] = []
  for (let i = groupTab.index + 1; i < Tabs.list.length; i++) {
    const tab = Tabs.list[i]
    if (tab.lvl <= groupTab.lvl) break
    out.push(tab)
  }
  return out
}

function normalizeUrl(url: string): string {
  try {
    const info = new URL(url)
    info.hash = ''

    if (
      (info.protocol === 'http:' || info.protocol === 'https:') &&
      info.pathname.length > 1 &&
      info.pathname.endsWith('/')
    ) {
      info.pathname = info.pathname.slice(0, -1)
    }

    return info.href
  } catch {
    return url
  }
}

function getTrialMlApi(): TrialMlApi | undefined {
  const trial = (browser as unknown as { trial?: { ml?: TrialMlApi } }).trial
  return trial?.ml
}

async function hasTrialMlPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: [TRIAL_ML_PERMISSION] })
  } catch {
    return false
  }
}

async function getTrialMlEngine(): Promise<TrialMlApi | undefined> {
  if (groupSuggestAIEngineReady) return getTrialMlApi()
  if (groupSuggestAIEngineInit) {
    const ready = await groupSuggestAIEngineInit
    if (!ready) return
    return getTrialMlApi()
  }

  const trialMlApi = getTrialMlApi()
  if (!trialMlApi) return

  groupSuggestAIEngineInit = trialMlApi
    .createEngine({
      taskName: 'feature-extraction',
      featureId: TRIAL_ML_SMART_TAB_FEATURE_ID,
      modelHub: TRIAL_ML_MODEL_HUB,
      modelId: TRIAL_ML_FEATURE_EXTRACTION_MODEL_ID,
    })
    .then(() => {
      groupSuggestAIEngineReady = true
      return true
    })
    .catch(err => {
      Logs.warn('Tabs.getTrialMlEngine: Cannot create trialML engine:', err)
      return undefined
    })
    .finally(() => {
      groupSuggestAIEngineInit = undefined
    })

  const ready = await groupSuggestAIEngineInit
  if (!ready) return
  return getTrialMlApi()
}

function toNumberArray(input: unknown): number[] | undefined {
  if (Array.isArray(input)) {
    if (input.every(v => typeof v === 'number')) return input as number[]
    return
  }

  if (ArrayBuffer.isView(input) && 'length' in input) {
    return Array.from(input as ArrayLike<number>)
  }
}

function meanPool(vectors: number[][]): number[] | undefined {
  if (!vectors.length) return

  const dim = vectors[0].length
  if (!dim) return

  const out = new Array<number>(dim).fill(0)
  for (const vector of vectors) {
    if (vector.length !== dim) return
    for (let i = 0; i < dim; i++) {
      out[i] += vector[i]
    }
  }

  for (let i = 0; i < dim; i++) {
    out[i] /= vectors.length
  }

  return out
}

function getFirstEmbedding(raw: unknown): number[] | undefined {
  const vector = toNumberArray(raw)
  if (vector) return vector

  if (Array.isArray(raw)) {
    const vectors = raw.map(toNumberArray).filter(Boolean) as number[][]
    if (vectors.length) return meanPool(vectors)

    for (const item of raw) {
      const nested = getFirstEmbedding(item)
      if (nested) return nested
    }
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if ('data' in obj) return getFirstEmbedding(obj.data)
    if ('output' in obj) return getFirstEmbedding(obj.output)
  }
}

function getTabHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function createTabText(tab: Pick<Tab, 'title' | 'url'>, includeHost = true): string {
  if (!includeHost) return tab.title

  const host = getTabHost(tab.url)
  if (!host) return tab.title
  return `${tab.title}\nsite: ${host}`
}

function createGroupText(groupTab: Tab, groupTabs: Tab[], pinTab?: Tab): string {
  const groupTitle = groupTab.customTitle ?? groupTab.title
  const lines = [groupTitle, groupTitle]
  const allTabs = pinTab ? [pinTab, ...groupTabs] : groupTabs
  for (const tab of allTabs.slice(0, 16)) {
    lines.push(createTabText(tab))
  }
  return lines.join('\n')
}

async function embedText(text: string): Promise<number[] | undefined> {
  const trialMlApi = await getTrialMlEngine()
  if (!trialMlApi) return

  try {
    const output = await trialMlApi.runEngine({
      args: [text],
      options: { pooling: 'mean', normalize: true },
    })
    return getFirstEmbedding(output)
  } catch (err) {
    Logs.warn('Tabs.embedText: trialML run failed:', err)
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0

  let dot = 0
  let lenA = 0
  let lenB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    lenA += a[i] * a[i]
    lenB += b[i] * b[i]
  }
  if (!lenA || !lenB) return 0

  return dot / (Math.sqrt(lenA) * Math.sqrt(lenB))
}

function average(values: number[]): number {
  if (!values.length) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function averageTop(values: number[], topCount: number): number {
  if (!values.length || topCount < 1) return 0
  values.sort((a, b) => b - a)
  return average(values.slice(0, Math.min(topCount, values.length)))
}

function clampThreshold(value: number): number {
  return Math.max(MIN_GROUP_SUGGESTION_THRESHOLD, Math.min(MAX_GROUP_SUGGESTION_THRESHOLD, value))
}

function clampPanelGroupMinSize(value: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : DEFAULT_PANEL_GROUP_MIN_SIZE
  return Math.max(2, Math.min(MAX_PANEL_GROUP_MIN_SIZE, rounded))
}

function createSuggestedPanelGroupKey(tabIds: ID[]): string {
  return [...tabIds].sort((a, b) => a - b).join('_')
}

function getAiCandidatesForPanel(panelId: ID): Tab[] {
  const panel = Sidebar.panelsById[panelId]
  if (!Utils.isTabsPanel(panel)) return []

  const candidates: Tab[] = []
  for (const tab of panel.tabs) {
    if (tab.windowId !== Windows.id) continue
    if (tab.pinned || tab.isGroup || tab.internal) continue
    if (getGroupTab(tab)) continue
    candidates.push(tab)
  }

  return candidates
}

function getSuggestedPanelGroupTitle(tabs: Tab[]): string {
  if (!tabs.length) return 'Group'

  let topHost: string | undefined
  let topHostCount = 0
  const hostUsage = new Map<string, number>()
  for (const tab of tabs) {
    const host = getTabHost(tab.url)
    if (!host) continue
    const count = (hostUsage.get(host) ?? 0) + 1
    hostUsage.set(host, count)
    if (count > topHostCount) {
      topHost = host
      topHostCount = count
    }
  }

  const minHostCount = Math.max(2, Math.ceil(tabs.length * 0.5))
  if (topHost && topHostCount >= minHostCount) return topHost

  const tabTitles = tabs
    .map(tab => tab.customTitle ?? tab.title)
    .filter((title): title is string => Boolean(title))
  const commonTitle = tabTitles.length ? Utils.commonSubStr(tabTitles) : ''
  if (commonTitle) {
    const cleaned = commonTitle
      .replace(/^(\s|\.|_|-|\(|\)|\/|=|;|:)+/g, ' ')
      .replace(/(\s|\.|_|-|\(|\)|\/|=|;|:)+$/g, ' ')
      .trim()

    if (cleaned.length >= 4) return cleaned
  }

  if (topHost) return topHost
  return tabs[0].customTitle ?? tabs[0].title ?? 'Group'
}

async function createGroupFromExactTabs(tabs: Tab[], title?: string): Promise<number> {
  if (!tabs.length) return 0

  const tabsToMove = [...tabs].sort((a, b) => a.index - b.index)
  const firstTab = tabsToMove[0]
  const panel = Sidebar.panelsById[firstTab.panelId]
  if (!Utils.isTabsPanel(panel)) return 0

  const groupTitle = (title ?? '').trim() || getSuggestedPanelGroupTitle(tabsToMove)
  Tabs.setNewTabPosition(firstTab.index, firstTab.parentId, firstTab.panelId)

  const groupTab = await browser.tabs.create({
    active: false,
    cookieStoreId: firstTab.cookieStoreId,
    index: firstTab.index,
    url: Utils.createGroupUrl(groupTitle, { title: groupTitle }),
    windowId: Windows.id,
  })

  const dst = {
    index: groupTab.index + 1,
    panelId: panel.id,
    parentId: groupTab.id,
  }

  await Tabs.move(tabsToMove, {}, dst)
  return tabsToMove.length
}

function createAIGroupsPageUrl(winId: ID, panelId: ID): string {
  const url = new URL(browser.runtime.getURL(AI_GROUPS_PAGE_PATH))
  url.searchParams.set('winId', String(winId))
  url.searchParams.set('panelId', String(panelId))
  return url.href
}

function getAiCandidatesForGroup(groupTabId: ID): Tab[] {
  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab?.isGroup) return []

  const groupBranch = collectGroupBranch(groupTab)
  const inGroupTabIds = new Set(groupBranch.map(t => t.id))
  inGroupTabIds.add(groupTab.id)

  const groupUrls = new Set(
    groupBranch.filter(t => !t.isGroup).map(tab => normalizeUrl(tab.url)).filter(Boolean)
  )

  const candidates: Tab[] = []
  for (const tab of Tabs.list) {
    if (tab.windowId !== groupTab.windowId) continue
    if (tab.panelId !== groupTab.panelId) continue
    if (tab.pinned || tab.isGroup || tab.isParent) continue
    if (inGroupTabIds.has(tab.id)) continue
    if (groupUrls.has(normalizeUrl(tab.url))) continue
    candidates.push(tab)
  }

  return candidates
}

export async function openAIGroupsSuggestionsPage(panelId: ID): Promise<void> {
  const panel = Sidebar.panelsById[panelId]
  if (!Utils.isTabsPanel(panel)) return

  const url = createAIGroupsPageUrl(Windows.id, panelId)
  const existedTab = Tabs.list.find(tab => tab.windowId === Windows.id && tab.url === url)
  if (existedTab) {
    await browser.tabs.update(existedTab.id, { active: true })
    return
  }

  await Tabs.createTabInPanel(panel, { url, active: true, position: 'end' })
}

export async function suggestGroupsForPanelViaAI(
  panelId: ID,
  options?: GroupAIPanelSuggestOptions
): Promise<GroupAIPanelSuggestResult> {
  const panel = Sidebar.panelsById[panelId]
  if (!Utils.isTabsPanel(panel)) return { status: 'error' }
  if (!getTrialMlApi()) return { status: 'unsupported', panelName: panel.name }
  if (!(await hasTrialMlPermission())) return { status: 'permission_denied', panelName: panel.name }

  const candidates = getAiCandidatesForPanel(panelId)
  const minGroupSize = clampPanelGroupMinSize(options?.minGroupSize ?? DEFAULT_PANEL_GROUP_MIN_SIZE)
  const linkSimilarity = clampThreshold(options?.linkSimilarity ?? DEFAULT_PANEL_GROUP_LINK_SIMILARITY)
  const memberSimilarity = clampThreshold(
    Math.min(options?.memberSimilarity ?? DEFAULT_PANEL_GROUP_MEMBER_SIMILARITY, linkSimilarity)
  )

  Logs.info(
    'Tabs.suggestGroupsForPanelViaAI: start',
    `panel=${String(panel.id)} "${panel.name}", total=${panel.tabs.length}, candidates=${candidates.length}, minGroupSize=${minGroupSize}, linkSimilarity=${linkSimilarity.toFixed(
      2
    )}, memberSimilarity=${memberSimilarity.toFixed(2)}`
  )

  if (candidates.length < minGroupSize) {
    Logs.info(
      'Tabs.suggestGroupsForPanelViaAI: no candidates',
      `not enough candidates: ${candidates.length} < ${minGroupSize}`
    )
    lastAiSuggestedGroupsByPanel.delete(panelId)
    return { status: 'no_candidates', panelName: panel.name }
  }

  const embedded: Array<{ tab: Tab; embedding: number[] }> = []
  for (const tab of candidates) {
    // For panel grouping we avoid explicit domain hint to reduce over-grouping by host only.
    const embedding = await embedText(createTabText(tab, false))
    if (embedding) embedded.push({ tab, embedding })
  }

  Logs.info(
    'Tabs.suggestGroupsForPanelViaAI: embeddings',
    `embedded=${embedded.length}, skipped=${Math.max(0, candidates.length - embedded.length)}`
  )

  if (!embedded.length) {
    Logs.warn('Tabs.suggestGroupsForPanelViaAI: no embeddings created')
    lastAiSuggestedGroupsByPanel.delete(panelId)
    return { status: 'error', panelName: panel.name }
  }

  if (embedded.length < minGroupSize) {
    Logs.info(
      'Tabs.suggestGroupsForPanelViaAI: no candidates',
      `not enough embedded tabs: ${embedded.length} < ${minGroupSize}`
    )
    lastAiSuggestedGroupsByPanel.delete(panelId)
    return { status: 'no_candidates', panelName: panel.name }
  }

  const links = Array.from({ length: embedded.length }, () => [] as number[])
  let edgeCount = 0
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const similarity = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
      if (similarity >= linkSimilarity) {
        links[i].push(j)
        links[j].push(i)
        edgeCount++
      }
    }
  }

  Logs.info(
    'Tabs.suggestGroupsForPanelViaAI: graph',
    `nodes=${embedded.length}, edges=${edgeCount}, avgDegree=${((edgeCount * 2) / embedded.length).toFixed(2)}`
  )

  const visited = new Array(embedded.length).fill(false)
  const groups: GroupAISuggestedPanelGroup[] = []
  const allowedByKey = new Map<string, Set<ID>>()
  let componentsVisited = 0

  for (let i = 0; i < embedded.length; i++) {
    if (visited[i]) continue

    componentsVisited++
    const stack = [i]
    visited[i] = true
    const component: number[] = []

    while (stack.length) {
      const current = stack.pop()
      if (current === undefined) continue
      component.push(current)
      for (const linked of links[current]) {
        if (!visited[linked]) {
          visited[linked] = true
          stack.push(linked)
        }
      }
    }

    if (component.length < minGroupSize) continue

    let centroid = meanPool(component.map(index => embedded[index].embedding))
    if (!centroid) continue

    const inComponentSet = new Set(component)
    let memberScores = component.map(index => ({
      index,
      similarity: cosineSimilarity(centroid, embedded[index].embedding),
      linksInComponent: links[index].reduce((acc, linked) => {
        if (inComponentSet.has(linked)) return acc + 1
        return acc
      }, 0),
    }))

    // Keep tabs that are semantically close to centroid OR well-connected inside component.
    let members = memberScores
      .filter(item => item.similarity >= memberSimilarity || item.linksInComponent >= 2)
      .map(item => item.index)
    if (members.length < minGroupSize) {
      const topBySimilarity = [...memberScores]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, minGroupSize)
        .map(item => item.index)
      members = topBySimilarity
    }
    if (members.length < minGroupSize) continue

    centroid = meanPool(members.map(index => embedded[index].embedding))
    if (!centroid) continue

    memberScores = members.map(index => ({
      index,
      similarity: cosineSimilarity(centroid, embedded[index].embedding),
      linksInComponent: links[index].reduce((acc, linked) => {
        if (inComponentSet.has(linked)) return acc + 1
        return acc
      }, 0),
    }))
    members = memberScores
      .filter(item => item.similarity >= memberSimilarity || item.linksInComponent >= 2)
      .map(item => item.index)
    if (members.length < minGroupSize) {
      const topBySimilarity = [...memberScores]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, minGroupSize)
        .map(item => item.index)
      members = topBySimilarity
    }

    if (members.length < minGroupSize) continue

    memberScores = members.map(index => ({
      index,
      similarity: cosineSimilarity(centroid, embedded[index].embedding),
      linksInComponent: links[index].reduce((acc, linked) => {
        if (inComponentSet.has(linked)) return acc + 1
        return acc
      }, 0),
    }))

    const sortedMemberScores = memberScores.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity
      return (embedded[b.index].tab.lastAccessed ?? 0) - (embedded[a.index].tab.lastAccessed ?? 0)
    })

    if (sortedMemberScores.length < minGroupSize) continue

    const tabs = sortedMemberScores.map(({ index, similarity }) => ({
      id: embedded[index].tab.id,
      title: embedded[index].tab.customTitle ?? embedded[index].tab.title,
      url: embedded[index].tab.url,
      similarity,
      favIconUrl: embedded[index].tab.favIconUrl,
    }))

    const tabIds = tabs.map(tab => tab.id)
    const key = createSuggestedPanelGroupKey(tabIds)
    const groupTabs = sortedMemberScores.map(({ index }) => embedded[index].tab)
    const similarity = average(sortedMemberScores.map(item => item.similarity))
    const title = getSuggestedPanelGroupTitle(groupTabs)

    groups.push({ key, title, similarity, tabs })
    allowedByKey.set(key, new Set(tabIds))
  }

  if (!groups.length) {
    Logs.info(
      'Tabs.suggestGroupsForPanelViaAI: no groups',
      `components=${componentsVisited}, minGroupSize=${minGroupSize}, linkSimilarity=${linkSimilarity.toFixed(
        2
      )}, memberSimilarity=${memberSimilarity.toFixed(2)}`
    )
    lastAiSuggestedGroupsByPanel.delete(panelId)
    return { status: 'no_candidates', panelName: panel.name }
  }

  groups.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return b.tabs.length - a.tabs.length
  })

  const avgGroupSize = average(groups.map(group => group.tabs.length))
  Logs.info(
    'Tabs.suggestGroupsForPanelViaAI: done',
    `components=${componentsVisited}, groups=${groups.length}, avgGroupSize=${avgGroupSize.toFixed(2)}`
  )

  lastAiSuggestedGroupsByPanel.set(panelId, allowedByKey)
  return {
    status: 'ok',
    panelName: panel.name,
    groups,
  }
}

export async function createSuggestedGroupViaAI(
  panelId: ID,
  key: string,
  tabIds: ID[],
  title?: string
): Promise<GroupAICreateGroupResult> {
  const panel = Sidebar.panelsById[panelId]
  if (!Utils.isTabsPanel(panel)) return { status: 'error', moved: 0 }
  if (!key || !tabIds.length) return { status: 'ok', moved: 0 }

  const suggestedGroups = lastAiSuggestedGroupsByPanel.get(panelId)
  const allowedIds = suggestedGroups?.get(key)
  if (!allowedIds?.size) return { status: 'ok', moved: 0 }

  const selected = new Set(tabIds.filter(id => allowedIds.has(id)))
  if (!selected.size) return { status: 'ok', moved: 0 }

  const candidates = getAiCandidatesForPanel(panelId)
  const tabsToMove = candidates.filter(tab => selected.has(tab.id)).sort((a, b) => a.index - b.index)
  if (!tabsToMove.length) return { status: 'ok', moved: 0 }

  try {
    const moved = await createGroupFromExactTabs(tabsToMove, title)

    if (moved && suggestedGroups) {
      for (const ids of suggestedGroups.values()) {
        for (const movedTab of tabsToMove) ids.delete(movedTab.id)
      }
      for (const [groupKey, ids] of suggestedGroups) {
        if (ids.size < 2) suggestedGroups.delete(groupKey)
      }
      if (!suggestedGroups.size) lastAiSuggestedGroupsByPanel.delete(panelId)
    }

    return { status: 'ok', moved }
  } catch (err) {
    Logs.warn('Tabs.createSuggestedGroupViaAI: Cannot group tabs:', err)
    return { status: 'error', moved: 0 }
  }
}

export async function suggestTabsForGroupViaAI(
  groupTabId: ID,
  options?: GroupAISuggestOptions
): Promise<GroupAISuggestResult> {
  if (!getTrialMlApi()) return { status: 'unsupported' }
  if (!(await hasTrialMlPermission())) return { status: 'permission_denied' }

  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab?.isGroup) return { status: 'error' }

  const groupTabs = collectGroupBranch(groupTab).filter(t => !t.isGroup)
  const config = getGroupConfig(groupTabId)
  const minSimilarity = clampThreshold(
    options?.minSimilarity ?? DEFAULT_GROUP_SUGGESTION_MIN_SIMILARITY
  )
  const minGroupSimilarity = clampThreshold(
    Math.min(
      options?.minGroupSimilarity ??
        Math.min(
          minSimilarity,
          Math.max(MIN_GROUP_SUGGESTION_THRESHOLD, minSimilarity - 0.12)
        ),
      minSimilarity
    )
  )
  const groupText = createGroupText(groupTab, groupTabs, config?.pinnedTab)
  const groupEmbedding = await embedText(groupText)
  if (!groupEmbedding) return { status: 'error' }

  const referenceEmbeddings: number[][] = []
  const referenceTabs = (config?.pinnedTab ? [config.pinnedTab, ...groupTabs] : groupTabs).slice(
    0,
    GROUP_REFERENCE_TABS_LIMIT
  )
  for (const tab of referenceTabs) {
    const emb = await embedText(createTabText(tab))
    if (emb) referenceEmbeddings.push(emb)
  }

  const candidates = getAiCandidatesForGroup(groupTabId)
  if (!candidates.length) {
    lastAiSuggestedTabsByGroup.delete(groupTabId)
    return { status: 'no_candidates' }
  }

  const ranked: GroupAICandidate[] = []
  for (const tab of candidates) {
    const embedding = await embedText(createTabText(tab))
    if (!embedding) continue

    const groupSimilarity = cosineSimilarity(groupEmbedding, embedding)
    if (groupSimilarity < minGroupSimilarity) continue

    const refsSimilarity = averageTop(
      referenceEmbeddings.map(refEmbedding => cosineSimilarity(refEmbedding, embedding)),
      3
    )
    const similarity = referenceEmbeddings.length
      ? groupSimilarity * 0.45 + refsSimilarity * 0.55
      : groupSimilarity

    if (similarity < minSimilarity) continue
    ranked.push({ tab, similarity })
  }

  ranked.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0)
  })
  const suggestions = ranked.map(({ tab, similarity }) => ({
    id: tab.id,
    title: tab.customTitle ?? tab.title,
    url: tab.url,
    similarity,
  }))
  if (!suggestions.length) {
    lastAiSuggestedTabsByGroup.delete(groupTabId)
    return { status: 'no_candidates' }
  }

  lastAiSuggestedTabsByGroup.set(
    groupTabId,
    new Set(suggestions.map(suggestion => suggestion.id))
  )

  return { status: 'ok', suggestions }
}

export async function applySuggestedTabsToGroupViaAI(
  groupTabId: ID,
  tabIds: ID[]
): Promise<GroupAIApplyResult> {
  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab?.isGroup) return { status: 'error', moved: 0 }
  if (!tabIds.length) return { status: 'ok', moved: 0 }

  const allowedTabs = lastAiSuggestedTabsByGroup.get(groupTabId)
  if (!allowedTabs?.size) return { status: 'ok', moved: 0 }

  const candidateIds = new Set(tabIds.filter(id => allowedTabs.has(id)))
  if (!candidateIds.size) return { status: 'ok', moved: 0 }

  const tabsToMove = getAiCandidatesForGroup(groupTabId)
    .filter(tab => candidateIds.has(tab.id))
    .sort((a, b) => a.index - b.index)

  if (!tabsToMove.length) return { status: 'ok', moved: 0 }

  const dst = {
    index: groupTab.index + (Tabs.getBranchLen(groupTab.id) ?? 0) + 1,
    panelId: groupTab.panelId,
    parentId: groupTab.id,
  }

  try {
    await Tabs.move(tabsToMove, {}, dst)
    return { status: 'ok', moved: tabsToMove.length }
  } catch (err) {
    Logs.warn('Tabs.applySuggestedTabsToGroupViaAI: Cannot move tabs:', err)
    return { status: 'error', moved: 0 }
  }
}

function notifyAboutAISuggestResult(result: GroupAISuggestResult): void {
  if (result.status === 'ok') {
    Notifications.notify({ title: translate('notif.group_suggest.found', result.suggestions?.length ?? 0) })
  } else if (result.status === 'no_candidates') {
    Notifications.notify({ title: translate('notif.group_suggest.none') })
  } else if (result.status === 'unsupported' || result.status === 'permission_denied') {
    Notifications.notify({ title: translate('notif.group_suggest.ai_unavailable') })
  } else {
    Notifications.notify({ title: translate('notif.group_suggest.ai_failed') })
  }
}

export async function suggestTabsForGroup(groupTabId: ID): Promise<void> {
  const result = await suggestTabsForGroupViaAI(groupTabId)
  notifyAboutAISuggestResult(result)
}

interface GroupOnClosingConf {
  ids: ID[]
  title: string
  active: boolean
}
let grouppingTimeout: number | undefined
const grouppingBuffers: Map<ID, GroupOnClosingConf> = new Map()
export function groupOnClosing(id: ID, title: string, active: boolean, childTabId: ID) {
  let conf = grouppingBuffers.get(id)
  if (!conf) {
    conf = { title, active, ids: [] }
    grouppingBuffers.set(id, conf)
  }
  conf.ids.push(childTabId)

  clearTimeout(grouppingTimeout)
  grouppingTimeout = setTimeout(() => {
    for (const [id, conf] of grouppingBuffers) {
      groupTabs(conf.ids, { title: conf.title, active: conf.active })
    }
    grouppingBuffers.clear()
  }, 250)
}

export function updateGroupTab(groupTab: Tab) {
  const tabsCount = Tabs.list.length
  const tabs: GroupedTabInfo[] = []
  let subGroupLvl = null
  let len = 0

  for (let i = groupTab.index + 1; i < tabsCount; i++) {
    const tab = Tabs.list[i]
    if (tab.lvl <= groupTab.lvl) break
    len++

    if (subGroupLvl && tab.lvl > subGroupLvl) continue
    else subGroupLvl = null
    if (tab.isGroup) subGroupLvl = tab.lvl

    tabs.push({
      id: tab.id,
      index: tab.index,
      lvl: tab.lvl - groupTab.lvl - 1,
      title: tab.customTitle ?? tab.title,
      url: tab.url,
      discarded: !!tab.discarded,
      favIconUrl: tab.favIconUrl ?? '',
    })
  }

  const msg: GroupMsg = {
    index: groupTab.index,
    windowId: Windows.id,
    parentId: groupTab.parentId,
    tabs,
    len,
  }

  const parentTab = Tabs.byId[groupTab.parentId]
  if (parentTab && parentTab.isGroup) {
    msg.parentId = parentTab.id
  }

  IPC.groupPage(groupTab.id, msg)
}
const updateGroupTabDebounced = Utils.debounce(updateGroupTab)

export function updateActiveGroupPage(): void {
  let activeTab = Tabs.byId[Tabs.activeId]
  if (!activeTab) activeTab = Tabs.list.find(t => t.active)
  if (!activeTab) return
  if (activeTab.isGroup) {
    updateGroupTabDebounced(256, activeTab)
  }
}

const updateGroupChildTimeouts: Record<ID, number> = {}
export function updateGroupChild(groupId: ID, childId: ID, delay = 250): void {
  clearTimeout(updateGroupChildTimeouts[childId])
  updateGroupChildTimeouts[childId] = setTimeout(() => {
    const groupTab = Tabs.byId[groupId]
    const childTab = Tabs.byId[childId]
    if (!groupTab || groupTab.discarded || !childTab) return

    const updatedTab: GroupedTabInfo = {
      id: childTab.id,
      index: childTab.index,
      status: childTab.status,
      title: childTab.title,
      url: childTab.url,
      lvl: childTab.lvl - groupTab.lvl - 1,
      discarded: !!childTab.discarded,
      favIconUrl: childTab.favIconUrl || Favicons.getFavicon(childTab.url),
    }
    IPC.groupPage(groupTab.id, { updatedTab })
  }, delay)
}

function getGroupConfig(groupTabId: ID): GroupConfig | undefined {
  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab) return

  const config = parseGroupUrl(groupTab.url)
  if (!config) return

  config.active = groupTab.active

  return config
}

function parseGroupUrl(url: string): GroupConfig | undefined {
  let urlInfo
  try {
    urlInfo = new URL(url)
  } catch {
    return
  }
  if (!urlInfo.hash) urlInfo.hash = ''

  const config: GroupConfig = {}
  const title = decodeURIComponent(urlInfo.hash.slice(1))

  // Remove legacy "id"
  config.title = title.split(':id:')[0]

  const pin = urlInfo.searchParams.get('pin')
  if (pin) {
    const [container, url] = pin.split('::')
    let pinnedTab
    for (const tab of Tabs.list) {
      if (!tab.pinned) break
      if (url === tab.url && container === tab.cookieStoreId) {
        pinnedTab = tab
        break
      }
    }
    if (pinnedTab) {
      config.pin = pin
      config.pinnedTab = pinnedTab
    }
  }

  return config
}

export function setGroupName(groupTabId: ID, newName: string) {
  const groupTab = Tabs.byId[groupTabId]
  if (!groupTab) return

  const config = getGroupConfig(groupTabId)
  if (!config) return

  const isDiscarded = groupTab.discarded
  const newUrl = Utils.createGroupUrl(newName, config)
  browser.tabs
    .update(groupTabId, { url: newUrl })
    .then(() => {
      if (!isDiscarded) return IPC.groupPage(groupTabId, { title: newName })
    })
    .catch(() => {
      Logs.warn('setGroupName: Cannot update url')
    })
}
