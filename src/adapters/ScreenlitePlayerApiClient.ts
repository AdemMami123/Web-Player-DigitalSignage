import type {
    PairConsumeRequest,
    PlayerHeartbeatRequest,
    PlayerHeartbeatResponse,
    PlayerPairConsumeResponse,
    PlayerScheduleResponse,
    PlayerTemplateResponse,
    ScreenliteApiResult,
} from '../types/screenliteApi'

export class ScreenlitePlayerApiClient {
    private readonly baseUrl: string
    private readonly requestTimeoutMs: number

    constructor(baseUrl: string, requestTimeoutMs: number) {
        this.baseUrl = baseUrl
        this.requestTimeoutMs = requestTimeoutMs
    }

    pair(payload: PairConsumeRequest): Promise<ScreenliteApiResult<PlayerPairConsumeResponse>> {
        return this.fetchJson<PlayerPairConsumeResponse>('/api/player/pair/consume', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    heartbeat(
        deviceToken: string,
        payload?: PlayerHeartbeatRequest,
    ): Promise<ScreenliteApiResult<PlayerHeartbeatResponse>> {
        return this.fetchJson<PlayerHeartbeatResponse>('/api/player/heartbeat', {
            method: 'POST',
            headers: {
                'X-Device-Token': deviceToken,
            },
            body: JSON.stringify(payload ?? {}),
        })
    }

    getSchedule(
        deviceToken: string,
        screenId?: string,
    ): Promise<ScreenliteApiResult<PlayerScheduleResponse>> {
        const endpoint = this.buildScheduleEndpoint(screenId)

        return this.fetchJson<PlayerScheduleResponse>(endpoint, {
            method: 'GET',
            headers: {
                'X-Device-Token': deviceToken,
            },
        })
    }

    getTemplates(
        deviceToken: string,
        screenId?: string,
    ): Promise<ScreenliteApiResult<PlayerTemplateResponse>> {
        const endpoint = this.buildTemplatesEndpoint(screenId)

        return this.fetchJson<PlayerTemplateResponse>(endpoint, {
            method: 'GET',
            headers: {
                'X-Device-Token': deviceToken,
            },
        })
    }

    getCompiledPlaylist(
        deviceToken: string,
        deviceId: string | undefined,
        screenId: string | undefined,
    ): Promise<ScreenliteApiResult<unknown>> {
        if (!deviceId || !screenId) {
            return Promise.resolve({ ok: false, unauthorized: false, data: null, error: 'Missing deviceId or screenId' })
        }

        const endpoint = `/api/device/${encodeURIComponent(deviceId)}/screen/${encodeURIComponent(screenId)}/playlist`

        return this.fetchJson(endpoint, {
            method: 'GET',
            headers: {
                'X-Device-Token': deviceToken,
            },
        })
    }

    private buildScheduleEndpoint(screenId?: string): string {
        if (!screenId) {
            return '/api/player/schedule'
        }

        const query = new URLSearchParams({ screenId }).toString()
        return `/api/player/schedule?${query}`
    }

    private buildTemplatesEndpoint(screenId?: string): string {
        if (!screenId) {
            return '/api/player/templates'
        }

        const query = new URLSearchParams({ screenId }).toString()
        return `/api/player/templates?${query}`
    }

    private async fetchJson<T>(endpoint: string, init: RequestInit): Promise<ScreenliteApiResult<T>> {
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
}
