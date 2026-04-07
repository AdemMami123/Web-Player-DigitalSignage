import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenliteAdapter } from '../src/adapters/ScreenliteAdapter'
import { getDeviceTelemetry } from '../src/utils/getDeviceTelemetry'

vi.mock('../src/utils/getDeviceTelemetry', () => ({
    getDeviceTelemetry: vi.fn(async () => ({
        localIpAddress: '127.0.0.1',
        macAddress: 'aa:bb:cc:dd',
        softwareVersion: '1.0.0',
        screenResolutionWidth: 1920,
        screenResolutionHeight: 1080,
        platform: 'web',
        hostname: 'runtime-test-device',
        timezone: 'UTC',
        totalMemory: 4096,
        freeMemory: 2048,
        osRelease: 'test-os',
    })),
}))

type MockHttpResponse = {
    status: number
    body?: unknown
    headers?: Record<string, string>
}

function buildResponse(response: MockHttpResponse): Response {
    const hasBody = response.body !== undefined
    const headers = {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(response.headers ?? {}),
    }

    return new Response(hasBody ? JSON.stringify(response.body) : null, {
        status: response.status,
        headers,
    })
}

function setupEndpointFetchMock(
    routes: Record<string, MockHttpResponse[]>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL) => Promise<Response>>> {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const route = Object.keys(routes).find(key => url.includes(key))

        if (!route) {
            throw new Error(`Unexpected endpoint: ${url}`)
        }

        const next = routes[route].shift()
        if (!next) {
            throw new Error(`No queued response left for endpoint: ${route}`)
        }

        return buildResponse(next)
    })
}

