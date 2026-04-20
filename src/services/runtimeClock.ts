type RuntimeClockListener = () => void

class RuntimeClockService {
    private offsetMs = 0
    private tickMs = 1000
    private serverTimeZone: string | null = null
    private intervalId: ReturnType<typeof setInterval> | null = null
    private listeners = new Set<RuntimeClockListener>()

    sync(serverEpochMs?: number, recommendedClockTickMs?: number, serverTimeZone?: string): void {
        if (Number.isFinite(serverEpochMs)) {
            this.offsetMs = Number(serverEpochMs) - Date.now()
        }

        if (typeof serverTimeZone === 'string' && serverTimeZone.trim().length > 0) {
            this.serverTimeZone = serverTimeZone.trim()
        }

        if (Number.isFinite(recommendedClockTickMs)) {
            const nextTickMs = Math.max(100, Number(recommendedClockTickMs))

            if (nextTickMs !== this.tickMs) {
                this.tickMs = nextTickMs
                this.restartInterval()
            }
        }

        this.emit()
    }

    getNow(): Date {
        return new Date(Date.now() + this.offsetMs)
    }

    getServerTimeZone(): string | null {
        return this.serverTimeZone
    }

    subscribe(listener: RuntimeClockListener): () => void {
        this.listeners.add(listener)
        this.ensureInterval()

        return () => {
            this.listeners.delete(listener)
            if (this.listeners.size === 0) {
                this.stopInterval()
            }
        }
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener()
        }
    }

    private ensureInterval(): void {
        if (this.intervalId !== null || this.listeners.size === 0) {
            return
        }

        this.intervalId = setInterval(() => {
            this.emit()
        }, this.tickMs)
    }

    private restartInterval(): void {
        this.stopInterval()
        this.ensureInterval()
    }

    private stopInterval(): void {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }
}

export const runtimeClock = new RuntimeClockService()