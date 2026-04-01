import type { CMSAdapter, PairableCMSAdapter, Playlist } from '../types'
import { getDeviceTelemetry } from '../utils/getDeviceTelemetry'

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

type PairResponse = {
    deviceToken?: string
    token?: string
    deviceId?: string
    screenId?: string
    data?: {
        deviceToken?: string
        token?: string
        deviceId?: string
        screenId?: string
    }
}

type ScheduleResponse = {
    playlists?: unknown
    schedules?: unknown[]
    schedule?: {
        playlists?: unknown
        schedules?: unknown[]
    }
    data?: {
        playlists?: unknown
        schedules?: unknown[]
    }
}

type LinkedDeviceInfo = {
    deviceId: string | null
    screenId: string | null
    linkedAt: string
}

export class ScreenliteAdapter implements CMSAdapter, PairableCMSAdapter {
    private baseUrl: string
    private defaultPairingCode: string
    private token: string | null
    private linkedDevice: LinkedDeviceInfo | null
    private connected = false
    private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null
    private scheduleTimeoutId: ReturnType<typeof setTimeout> | null = null
    private readonly heartbeatIntervalMs = 60000
    private readonly schedulePollIntervalMs = 20000
    private readonly requestTimeoutMs = 10000
    private status: ConnectionStatus = 'disconnected'
    private statusCallback: ((status: string) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private callback: ((state: any) => void) | null = null

    constructor(cmsUrl: string, defaultPairingCode: string = '') {
        this.baseUrl = this.normalizeBaseUrl(cmsUrl)
        this.defaultPairingCode = defaultPairingCode
        this.token = localStorage.getItem(TOKEN_STORAGE_KEY)
        this.linkedDevice = this.readLinkedDevice()
    }

    connect() {
        this.connected = true
        this.updateStatus('connecting')

        this.token = localStorage.getItem(TOKEN_STORAGE_KEY)
        this.linkedDevice = this.readLinkedDevice()

        if (this.token) {
            this.startLoops()
            this.updateStatus('connected')
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

            const body = {
                pairingCode: code,
                serialNumber: serial,
                deviceName: telemetry.hostname || serial,
                platform: telemetry.platform,
                timezone: telemetry.timezone,
                telemetry,
            }

            const response = await this.fetchJson<PairResponse>('/api/player/pair/consume', {
                method: 'POST',
                body: JSON.stringify(body),
            })

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
                this.startLoops(true)
            }
            this.updateStatus('connected')
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
        this.connected = false
        this.stopLoops()
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

    private startLoops(runImmediatePoll: boolean = true): void {
        this.stopLoops()
        this.startHeartbeatLoop()

        if (runImmediatePoll) {
            void this.pollSchedule()
        } else {
            this.scheduleNextPoll()
        }
    }

    private stopLoops(): void {
        if (this.heartbeatIntervalId !== null) {
            clearInterval(this.heartbeatIntervalId)
            this.heartbeatIntervalId = null
        }
        if (this.scheduleTimeoutId !== null) {
            clearTimeout(this.scheduleTimeoutId)
            this.scheduleTimeoutId = null
        }
    }

    private startHeartbeatLoop(): void {
        void this.sendHeartbeat()
        this.heartbeatIntervalId = setInterval(() => {
            void this.sendHeartbeat()
        }, this.heartbeatIntervalMs)
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            return
        }

        const screenId = this.getLinkedScreenId()
        const heartbeatBody = screenId ? JSON.stringify({ screenId }) : undefined

        const response = await this.fetchJson<Record<string, unknown>>('/api/player/heartbeat', {
            method: 'POST',
            headers: {
                'X-Device-Token': this.token,
            },
            body: heartbeatBody,
        })

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Heartbeat unauthorized, clearing device token')
            this.handleUnauthorized()
            return
        }

        if (response.ok) {
            if (this.status === 'offline' || this.status === 'connecting') {
                this.updateStatus('connected')
            }
            return
        }

        this.updateStatus('offline')
        console.warn('ScreenliteAdapter: Heartbeat failed, will retry', response.error)
    }

    private async pollSchedule(): Promise<void> {
        if (!this.connected) {
            return
        }

        if (!this.token) {
            this.updateStatus('waiting_for_pairing')
            this.scheduleNextPoll()
            return
        }

        const response = await this.fetchJson<ScheduleResponse>(this.buildScheduleEndpoint(), {
            method: 'GET',
            headers: {
                'X-Device-Token': this.token,
            },
        })

        if (response.unauthorized) {
            console.warn('ScreenliteAdapter: Schedule request unauthorized, clearing device token')
            this.handleUnauthorized()
            return
        }

        if (response.ok && response.data) {
            const playlists = this.extractPlaylists(response.data)
            if (playlists) {
                this.callback?.(playlists)
                this.updateStatus('connected')
            }
        } else {
            console.warn('ScreenliteAdapter: Schedule poll failed, keeping previous schedule', response.error)
        }

        this.scheduleNextPoll()
    }

