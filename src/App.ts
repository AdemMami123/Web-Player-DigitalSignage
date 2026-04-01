import { tickLoop } from './core/tick'
import { configStore } from './store/configStore'
import { cmsService } from './services/cmsService'
import { cacheService } from './services/cacheService'
import { getCMSAdapter } from './utils/getCMSAdapter'
import { Player } from './renderer/Player'
import { ConfigOverlay } from './renderer/ConfigOverlay'
import { PairingTestPanel } from './renderer/PairingTestPanel'
import { PairingSuccessDemoScreen } from './renderer/PairingSuccessDemoScreen'
import { FPSDisplay } from './renderer/FPSDisplay'
import type { Playlist } from './types'

export class App {
    private root: HTMLElement
    private player: Player
    private configOverlay: ConfigOverlay
    private pairingTestPanel: PairingTestPanel
    private pairingSuccessDemoScreen: PairingSuccessDemoScreen
    private fpsDisplay: FPSDisplay
    private statusEl: HTMLDivElement

    private cachedPlaylists: Playlist[] = []
    private isCaching = false
    private currentTimestamp: number
    private lastSecond = -1
    private timestampInterval = 0
    private unsubscribeConnectionStatus: (() => void) | null = null

    constructor(root: HTMLElement) {
        this.root = root
        this.currentTimestamp = Date.now()

        this.player = new Player()
        this.configOverlay = new ConfigOverlay()
        this.pairingTestPanel = new PairingTestPanel()
        this.pairingSuccessDemoScreen = new PairingSuccessDemoScreen()
        this.fpsDisplay = new FPSDisplay()
        this.statusEl = this.buildStatusEl()
    }

    async init(): Promise<void> {
        await configStore.loadConfig()
        await this.clearLegacyPlaybackCacheIfScreenlite()

        // Mount UI
        this.configOverlay.mount(this.root)
        this.pairingTestPanel.mount(this.root)
        this.pairingSuccessDemoScreen.mount(this.root)
        this.fpsDisplay.mount(this.root)

        // Wire cache service
        cacheService.onStateChange = ({ cachedPlaylists, isCaching }) => {
            this.cachedPlaylists = cachedPlaylists
            this.isCaching = isCaching
            this.render()
        }

        // Initialize from cache service's pre-loaded state
        this.cachedPlaylists = cacheService.cachedPlaylists
        this.isCaching = cacheService.isCaching

        // Wire CMS service
        cmsService.onUpdate = (playlists) => {
            cacheService.processPlaylists(playlists)
        }
        this.unsubscribeConnectionStatus = cmsService.subscribeConnectionStatus(() => {
            this.render()
        })

        // Connect to CMS
        this.connectCMS()

        // React to config changes (adapter settings change → reconnect)
        let prevAdapter = configStore.state.config.cmsAdapter
        let prevUrl = configStore.state.config.cmsAdapterUrl
        let prevBackendBaseUrl = configStore.state.config.backendBaseUrl
        let prevDefaultPairingCode = configStore.state.config.defaultPairingCode

        configStore.subscribe(state => {
            if (
                state.config.cmsAdapter !== prevAdapter ||
                state.config.cmsAdapterUrl !== prevUrl ||
                state.config.backendBaseUrl !== prevBackendBaseUrl ||
                state.config.defaultPairingCode !== prevDefaultPairingCode
            ) {
                prevAdapter = state.config.cmsAdapter
                prevUrl = state.config.cmsAdapterUrl
                prevBackendBaseUrl = state.config.backendBaseUrl
                prevDefaultPairingCode = state.config.defaultPairingCode
                this.connectCMS()
            }
        })

        // Timestamp loop — checks every 10ms, updates only when second changes
        this.timestampInterval = window.setInterval(() => {
            this.updateTimestamp()
        }, 10)

        // Start rAF tick loop (used by FPSDisplay and anything else that needs 60fps)
        tickLoop.start()

        this.render()
    }

    private connectCMS(): void {
        const config = configStore.state.config
        const adapter = getCMSAdapter(config.cmsAdapter, config.cmsAdapterUrl, config)
        cmsService.connect(adapter)
    }

    private async clearLegacyPlaybackCacheIfScreenlite(): Promise<void> {
        if (configStore.state.config.cmsAdapter !== 'Screenlite') {
            return
        }

        localStorage.removeItem('cached_playlists')

        if ('caches' in window) {
            await caches.delete('media-cache-v1')
        }
    }

    private updateTimestamp(): void {
        const now = Date.now()
        const date = new Date(now)
        const currentSecond = date.getSeconds()

        if (currentSecond !== this.lastSecond) {
            this.lastSecond = currentSecond
            const timezone = configStore.state.config.timezone
            const offset = getTimezoneOffset(date, timezone)
            this.currentTimestamp = now + offset
            this.render()
        }
    }

    private render(): void {
        if (this.shouldBlockPlaybackForPairing()) {
            this.pairingSuccessDemoScreen.hide()
            this.showStatus('Waiting for pairing...')
            return
        }

        if (this.shouldShowPairingSuccessDemo()) {
            this.player.el.remove()
            this.statusEl.remove()
            this.pairingSuccessDemoScreen.updateTime(this.currentTimestamp)
            this.pairingSuccessDemoScreen.show()
            return
        }

        this.pairingSuccessDemoScreen.hide()

        if (this.cachedPlaylists.length > 0) {
            this.showPlayer()
            this.player.update(this.cachedPlaylists, this.currentTimestamp)
        } else if (this.isCaching) {
            this.showStatus('Loading...')
        } else {
            this.showStatus('Schedule is empty')
        }
    }

    private shouldBlockPlaybackForPairing(): boolean {
        const config = configStore.state.config
        if (config.cmsAdapter !== 'Screenlite') {
            return false
        }

        return cmsService.getConnectionStatus() !== 'connected'
    }

    private shouldShowPairingSuccessDemo(): boolean {
        const config = configStore.state.config
        if (config.cmsAdapter !== 'Screenlite') {
            return false
        }

        const isConnected = cmsService.getConnectionStatus() === 'connected'
        return isConnected && !this.isCaching && this.cachedPlaylists.length === 0
    }

    private showPlayer(): void {
        this.statusEl.remove()
        if (!this.player.el.parentElement) {
            this.root.appendChild(this.player.el)
        }
    }

    private showStatus(message: string): void {
        this.player.el.remove()
        this.statusEl.querySelector('h1')!.textContent = message
        if (!this.statusEl.parentElement) {
            this.root.appendChild(this.statusEl)
        }
    }

    private buildStatusEl(): HTMLDivElement {
        const wrap = document.createElement('div')
        Object.assign(wrap.style, {
            background: 'black',
            width: '100vw',
            height: '100vh',
            overflow: 'hidden',
        })
        const h1 = document.createElement('h1')
        Object.assign(h1.style, { color: 'white', fontSize: '1.875rem', fontWeight: 'bold' })
        wrap.appendChild(h1)
        return wrap
    }

    destroy(): void {
        clearInterval(this.timestampInterval)
        tickLoop.stop()
        cmsService.disconnect()
        this.unsubscribeConnectionStatus?.()
        this.configOverlay.destroy()
        this.pairingTestPanel.destroy()
        this.pairingSuccessDemoScreen.destroy()
    }
}

function getTimezoneOffset(date: Date, tz: string): number {
    try {
        const localeString = date.toLocaleString('en-US', { timeZone: tz })
        const localDate = new Date(localeString)
        return localDate.getTime() - date.getTime()
    } catch {
        return 0
    }
}
