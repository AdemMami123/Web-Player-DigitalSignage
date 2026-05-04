import { Client } from '@stomp/stompjs'
import SockJS from 'sockjs-client'
import type { CMSAdapter, PairableCMSAdapter, Playlist } from '../types'
import type {
    PairConsumeRequest,
    PlayerContentSyncPayload,
    PlayerPairConsumeResponse,
    PlayerPlaylistDto,
    PlayerScheduleResponse,
    PlayerScreenStatusPayload,
    PlayerTemplateDto,
    PlayerTemplateElementDto,
    PlayerTemplateLayoutDto,
    PlayerTemplateResponse,
    PlayerWsUpdateEvent,
} from '../types/screenliteApi'
import { getDeviceTelemetry } from '../utils/getDeviceTelemetry'
import { runtimeClock } from '../services/runtimeClock'
import { ScreenlitePlayerApiClient } from './ScreenlitePlayerApiClient'

const TOKEN_STORAGE_KEY = 'screenlite_device_token'
const LINKED_DEVICE_STORAGE_KEY = 'screenlite_linked_device'
const DEVICE_METADATA_STORAGE_KEY = 'screenlite_device_metadata'

type ConnectionStatus =
    | 'disconnected'
    | 'waiting_for_pairing'
    | 'connecting'
    | 'connected'
    | 'offline'
    | 'unauthorized'
    | 'error'

type LinkedDeviceInfo = {
    deviceId: string | null
    screenId: string | null
    linkedAt: string
}

