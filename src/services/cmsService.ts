import type { CMSAdapter, PairableCMSAdapter, Playlist } from '../types'

export class CMSService {
    private adapter: CMSAdapter | null = null
    onUpdate: ((playlists: Playlist[] | null) => void) | null = null
    private connectionStatusSubscribers = new Set<(status: string) => void>()
    private currentConnectionStatus = 'disconnected'

    connect(adapter: CMSAdapter): void {
        this.disconnect()
        this.adapter = adapter
        this.adapter.onUpdate((data: unknown) => {
            const playlists = Array.isArray(data) ? (data as Playlist[]) : null
            this.onUpdate?.(playlists)
        })

        const pairable = this.getPairableAdapter()
        if (pairable) {
            pairable.onConnectionStatusChange(status => {
                this.currentConnectionStatus = status
                this.notifyConnectionStatus(status)
            })
        } else {
            this.currentConnectionStatus = 'connected'
            this.notifyConnectionStatus(this.currentConnectionStatus)
        }

        this.adapter.connect()
    }

    disconnect(): void {
        this.adapter?.disconnect()
        this.adapter = null
        this.currentConnectionStatus = 'disconnected'
        this.notifyConnectionStatus(this.currentConnectionStatus)
    }

    async pair(pairingCode?: string): Promise<boolean> {
        const pairable = this.getPairableAdapter()
        if (!pairable) {
            return false
        }
        return pairable.pair(pairingCode)
    }

    unpair(): void {
        const pairable = this.getPairableAdapter()
        pairable?.unpair()
    }

    getConnectionStatus(): string {
        const pairable = this.getPairableAdapter()
        return pairable?.getConnectionStatus() ?? this.currentConnectionStatus
    }

    subscribeConnectionStatus(callback: (status: string) => void): () => void {
        this.connectionStatusSubscribers.add(callback)
        callback(this.getConnectionStatus())

        return () => {
            this.connectionStatusSubscribers.delete(callback)
        }
    }

    private notifyConnectionStatus(status: string): void {
        for (const subscriber of this.connectionStatusSubscribers) {
            subscriber(status)
        }
    }

    private getPairableAdapter(): PairableCMSAdapter | null {
        if (
            this.adapter &&
            'pair' in this.adapter &&
            'unpair' in this.adapter &&
            'onConnectionStatusChange' in this.adapter &&
            'getConnectionStatus' in this.adapter
        ) {
            return this.adapter as PairableCMSAdapter
        }

        return null
    }
}

export const cmsService = new CMSService()
