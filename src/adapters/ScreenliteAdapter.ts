import type { CMSAdapter, PairableCMSAdapter, Playlist } from '../types'
import { getDeviceTelemetry } from '../utils/getDeviceTelemetry'
import { ScreenlitePlayerApiClient } from './ScreenlitePlayerApiClient'
import type {
    PairConsumeRequest,
    PlayerPairConsumeResponse,
    PlayerPlaylistDto,
    PlayerScheduleResponse,
    PlayerTemplateDto,
    PlayerTemplateElementDto,
    PlayerTemplateLayoutDto,
    PlayerTemplateResponse,
} from '../types/screenliteApi'

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
    private scheduleTimeoutId: ReturnType<typeof setTimeout> | null = null
    private readonly heartbeatIntervalMs = 30000
    private readonly heartbeatBackoffMs = [5000, 10000, 20000, 40000, 60000] as const
    private readonly schedulePollIntervalMs = 60000
    private readonly requestTimeoutMs = 10000
    private heartbeatFailureCount = 0
    private heartbeatInFlight = false
    private scheduleInFlight = false
    private pendingImmediateSchedulePoll = false
    private lastTemplateSignature: string | null = null
    private lifecycleId = 0
    private resumeListenerAttached = false
    private readonly onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            this.requestImmediateSchedulePoll()
        }
    }
    private readonly onOnline = () => {
        this.requestImmediateSchedulePoll()
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
        this.clearStoredLink()
        this.updateStatus('waiting_for_pairing')
    }

    disconnect() {
        this.lifecycleId += 1
        this.connected = false
        this.stopLoops()
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
        this.heartbeatFailureCount = 0

        const heartbeatOk = await this.sendHeartbeatOnce()
        if (!this.connected || lifecycleId !== this.lifecycleId) {
            return
        }

        if (!heartbeatOk) {
            this.scheduleNextHeartbeat(this.getHeartbeatRetryDelay())
            return
        }

        const templateOk = await this.pollTemplateOnce()
        if (!this.connected || lifecycleId !== this.lifecycleId) {
            return
        }

        if (!templateOk) {
            this.updateStatus('offline')
            this.scheduleNextHeartbeat(this.getHeartbeatRetryDelay())
            this.scheduleNextPoll(0)
            return
        }

        const scheduleOk = await this.pollScheduleOnce()
        if (!this.connected || lifecycleId !== this.lifecycleId) {
            return
        }

        if (!scheduleOk) {
            this.updateStatus('offline')
            this.scheduleNextHeartbeat(this.getHeartbeatRetryDelay())
            this.scheduleNextPoll(0)
            return
        }

        this.heartbeatFailureCount = 0
        this.updateStatus('connected')
        this.scheduleNextHeartbeat(this.heartbeatIntervalMs)
        this.scheduleNextPoll(this.schedulePollIntervalMs)
    }

    private stopLoops(): void {
        if (this.heartbeatTimeoutId !== null) {
            clearTimeout(this.heartbeatTimeoutId)
            this.heartbeatTimeoutId = null
        }
        if (this.scheduleTimeoutId !== null) {
            clearTimeout(this.scheduleTimeoutId)
            this.scheduleTimeoutId = null
        }
        this.heartbeatInFlight = false
        this.scheduleInFlight = false
        this.pendingImmediateSchedulePoll = false
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

    private async runScheduleCycle(): Promise<void> {
        if (!this.connected) {
            return
        }

        if (this.scheduleInFlight) {
            this.pendingImmediateSchedulePoll = true
            return
        }

        this.scheduleInFlight = true
        const templateOk = await this.pollTemplateOnce()
        const scheduleOk = await this.pollScheduleOnce()
        this.scheduleInFlight = false

        if (!this.connected) {
            return
        }

        if ((!templateOk || !scheduleOk) && this.status !== 'unauthorized') {
            this.updateStatus('offline')
        }

        if (this.pendingImmediateSchedulePoll) {
            this.pendingImmediateSchedulePoll = false
            this.scheduleNextPoll(0)
            return
        }

        this.scheduleNextPoll(this.schedulePollIntervalMs)
    }

    private async pollScheduleOnce(): Promise<boolean> {
        if (!this.connected) {
            return false
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return false
        }

        const response = await this.apiClient.getSchedule(this.token, this.getLinkedScreenId() ?? undefined)

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Schedule request unauthorized, clearing device token')
            this.handleUnauthorized()
            return false
        }

        if (response.ok && response.data) {
            const playlists = this.extractPlaylists(response.data)
            if (playlists) {
                return true
            }

            return false
        } else {
            console.warn('ScreenliteAdapter: Schedule poll failed, keeping previous schedule', response.error)
            return false
        }
    }

    private async pollTemplateOnce(): Promise<boolean> {
        if (!this.connected) {
            return false
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return false
        }

        const response = await this.apiClient.getTemplates(this.token, this.getLinkedScreenId() ?? undefined)

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Template request unauthorized, clearing device token')
            this.handleUnauthorized()
            return false
        }

        if (!response.ok || !response.data) {
            console.warn('ScreenliteAdapter: Template poll failed, keeping previous template', response.error)
            return false
        }

        const templates = this.extractTemplates(response.data)
        if (templates === null) {
            return false
        }

        const playlists = this.normalizeTemplatePlaylists(templates)
        this.emitTemplateUpdate(playlists)
        return true
    }

    private scheduleNextPoll(delayMs: number = this.schedulePollIntervalMs): void {
        if (!this.connected) {
            return
        }

        if (this.scheduleTimeoutId !== null) {
            clearTimeout(this.scheduleTimeoutId)
        }

        this.scheduleTimeoutId = setTimeout(() => {
            void this.runScheduleCycle()
        }, delayMs)
    }

    private requestImmediateSchedulePoll(): void {
        if (!this.connected || !this.token) {
            return
        }

        if (this.scheduleInFlight) {
            this.pendingImmediateSchedulePoll = true
            return
        }

        this.scheduleNextPoll(0)
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
                    },
                    items: [
                        {
                            id: `${templateId}-item-${elementIndex}`,
                            content_type: normalized.contentType,
                            content_path: normalized.contentPath,
                            duration: 3600,
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
                sections,
            }
        })
    }

    private normalizeTemplateLayout(layout?: PlayerTemplateLayoutDto): Required<PlayerTemplateLayoutDto> {
        return {
            width: Number(layout?.width ?? 1920),
            height: Number(layout?.height ?? 1080),
            background: String(layout?.background ?? '#000000'),
            elements: Array.isArray(layout?.elements) ? layout.elements : [],
        }
    }

    private normalizeTemplateElement(element: PlayerTemplateElementDto): {
        x: number
        y: number
        width: number
        height: number
        contentType: string
        contentPath: string
    } {
        const x = Number(element.x ?? 0)
        const y = Number(element.y ?? 0)
        const width = Number(element.width ?? 200)
        const height = Number(element.height ?? 100)
        const type = String(element.type ?? '').toLowerCase()

        if (type === 'image' && element.imageUrl) {
            return {
                x,
                y,
                width,
                height,
                contentType: 'image',
                contentPath: String(element.imageUrl),
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
            contentType: 'text',
            contentPath: JSON.stringify(textPayload),
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
        this.clearStoredLink()
        this.updateStatus('unauthorized')
    }

    private clearStoredLink(): void {
        this.token = null
        this.linkedDevice = null
        this.lastTemplateSignature = null
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