    private scheduleNextPoll(): void {
        if (!this.connected) {
            return
        }

        this.scheduleTimeoutId = setTimeout(() => {
            void this.pollSchedule()
        }, this.schedulePollIntervalMs)
    }

    private extractPlaylists(payload: unknown): Playlist[] | null {
        if (Array.isArray(payload)) {
            return this.normalizePlaylists(payload)
        }

        if (payload && typeof payload === 'object') {
            const body = payload as ScheduleResponse
            const candidate = body.playlists ?? body.schedule?.playlists ?? body.data?.playlists

            if (Array.isArray(candidate)) {
                return this.normalizePlaylists(candidate)
            }

            const mergedCandidate = body.schedules ?? body.schedule?.schedules ?? body.data?.schedules
            if (Array.isArray(mergedCandidate)) {
                const flattened = mergedCandidate
                    .map(value => {
                        if (Array.isArray(value)) {
                            return value
                        }

                        if (value && typeof value === 'object') {
                            const scheduleGroup = value as { playlists?: unknown }
                            if (Array.isArray(scheduleGroup.playlists)) {
                                return scheduleGroup.playlists
                            }
                        }

                        return []
                    })
                    .flat()

                if (flattened.length > 0) {
                    return this.normalizePlaylists(flattened)
                }
            }
        }

        console.warn('ScreenliteAdapter: Unexpected schedule payload shape', payload)
        return null
    }

    private normalizePlaylists(rawPlaylists: unknown[]): Playlist[] {
        return rawPlaylists.map((raw, index) => {
            const value = (raw ?? {}) as Record<string, unknown>

            return {
                id: String(value.id ?? `playlist-${index}`),
                start_date: String(value.start_date ?? value.startDate ?? '2000-01-01'),
                end_date: String(value.end_date ?? value.endDate ?? '2099-12-31'),
                start_time: String(value.start_time ?? value.startTime ?? '00:00:00'),
                end_time: String(value.end_time ?? value.endTime ?? '23:59:59'),
                width: Number(value.width ?? 1920),
                height: Number(value.height ?? 1080),
                sections: Array.isArray(value.sections) ? (value.sections as Playlist['sections']) : [],
            }
        })
    }

    private extractPairPayload(payload: PairResponse | null): {
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

    private async fetchJson<T>(
        endpoint: string,
        init: RequestInit,
    ): Promise<{ ok: boolean; unauthorized: boolean; data: T | null; error: string | null }> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs)

        try {
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                ...init,
                headers: {
                    'Content-Type': 'application/json',
                    ...(init.headers || {}),
                },
                signal: controller.signal,
            })

            if (response.status === 401 || response.status === 403) {
                return { ok: false, unauthorized: true, data: null, error: `Unauthorized (${response.status})` }
            }

            if (!response.ok) {
                const contentType = response.headers.get('content-type') || ''
                let errorBody = ''

                try {
                    if (contentType.includes('application/json')) {
                        const parsed = await response.json()
                        errorBody = JSON.stringify(parsed)
                    } else {
                        errorBody = await response.text()
                    }
                } catch {
                    errorBody = ''
                }

                const details = errorBody ? ` - ${errorBody}` : ''
                return { ok: false, unauthorized: false, data: null, error: `HTTP ${response.status}${details}` }
            }

            if (response.status === 204) {
                return { ok: true, unauthorized: false, data: null, error: null }
            }

            const data = (await response.json()) as T
            return { ok: true, unauthorized: false, data, error: null }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            return { ok: false, unauthorized: false, data: null, error: msg }
        } finally {
            clearTimeout(timeoutId)
        }
    }

    private handleUnauthorized(): void {
        this.stopLoops()
        this.clearStoredLink()
        this.updateStatus('unauthorized')
    }

    private clearStoredLink(): void {
        this.token = null
        this.linkedDevice = null
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

    private buildScheduleEndpoint(): string {
        const screenId = this.getLinkedScreenId()
        if (!screenId) {
            return '/api/player/schedule'
        }

        const query = new URLSearchParams({ screenId }).toString()
        return `/api/player/schedule?${query}`
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