export class ScreenliteAdapter implements CMSAdapter, PairableCMSAdapter {
    private baseUrl: string
    private apiClient: ScreenlitePlayerApiClient
    private defaultPairingCode: string
    private token: string | null
    private linkedDevice: LinkedDeviceInfo | null
    private connected = false
    private heartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null
    private readonly heartbeatIntervalMs = 30000
    private readonly heartbeatBackoffMs = [5000, 10000, 20000, 40000, 60000] as const
    private readonly websocketReconnectDelayMs = 5000
    private readonly requestTimeoutMs = 10000
    private heartbeatFailureCount = 0
    private heartbeatInFlight = false
    private bootstrapInFlight = false
    private lastTemplateSignature: string | null = null
    private stompClient: Client | null = null
    private latestTemplateByScreenId = new Map<string, PlayerTemplateDto>()
    private latestScheduleByScreenId = new Map<string, PlayerScheduleResponse | PlayerPlaylistDto[]>()
    private latestCompiledPlaylistByScreenId = new Map<string, unknown>()
    private compiledPlaylistTimers = new Map<string, number>()
    private latestTemplatesListByScreenId = new Map<string, PlayerTemplateDto[]>()
    private lifecycleId = 0
    private resumeListenerAttached = false
    private readonly onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            this.requestImmediateBootstrap()
        }
    }
    private readonly onOnline = () => {
        this.requestImmediateBootstrap()
    }
    private status: ConnectionStatus = 'disconnected'
    private statusCallback: ((status: string) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private callback: ((state: any) => void) | null = null

    constructor(cmsUrl: string, defaultPairingCode: string = '') {
        this.baseUrl = this.normalizeBaseUrl(cmsUrl)
        this.apiClient = new ScreenlitePlayerApiClient(this.baseUrl, this.requestTimeoutMs)
        this.defaultPairingCode = defaultPairingCode
        this.token = localStorage.getItem(TOKEN_STORAGE_KEY)
        this.linkedDevice = this.readLinkedDevice()
    }

    connect() {
        this.lifecycleId += 1
        this.connected = true
        this.updateStatus('connecting')

        this.token = localStorage.getItem(TOKEN_STORAGE_KEY)
        this.linkedDevice = this.readLinkedDevice()

        this.attachResumeAndReconnectListeners()

        if (this.token) {
            void this.bootstrapAuthenticatedSession(this.lifecycleId)
            return
        }

        this.updateStatus('waiting_for_pairing')
    }

    async pair(pairingCode?: string): Promise<boolean> {
        const code = (pairingCode ?? this.defaultPairingCode).trim()

        if (!code) {
            console.warn('ScreenliteAdapter: Pairing code is required')
            this.updateStatus('waiting_for_pairing')
            return false
        }

        try {
            const telemetry = await getDeviceTelemetry()
            const serial = this.buildSerial(telemetry)

            localStorage.setItem(DEVICE_METADATA_STORAGE_KEY, JSON.stringify(telemetry))

            const body: PairConsumeRequest = {
                pairingCode: code,
                serialNumber: serial,
                deviceName: telemetry.hostname || serial,
                platform: telemetry.platform,
                timezone: telemetry.timezone,
                telemetry,
            }

            const response = await this.apiClient.pair(body)

            if (!response.ok) {
                console.error('ScreenliteAdapter: Pairing request failed', response.error)
                this.updateStatus('error')
                return false
            }

            const pairPayload = this.extractPairPayload(response.data)
            const deviceToken = pairPayload.deviceToken
            const deviceId = pairPayload.deviceId
            const screenId = pairPayload.screenId

            if (!deviceToken) {
                console.error('ScreenliteAdapter: Pair response did not contain deviceToken', response.data)
                this.updateStatus('error')
                return false
            }

            this.token = deviceToken
            this.linkedDevice = {
                deviceId,
                screenId,
                linkedAt: new Date().toISOString(),
            }

            localStorage.setItem(TOKEN_STORAGE_KEY, deviceToken)
            localStorage.setItem(LINKED_DEVICE_STORAGE_KEY, JSON.stringify(this.linkedDevice))

            console.info('ScreenliteAdapter: Pairing successful', { deviceId, screenId })

            if (this.connected) {
                this.updateStatus('connecting')
                void this.bootstrapAuthenticatedSession(this.lifecycleId)
                return true
            }

            this.updateStatus('waiting_for_pairing')
            return true
        } catch (error) {
            console.error('ScreenliteAdapter: Pairing failed', error)
            this.updateStatus('error')
            return false
        }
    }

    unpair(): void {
        this.stopLoops()
        this.disconnectWebSocket()
        this.clearStoredLink()
        this.updateStatus('waiting_for_pairing')
    }

    disconnect() {
        this.lifecycleId += 1
        this.connected = false
        this.stopLoops()
        this.disconnectWebSocket()
        this.detachResumeAndReconnectListeners()
        this.updateStatus('disconnected')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onUpdate(callback: (state: any) => void) {
        this.callback = callback
    }

    onConnectionStatusChange(callback: (status: string) => void): void {
        this.statusCallback = callback
        callback(this.status)
    }

    getConnectionStatus(): string {
        return this.status
    }

    private async bootstrapAuthenticatedSession(lifecycleId: number): Promise<void> {
        if (!this.connected || lifecycleId !== this.lifecycleId || !this.token) {
            return
        }

        this.stopLoops()
        this.disconnectWebSocket()
        this.heartbeatFailureCount = 0

        const heartbeatOk = await this.sendHeartbeatOnce()

        if (!this.connected || lifecycleId !== this.lifecycleId) {
            return
        }

        if (!heartbeatOk) {
            this.scheduleNextHeartbeat(this.getHeartbeatRetryDelay())
            return
        }

        const bootstrapOk = await this.runFullBootstrapOnce()

        if (!this.connected || lifecycleId !== this.lifecycleId) {
            return
        }

        this.heartbeatFailureCount = 0
        this.connectWebSocket(lifecycleId)
        this.updateStatus(bootstrapOk ? 'connected' : 'offline')
        this.scheduleNextHeartbeat(this.heartbeatIntervalMs)
    }

    private stopLoops(): void {
        if (this.heartbeatTimeoutId !== null) {
            clearTimeout(this.heartbeatTimeoutId)
            this.heartbeatTimeoutId = null
        }
        this.heartbeatInFlight = false
        this.bootstrapInFlight = false
    }

    private scheduleNextHeartbeat(delayMs: number): void {
        if (!this.connected) {
            return
        }

        if (this.heartbeatTimeoutId !== null) {
            clearTimeout(this.heartbeatTimeoutId)
        }

        this.heartbeatTimeoutId = setTimeout(() => {
            void this.runHeartbeatCycle()
        }, delayMs)
    }

    private async runHeartbeatCycle(): Promise<void> {
        if (!this.connected || this.heartbeatInFlight) {
            return
        }

        this.heartbeatInFlight = true
        const ok = await this.sendHeartbeatOnce()

        this.heartbeatInFlight = false

        if (!this.connected) {
            return
        }

        if (ok) {
            this.heartbeatFailureCount = 0
            this.updateStatus('connected')
            this.scheduleNextHeartbeat(this.heartbeatIntervalMs)
            return
        }

        this.heartbeatFailureCount += 1
        this.updateStatus('offline')
        this.scheduleNextHeartbeat(this.getHeartbeatRetryDelay())
    }

    private getHeartbeatRetryDelay(): number {
        const index = Math.min(this.heartbeatFailureCount, this.heartbeatBackoffMs.length - 1)

        return this.heartbeatBackoffMs[index]
    }

    private async sendHeartbeatOnce(): Promise<boolean> {
        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return false
        }

        const screenId = this.getLinkedScreenId()
        const response = await this.apiClient.heartbeat(this.token, screenId ? { screenId } : {})

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Heartbeat unauthorized, clearing device token')
            this.handleUnauthorized()
            return false
        }

        if (response.ok) {
            return true
        }

        console.warn('ScreenliteAdapter: Heartbeat failed, will retry', response.error)
        return false
    }

    private async fetchScheduleOnce(): Promise<PlayerScheduleResponse | PlayerPlaylistDto[] | null> {
        if (!this.connected) {
            return null
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return null
        }

        const response = await this.apiClient.getSchedule(this.token, this.getLinkedScreenId() ?? undefined)

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Schedule request unauthorized, clearing device token')
            this.handleUnauthorized()
            return null
        }

        if (response.ok && response.data) {
            return response.data
        }

        console.warn('ScreenliteAdapter: Schedule bootstrap failed, keeping previous state', response.error)
        return null
    }

    private async fetchCompiledPlaylistOnce(): Promise<unknown | null> {
        if (!this.connected) {
            return null
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return null
        }

        const deviceId = this.linkedDevice?.deviceId
        const screenId = this.getLinkedScreenId()

        const response = await this.apiClient.getCompiledPlaylist(this.token, deviceId ?? undefined, screenId ?? undefined)

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Compiled playlist request unauthorized, clearing device token')
            this.handleUnauthorized()
            return null
        }

        if (response.ok && response.data) {
            return response.data
        }

        console.warn('ScreenliteAdapter: Compiled playlist fetch failed', response.error)
        return null
    }

    private async fetchTemplatesOnce(): Promise<PlayerTemplateDto[] | null> {
        if (!this.connected) {
            return null
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return null
        }

        const response = await this.apiClient.getTemplates(this.token, this.getLinkedScreenId() ?? undefined)

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Template request unauthorized, clearing device token')
            this.handleUnauthorized()
            return null
        }

        if (!response.ok || !response.data) {
            console.warn('ScreenliteAdapter: Template bootstrap failed, keeping previous state', response.error)
            return null
        }

        return this.extractTemplates(response.data)
    }

    private requestImmediateBootstrap(): void {
        if (!this.connected || !this.token) {
            return
        }

        void this.runFullBootstrapOnce()
        this.connectWebSocket(this.lifecycleId)
    }

    private attachResumeAndReconnectListeners(): void {
        if (this.resumeListenerAttached) {
            return
        }

        document.addEventListener('visibilitychange', this.onVisibilityChange)
        window.addEventListener('online', this.onOnline)
        this.resumeListenerAttached = true
    }

    private detachResumeAndReconnectListeners(): void {
        if (!this.resumeListenerAttached) {
            return
        }

        document.removeEventListener('visibilitychange', this.onVisibilityChange)
        window.removeEventListener('online', this.onOnline)
        this.resumeListenerAttached = false
    }

    private connectWebSocket(lifecycleId: number): void {
        if (!this.connected || lifecycleId !== this.lifecycleId || !this.token) {
            return
        }

        if (this.stompClient?.active) {
            return
        }

        const deviceId = this.linkedDevice?.deviceId

        if (!deviceId) {
            console.warn('ScreenliteAdapter: Missing deviceId; cannot subscribe to websocket updates')
            return
        }

        const client = new Client({
            webSocketFactory: () => new SockJS(this.buildSockJsHttpUrl()),
            connectHeaders: {
                'X-Device-Token': this.token,
            },
            reconnectDelay: this.websocketReconnectDelayMs,
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
        })

        client.onConnect = () => {
            if (!this.connected || lifecycleId !== this.lifecycleId) {
                return
            }

            const destination = `/topic/player/devices/${deviceId}/updates`

            client.subscribe(destination, message => {
                this.handleWsMessage(message.body)
            })

            // Re-run a full REST bootstrap on every websocket reconnect.
            void this.runFullBootstrapOnce()
            this.updateStatus('connected')
        }

        client.onStompError = frame => {
            console.warn('ScreenliteAdapter: STOMP broker error', frame.headers['message'], frame.body)
            if (this.status !== 'unauthorized' && this.status !== 'waiting_for_pairing') {
                this.updateStatus('offline')
            }
        }

        client.onWebSocketClose = () => {
            if (this.connected && this.status !== 'unauthorized' && this.status !== 'waiting_for_pairing') {
                this.updateStatus('offline')
            }
        }

        client.onWebSocketError = event => {
            console.warn('ScreenliteAdapter: WebSocket transport error', event)
        }

        this.stompClient = client
        client.activate()
    }

    private disconnectWebSocket(): void {
        const client = this.stompClient

        this.stompClient = null
        if (client) {
            void client.deactivate()
        }
    }

    private buildSockJsHttpUrl(): string {
        const parsed = new URL(this.baseUrl)
        const basePath = parsed.pathname.replace(/\/$/, '')

        return `${parsed.protocol}//${parsed.host}${basePath}/api/ws-player`
    }

    private handleWsMessage(rawMessage: string): void {
        try {
            const event = JSON.parse(rawMessage) as PlayerWsUpdateEvent

            this.applyRuntimeClockSync(event)
            const type = String(event.type ?? '').toUpperCase()

            if (type === 'CONTENT_SYNC') {
                this.handleContentSyncEvent(event)
                return
            }

            if (type === 'SCREEN_STATUS') {
                this.handleScreenStatusEvent(event)
            }
        } catch (error) {
            console.warn('ScreenliteAdapter: Failed to parse websocket message', rawMessage, error)
        }
    }

    private applyRuntimeClockSync(event: PlayerWsUpdateEvent): void {
        const payload =
            event.payload && typeof event.payload === 'object'
                ? (event.payload as PlayerContentSyncPayload | PlayerScreenStatusPayload)
                : null

        const serverEpochMs = this.coerceNumber(payload?.serverEpochMs ?? event.serverEpochMs)
        const recommendedClockTickMs = this.coerceNumber(
            payload?.recommendedClockTickMs ?? event.recommendedClockTickMs,
        )
        const serverTimeZone = this.coerceString(payload?.serverTimeZone ?? event.serverTimeZone)

        runtimeClock.sync(serverEpochMs ?? undefined, recommendedClockTickMs ?? undefined, serverTimeZone ?? undefined)
    }

    private coerceNumber(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }

        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value)

            return Number.isFinite(parsed) ? parsed : null
        }

        return null
    }

    private coerceString(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null
        }

        const trimmed = value.trim()

        return trimmed.length > 0 ? trimmed : null
    }

    private handleContentSyncEvent(event: PlayerWsUpdateEvent): void {
        const payload =
            event.payload && typeof event.payload === 'object' ? (event.payload as PlayerContentSyncPayload) : null
        const incomingTemplate = payload?.template ?? event.template ?? null
        const incomingSchedule = payload?.schedule ?? event.schedule ?? null
        const screenId = this.resolveEventScreenId(
            payload?.screenId ?? event.screenId ?? incomingTemplate?.screenId ?? null,
        )

        if (!this.shouldProcessScreen(screenId)) {
            return
        }

        const screenKey = this.screenMapKey(screenId)

        if (incomingTemplate === null) {
            this.latestTemplateByScreenId.delete(screenKey)
        } else if (incomingTemplate) {
            this.latestTemplateByScreenId.set(screenKey, incomingTemplate)
        }

        if (incomingSchedule === null) {
            this.latestScheduleByScreenId.delete(screenKey)
        } else if (incomingSchedule) {
            this.latestScheduleByScreenId.set(screenKey, incomingSchedule)
        }

        const resolvedTemplate = this.latestTemplateByScreenId.get(screenKey) ?? null
        const resolvedSchedule = this.latestScheduleByScreenId.get(screenKey) ?? null

        this.emitResolvedContent(screenId, resolvedTemplate, resolvedSchedule)
    }

    private handleScreenStatusEvent(event: PlayerWsUpdateEvent): void {
        const payload = (event.payload ?? null) as PlayerScreenStatusPayload | null

        if (!payload) {
            return
        }

        const screenId = this.resolveEventScreenId(payload.screenId ?? null)

        if (!this.shouldProcessScreen(screenId)) {
            return
        }

        const status = String(payload.status ?? '').toLowerCase()

        if (status === 'online' || status === 'heartbeat') {
            this.updateStatus('connected')
            return
        }

        if (status === 'offline') {
            this.updateStatus('offline')
        }
    }

    private async runFullBootstrapOnce(): Promise<boolean> {
        if (!this.connected || !this.token) {
            return false
        }

        if (this.bootstrapInFlight) {
            return true
        }

        this.bootstrapInFlight = true

        try {
            const [templates, schedule, compiled] = await Promise.all([
                this.fetchTemplatesOnce(),
                this.fetchScheduleOnce(),
                this.fetchCompiledPlaylistOnce(),
            ])

            if (!this.connected || !this.token) {
                return false
            }

            const activeScreenId = this.getLinkedScreenId()
            const screenKey = this.screenMapKey(activeScreenId)

            if (Array.isArray(templates)) {
                const template = this.pickTemplateForScreen(templates, activeScreenId)

                if (template) {
                    this.latestTemplateByScreenId.set(screenKey, template)
                }

                this.latestTemplatesListByScreenId.set(screenKey, templates)
            }

            if (schedule) {
                this.latestScheduleByScreenId.set(screenKey, schedule)
            }

            if (compiled) {
                this.latestCompiledPlaylistByScreenId.set(screenKey, compiled)
                this.ensureCompiledPlaylistTimer(screenKey)
            } else {
                this.latestCompiledPlaylistByScreenId.delete(screenKey)
                this.clearCompiledPlaylistTimer(screenKey)
            }

            const template = this.latestTemplateByScreenId.get(screenKey) ?? null
            const normalizedSchedule = this.latestScheduleByScreenId.get(screenKey) ?? null

            this.emitResolvedContent(activeScreenId, template, normalizedSchedule)

            return Boolean(template || normalizedSchedule)
        } finally {
            this.bootstrapInFlight = false
        }
    }

    private emitResolvedContent(
        screenId: string | null,
        template: PlayerTemplateDto | null,
        schedule: PlayerScheduleResponse | PlayerPlaylistDto[] | null,
    ): void {
        if (!this.shouldProcessScreen(screenId)) {
            return
        }

        const screenKey = this.screenMapKey(screenId)

        const compiled = this.latestCompiledPlaylistByScreenId.get(screenKey) ?? null

        if (compiled) {
            const compiledPlaylist = compiled as any
            const built = this.buildPlaylistForCurrentCompiledItem(screenKey, compiledPlaylist)

            if (built && built.length > 0) {
                this.emitTemplateUpdate(built)
                return
            }
        }

        const schedulePlaylists = schedule ? this.extractPlaylists(schedule) : null

        if (schedulePlaylists && schedulePlaylists.length > 0) {
            this.emitTemplateUpdate(schedulePlaylists)
            return
        }

        if (template) {
            this.emitTemplateUpdate(this.normalizeTemplatePlaylists([template]))
            return
        }

        this.emitTemplateUpdate([this.buildPlaceholderPlaylist()])
    }

    private buildPlaylistForCurrentCompiledItem(screenKey: string, compiled: any): Playlist[] | null {
        try {
            const items = Array.isArray(compiled.items) ? compiled.items : compiled.data?.items ?? null

            if (!items || items.length === 0) return null

            const durations = items.map((it: any) => Math.max(0, Number(it.duration ?? 10)))
            const total = durations.reduce((s: number, d: number) => s + d, 0)

            if (total <= 0) return null

            const compiledAtMs = compiled.compiledAt ? Date.parse(String(compiled.compiledAt)) : 0
            const nowMs = runtimeClock.getNow().getTime()
            const elapsedSec = ((nowMs - (compiledAtMs || 0)) / 1000) % total
            const normalizedElapsed = elapsedSec < 0 ? elapsedSec + total : elapsedSec

            let accum = 0
            let idx = 0
            for (let i = 0; i < durations.length; i++) {
                accum += durations[i]
                if (normalizedElapsed < accum) {
                    idx = i
                    break
                }
            }

            const item = items[idx]
            const templateId = String(item.templateId ?? item.template_id ?? '')

            const templates = this.latestTemplatesListByScreenId.get(screenKey) ?? []
            let tpl = templates.find(t => String(t.templateId ?? '') === templateId) ?? null

            if (!tpl) {
                tpl = this.latestTemplateByScreenId.get(screenKey) ?? null
            }

            if (!tpl) return null

            const playlists = this.normalizeTemplatePlaylists([tpl])

            if (!playlists || playlists.length === 0) return null

            // Override durations on the produced playlist to match compiled item duration
            const duration = Math.max(0, Number(item.duration ?? 10))
            for (const pl of playlists) {
                for (const section of pl.sections ?? []) {
                    for (const it of section.items ?? []) {
                        it.duration = duration
                    }
                }
            }

            return playlists
        } catch (err) {
            console.warn('ScreenliteAdapter: Failed to build playlist from compiled data', err)
            return null
        }
    }

    private ensureCompiledPlaylistTimer(screenKey: string): void {
        if (this.compiledPlaylistTimers.has(screenKey)) return

        const id = window.setInterval(() => {
            const template = this.latestTemplateByScreenId.get(screenKey) ?? null
            const schedule = this.latestScheduleByScreenId.get(screenKey) ?? null
            const screenId = this.getLinkedScreenId()
            this.emitResolvedContent(screenId, template, schedule)
        }, 1000)

        this.compiledPlaylistTimers.set(screenKey, id)
    }

    private clearCompiledPlaylistTimer(screenKey: string): void {
        const id = this.compiledPlaylistTimers.get(screenKey)
        if (id !== undefined) {
            clearInterval(id)
            this.compiledPlaylistTimers.delete(screenKey)
        }
    }

    private pickTemplateForScreen(templates: PlayerTemplateDto[], screenId: string | null): PlayerTemplateDto | null {
        if (templates.length === 0) {
            return null
        }

        if (!screenId) {
            return templates[0] ?? null
        }

        const exact = templates.find(template => this.resolveEventScreenId(template.screenId ?? null) === screenId)

        return exact ?? templates[0] ?? null
    }

    private resolveEventScreenId(screenId: string | null): string | null {
        const normalized = String(screenId ?? '').trim()

        return normalized || null
    }

    private screenMapKey(screenId: string | null): string {
        return screenId ?? '__default__'
    }

    private shouldProcessScreen(screenId: string | null): boolean {
        const mountedScreenId = this.getLinkedScreenId()

        if (!mountedScreenId || !screenId) {
            return true
        }

        return mountedScreenId === screenId
    }

    private extractPlaylists(payload: PlayerScheduleResponse | PlayerPlaylistDto[]): Playlist[] | null {
        if (Array.isArray(payload)) {
            return this.normalizePlaylists(payload)
        }

        if (payload && typeof payload === 'object') {
            const body = payload as PlayerScheduleResponse
            const candidate = body.playlists ?? body.schedule?.playlists ?? body.data?.playlists

            if (Array.isArray(candidate)) {
                return this.normalizePlaylists(candidate)
            }
        }

        console.warn('ScreenliteAdapter: Unexpected schedule payload shape', payload)
        return null
    }

    private extractTemplates(payload: PlayerTemplateResponse): PlayerTemplateDto[] | null {
        if (Array.isArray(payload)) {
            return payload
        }

        if (payload && typeof payload === 'object') {
            const body = payload as Exclude<PlayerTemplateResponse, PlayerTemplateDto[]>
            const candidate = body.templates ?? body.data?.templates

            if (Array.isArray(candidate)) {
                return candidate
            }
        }

        console.warn('ScreenliteAdapter: Unexpected templates payload shape', payload)
        return null
    }

    private normalizeTemplatePlaylists(rawTemplates: PlayerTemplateDto[]): Playlist[] {
        if (rawTemplates.length === 0) {
            return [this.buildPlaceholderPlaylist()]
        }

        return rawTemplates.map((rawTemplate, templateIndex) => {
            const layout = this.normalizeTemplateLayout(rawTemplate.layout)
            const templateId = String(rawTemplate.templateId ?? `template-${templateIndex}`)
            const screenId = String(rawTemplate.screenId ?? this.getLinkedScreenId() ?? 'unassigned-screen')

            const sections = layout.elements.map((element, elementIndex) => {
                const normalized = this.normalizeTemplateElement(element)

                return {
                    id: `${templateId}-section-${elementIndex}`,
                    position: {
                        x: normalized.x,
                        y: normalized.y,
                        width: normalized.width,
                        height: normalized.height,
                        z_index: elementIndex,
                        xPct: normalized.xPct,
                        yPct: normalized.yPct,
                        widthPct: normalized.widthPct,
                        heightPct: normalized.heightPct,
                    },
                    items: [
                        {
                            id: `${templateId}-item-${elementIndex}`,
                            content_type: normalized.contentType,
                            content_path: normalized.contentPath,
                            duration: 3600,
                            objectFit: normalized.objectFit,
                        },
                    ],
                }
            })

            return {
                id: `${screenId}-${templateId}`,
                start_date: '2000-01-01',
                end_date: '2099-12-31',
                start_time: '00:00:00',
                end_time: '23:59:59',
                width: layout.width,
                height: layout.height,
                background: layout.background,
                backgroundColor: layout.backgroundColor,
                backgroundImageUrl: layout.backgroundImageUrl,
                backgroundImageFit: layout.backgroundImageFit,
                sections,
            }
        })
    }

    private normalizeTemplateLayout(layout?: PlayerTemplateLayoutDto): Required<PlayerTemplateLayoutDto> {
        return {
            width: Number(layout?.width ?? 1920),
            height: Number(layout?.height ?? 1080),
            background: String(layout?.background ?? '#000000'),
            backgroundColor: layout?.backgroundColor,
            backgroundImageUrl: layout?.backgroundImageUrl,
            backgroundImageFit: layout?.backgroundImageFit,
            elements: Array.isArray(layout?.elements) ? layout.elements : [],
        }
    }

    private normalizeTemplateElement(element: PlayerTemplateElementDto): {
        x: number
        y: number
        width: number
        height: number
        xPct?: number
        yPct?: number
        widthPct?: number
        heightPct?: number
        contentType: string
        contentPath: string
        objectFit?: 'cover' | 'contain' | 'fill'
    } {
        const x = Number(element.x ?? 0)
        const y = Number(element.y ?? 0)
        const width = Number(element.width ?? 200)
        const height = Number(element.height ?? 100)
        const xPct = element.xPct
        const yPct = element.yPct
        const widthPct = element.widthPct
        const heightPct = element.heightPct
        const type = String(element.type ?? '').toLowerCase()
        const objectFit = element.objectFit

        if (type === 'image' && element.imageUrl) {
            return {
                x,
                y,
                width,
                height,
                xPct,
                yPct,
                widthPct,
                heightPct,
                contentType: 'image',
                contentPath: String(element.imageUrl),
                objectFit,
            }
        }

        const textPayload = {
            text: String(element.text ?? ''),
            style: element.style ?? {},
        }

        return {
            x,
            y,
            width,
            height,
            xPct,
            yPct,
            widthPct,
            heightPct,
            contentType: 'text',
            contentPath: JSON.stringify(textPayload),
            objectFit,
        }
    }

    private buildPlaceholderPlaylist(): Playlist {
        return {
            id: `template-placeholder-${this.getLinkedScreenId() ?? 'unassigned'}`,
            start_date: '2000-01-01',
            end_date: '2099-12-31',
            start_time: '00:00:00',
            end_time: '23:59:59',
            width: 1920,
            height: 1080,
            background: '#000000',
            sections: [],
        }
    }

    private emitTemplateUpdate(playlists: Playlist[]): void {
        const signature = JSON.stringify(playlists)

        if (signature === this.lastTemplateSignature) {
            return
        }

        this.lastTemplateSignature = signature
        this.callback?.(playlists)
    }

    private normalizePlaylists(rawPlaylists: PlayerPlaylistDto[]): Playlist[] {
        return rawPlaylists.map((raw, index) => {
            const value = raw ?? ({} as PlayerPlaylistDto)

            return {
                id: String(value.id ?? `playlist-${index}`),
                start_date: String(value.start_date ?? '2000-01-01'),
                end_date: String(value.end_date ?? '2099-12-31'),
                start_time: String(value.start_time ?? '00:00:00'),
                end_time: String(value.end_time ?? '23:59:59'),
                width: Number(value.width ?? 1920),
                height: Number(value.height ?? 1080),
                background: (value as any)?.background,
                backgroundColor: (value as any)?.backgroundColor,
                backgroundImageUrl: (value as any)?.backgroundImageUrl,
                backgroundImageFit: (value as any)?.backgroundImageFit,
                sections: Array.isArray(value.sections) ? (value.sections as Playlist['sections']) : [],
            }
        })
    }

    private extractPairPayload(payload: PlayerPairConsumeResponse | null): {
        deviceToken: string | null
        deviceId: string | null
        screenId: string | null
    } {
        const root = payload ?? {}
        const nested = root.data ?? {}

        const deviceToken = (root.deviceToken ?? root.token ?? nested.deviceToken ?? nested.token ?? null) as string | null
        const deviceId = (root.deviceId ?? nested.deviceId ?? null) as string | null
        const screenId = (root.screenId ?? nested.screenId ?? null) as string | null

        return { deviceToken, deviceId, screenId }
    }

    private handleUnauthorized(): void {
        this.stopLoops()
        this.disconnectWebSocket()
        this.clearStoredLink()
        this.updateStatus('unauthorized')
    }

    private clearStoredLink(): void {
        this.token = null
        this.linkedDevice = null
        this.lastTemplateSignature = null
        this.latestTemplateByScreenId.clear()
        this.latestScheduleByScreenId.clear()
        this.latestCompiledPlaylistByScreenId.clear()
        this.latestTemplatesListByScreenId.clear()
        for (const key of this.compiledPlaylistTimers.keys()) {
            this.clearCompiledPlaylistTimer(key)
        }
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        localStorage.removeItem(LINKED_DEVICE_STORAGE_KEY)
        localStorage.removeItem(DEVICE_METADATA_STORAGE_KEY)
    }

    private readLinkedDevice(): LinkedDeviceInfo | null {
        try {
            const raw = localStorage.getItem(LINKED_DEVICE_STORAGE_KEY)

            if (!raw) {
                return null
            }
            const parsed = JSON.parse(raw) as LinkedDeviceInfo

            return {
                deviceId: parsed.deviceId ?? null,
                screenId: parsed.screenId ?? null,
                linkedAt: parsed.linkedAt ?? new Date().toISOString(),
            }
        } catch {
            return null
        }
    }

    private normalizeBaseUrl(url: string): string {
        const input = url?.trim() || window.location.origin
        const parsed = new URL(input, window.location.origin)

        return parsed.origin + parsed.pathname.replace(/\/$/, '')
    }

    private getLinkedScreenId(): string | null {
        return this.linkedDevice?.screenId || null
    }

    private buildSerial(telemetry: Awaited<ReturnType<typeof getDeviceTelemetry>>): string {
        const parts = [telemetry.hostname, telemetry.macAddress, telemetry.platform]
            .map(value => String(value || '').trim())
            .filter(Boolean)

        return parts.join('-') || `browser-${Date.now()}`
    }

    private updateStatus(status: ConnectionStatus): void {
        this.status = status
        this.statusCallback?.(status)
    }
}