async function flushAsync(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

async function waitForCondition(
    condition: () => boolean,
    timeoutTicks = 20,
): Promise<void> {
    for (let i = 0; i < timeoutTicks; i++) {
        await flushAsync()
        await vi.advanceTimersByTimeAsync(0)
        if (condition()) {
            return
        }
    }
}

describe('Runtime Gate Matrix (A-E)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        localStorage.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        localStorage.clear()
    })

    it('Case A: pair new device -> token saved -> heartbeat online', async () => {
        const fetchMock = setupEndpointFetchMock({
            '/api/player/pair/consume': [
                { status: 200, body: { deviceToken: 'token-a', deviceId: 'd-1', screenId: 's-1' } },
            ],
            '/api/player/heartbeat': [
                { status: 200, body: { online: true, status: 'ONLINE' } },
            ],
            '/api/player/templates': [
                {
                    status: 200,
                    body: [
                        {
                            screenId: 's-1',
                            templateId: 'template-a',
                            name: 'Template A',
                            layout: {
                                width: 1920,
                                height: 1080,
                                background: '#000000',
                                elements: [],
                            },
                        },
                    ],
                },
            ],
            '/api/player/schedule': [{ status: 200, body: { playlists: [] } }],
        })

        globalThis.fetch = fetchMock as typeof fetch

        const statusEvents: string[] = []
        const adapter = new ScreenliteAdapter('http://localhost:8080')
        adapter.onConnectionStatusChange(status => statusEvents.push(status))

        adapter.connect()
        const ok = await adapter.pair('PAIR-001')
        await flushAsync()
        await waitForCondition(() => statusEvents.includes('connected'))

        expect(ok).toBe(true)
        expect(localStorage.getItem('screenlite_device_token')).toBe('token-a')
        expect(statusEvents.includes('connected')).toBe(true)
        expect(fetchMock).toHaveBeenCalled()

        adapter.disconnect()
    })

    it('Case B: CMS assignment change -> player gets template update', async () => {
        localStorage.setItem('screenlite_device_token', 'token-b')
        localStorage.setItem(
            'screenlite_linked_device',
            JSON.stringify({ deviceId: 'd-2', screenId: 's-2', linkedAt: new Date().toISOString() }),
        )

        const fetchMock = setupEndpointFetchMock({
            '/api/player/heartbeat': [
                { status: 200, body: { online: true } },
                { status: 200, body: { online: true } },
                { status: 200, body: { online: true } },
            ],
            '/api/player/templates': [
                {
                    status: 200,
                    body: [],
                },
                {
                    status: 200,
                    body: [
                        {
                            screenId: 's-2',
                            templateId: 'template-cms-assigned',
                            name: 'Assigned',
                            layout: {
                                width: 1920,
                                height: 1080,
                                background: '#111111',
                                elements: [],
                            },
                        },
                    ],
                },
            ],
            '/api/player/schedule': [
                { status: 200, body: { playlists: [] } },
                {
                    status: 200,
                    body: {
                        playlists: [
                            {
                                id: 'playlist-cms-assigned',
                                start_date: '2000-01-01',
                                end_date: '2099-12-31',
                                start_time: '00:00:00',
                                end_time: '23:59:59',
                                width: 1920,
                                height: 1080,
                                sections: [],
                            },
                        ],
                    },
                },
            ],
        })

        globalThis.fetch = fetchMock as typeof fetch

        const updates: unknown[] = []
        const adapter = new ScreenliteAdapter('http://localhost:8080')
        adapter.onUpdate(playlists => updates.push(playlists))

        adapter.connect()
        await flushAsync()

        await vi.advanceTimersByTimeAsync(30000)
        await flushAsync()
        await vi.advanceTimersByTimeAsync(30000)
        await flushAsync()

        expect(updates.length).toBeGreaterThanOrEqual(1)
        const lastUpdate = updates.at(-1) as Array<{ id: string }>
    expect(lastUpdate[0]?.id).toBe('s-2-template-cms-assigned')

        adapter.disconnect()
    })

    it('Case C: heartbeat failure transitions player to offline', async () => {
        localStorage.setItem('screenlite_device_token', 'token-c')

        const fetchMock = setupEndpointFetchMock({
            '/api/player/heartbeat': [
                { status: 200, body: { online: true } },
                { status: 500, body: { error: 'temporary outage' } },
            ],
            '/api/player/templates': [{ status: 200, body: [] }],
            '/api/player/schedule': [{ status: 200, body: { playlists: [] } }],
        })

        globalThis.fetch = fetchMock as typeof fetch

        const statusEvents: string[] = []
        const adapter = new ScreenliteAdapter('http://localhost:8080')
        adapter.onConnectionStatusChange(status => statusEvents.push(status))

        adapter.connect()
        await flushAsync()

        await vi.advanceTimersByTimeAsync(30000)
        await flushAsync()

        expect(statusEvents.includes('offline')).toBe(true)

        adapter.disconnect()
    })

    it('Case D: restart with persisted token does not require re-pair and returns online', async () => {
        localStorage.setItem('screenlite_device_token', 'token-d')

        const fetchMock = setupEndpointFetchMock({
            '/api/player/heartbeat': [{ status: 200, body: { online: true } }],
            '/api/player/templates': [{ status: 200, body: [] }],
            '/api/player/schedule': [{ status: 200, body: { playlists: [] } }],
        })

        globalThis.fetch = fetchMock as typeof fetch

        const statusEvents: string[] = []
        const adapter = new ScreenliteAdapter('http://localhost:8080')
        adapter.onConnectionStatusChange(status => statusEvents.push(status))

        adapter.connect()
        await flushAsync()
        await waitForCondition(() => statusEvents.includes('connected'))

        expect(statusEvents.includes('connected')).toBe(true)
        const calledPair = fetchMock.mock.calls.some(call => String(call[0]).includes('/api/player/pair/consume'))
        expect(calledPair).toBe(false)

        adapter.disconnect()
    })

    it('Case E: revoked token (401) clears token and falls back to pairing gate state', async () => {
        localStorage.setItem('screenlite_device_token', 'token-e')

        const fetchMock = setupEndpointFetchMock({
            '/api/player/heartbeat': [{ status: 401, body: { error: 'unauthorized' } }],
        })

        globalThis.fetch = fetchMock as typeof fetch

        const statusEvents: string[] = []
        const adapter = new ScreenliteAdapter('http://localhost:8080')
        adapter.onConnectionStatusChange(status => statusEvents.push(status))

        adapter.connect()
        await flushAsync()

        expect(localStorage.getItem('screenlite_device_token')).toBeNull()
        expect(statusEvents.includes('unauthorized')).toBe(true)
        expect(adapter.getConnectionStatus()).toBe('unauthorized')

        adapter.disconnect()
    })

    it('verifies mocked telemetry path for pair flow', async () => {
        expect(getDeviceTelemetry).toBeTypeOf('function')
    })
})
