import type { MediaItem } from '../types'

const ENABLE_PLAYBACK_TRACKER = import.meta.env.VITE_ENABLE_PLAYBACK_TRACKER === 'true'

type MediaErrorHandler = (itemId: string, error: string) => void

export class MediaItemRenderer {
    el: HTMLElement
    private wasVisible = false
    private visibleTimestamp: string | null = null
    private hidden: boolean
    private itemId: string
    private itemDurationMs: number
    private hasReportedError = false
    private capTimeoutId: ReturnType<typeof setTimeout> | null = null
    private onMediaError: MediaErrorHandler

    constructor(item: MediaItem, onMediaError?: MediaErrorHandler) {
        this.hidden = item.hidden
        this.itemId = item.id
        this.itemDurationMs = Math.max(0, item.duration)
        this.onMediaError = onMediaError ?? (() => {})

        if (item.type === 'image') {
            const img = document.createElement('img')
            img.onerror = () => {
                this.reportError('image failed to load')
            }
            img.src = item.src
            this.el = img
        } else if (item.type === 'video') {
            const video = document.createElement('video')
            video.loop = false
            video.muted = true
            video.playsInline = true
            video.onerror = () => {
                this.reportError('video playback error')
            }
            const source = document.createElement('source')
            source.src = item.src
            source.type = 'video/mp4'
            source.onerror = () => {
                this.reportError('video source failed to load')
            }
            video.appendChild(source)
            this.el = video
        } else {
            const textBox = document.createElement('div')
            this.applyTextPayload(textBox, item.src)
            this.el = textBox
        }

        Object.assign(this.el.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
        })

        this.applyState(item)
    }

    update(item: MediaItem): void {
        const prevHidden = this.hidden
        this.hidden = item.hidden
        this.itemDurationMs = Math.max(0, item.duration)

        if (item.type === 'text' && this.el instanceof HTMLDivElement) {
            this.applyTextPayload(this.el, item.src)
        }

        this.applyState(item)

        if (item.type === 'video') {
            const video = this.el as HTMLVideoElement
            if (item.hidden && !prevHidden) {
                this.clearCapTimer()
                video.pause()
                video.currentTime = 0
            } else if (!item.hidden && prevHidden) {
                video.currentTime = 0
                this.scheduleVideoCap(video)
                video.play().catch(() => {})
            } else if (!item.hidden) {
                this.scheduleVideoCap(video)
            }
        }
    }

    private scheduleVideoCap(video: HTMLVideoElement): void {
        this.clearCapTimer()

        if (this.itemDurationMs <= 0) {
            return
        }

        this.capTimeoutId = setTimeout(() => {
            if (this.hidden) {
                return
            }

            if (!video.paused) {
                video.pause()
            }
        }, this.itemDurationMs)
    }

    private clearCapTimer(): void {
        if (this.capTimeoutId !== null) {
            clearTimeout(this.capTimeoutId)
            this.capTimeoutId = null
        }
    }

    private reportError(error: string): void {
        if (this.hasReportedError) {
            return
        }

        this.hasReportedError = true
        this.onMediaError(this.itemId, error)
    }

    private applyTextPayload(el: HTMLDivElement, src: string): void {
        type TextPayload = {
            text?: string
            style?: Record<string, unknown>
        }

        let payload: TextPayload = { text: src }

        try {
            const parsed = JSON.parse(src) as TextPayload
            if (parsed && typeof parsed === 'object') {
                payload = parsed
            }
        } catch {
            payload = { text: src }
        }

        const style = payload.style ?? {}
        el.textContent = String(payload.text ?? '')
        el.style.display = 'flex'
        el.style.alignItems = 'center'
        el.style.justifyContent = 'center'
        el.style.padding = '8px'
        el.style.boxSizing = 'border-box'
        el.style.whiteSpace = 'pre-wrap'
        el.style.wordBreak = 'break-word'
        el.style.textAlign = typeof style.textAlign === 'string' ? style.textAlign : 'center'
        el.style.fontSize = typeof style.fontSize === 'string' ? style.fontSize : '32px'
        el.style.fontWeight = typeof style.fontWeight === 'string' ? style.fontWeight : '700'
        el.style.color = typeof style.color === 'string' ? style.color : '#FFFFFF'
        if (typeof style.background === 'string') {
            el.style.background = style.background
        }
    }

    private applyState(item: MediaItem): void {
        this.el.style.zIndex = item.hidden ? '0' : '1'
        this.el.style.opacity = item.hidden ? '0' : '1'
        this.trackPlayback(item.id, item.hidden)
    }

    private trackPlayback(id: string, hidden: boolean): void {
        if (!ENABLE_PLAYBACK_TRACKER) return

        if (!hidden && !this.wasVisible) {
            this.wasVisible = true
            this.visibleTimestamp = new Date().toISOString()
        } else if (hidden && this.wasVisible) {
            console.log('========================================')
            console.log('Media Item Playback Tracker')
            console.log('----------------------------------------')
            console.log(`Media item ID: "${id}"`)
            console.log(`Visible from: ${this.visibleTimestamp}`)
            console.log(`Hidden at: ${new Date().toISOString()}`)
            console.log('========================================')
            this.wasVisible = false
            this.visibleTimestamp = null
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.el)
    }

    unmount(): void {
        this.clearCapTimer()
        this.el.remove()
    }
}
