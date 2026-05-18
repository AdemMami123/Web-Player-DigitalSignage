import type { MediaItem } from '../types'
import { runtimeClock } from '../services/runtimeClock'
import { getBackgroundImageFitStyle, resolveResponsiveFontSize, resolveResponsiveRect } from '../utils/resolveRect'

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
    private dynamicTextUnsubscribe: (() => void) | null = null
    private tickerAnimation: Animation | null = null
    private lastTextPayload = ''

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
        } else if (item.type === 'template') {
            const container = document.createElement('div')
            container.style.position = 'absolute'
            container.style.top = '0'
            container.style.left = '0'
            container.style.width = '100%'
            container.style.height = '100%'
            container.style.overflow = 'hidden'

            // item.src is expected to be a JSON string with { template_layout: {...} }
            try {
                const parsed = JSON.parse(item.src || '{}') as any
                const layout = parsed?.template_layout ?? parsed?.layout ?? null

                if (layout) {
                    this.renderTemplateLayout(container, layout)
                }
            } catch {
                // ignore parse errors and fallback to empty container
            }

            this.lastTextPayload = item.src
            this.el = container
        } else {
            const textBox = document.createElement('div')

            this.applyTextPayload(textBox, item.src)
            this.el = textBox
        }

        // Use objectFit from item or default to 'cover'
        const objectFit = item.objectFit ?? 'cover'
        Object.assign(this.el.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            objectFit: objectFit,
        })

        this.applyState(item)
    }

    update(item: MediaItem): void {
        const prevHidden = this.hidden

        this.hidden = item.hidden
        this.itemDurationMs = Math.max(0, item.duration)

        if (
            item.type === 'text' &&
            this.el instanceof HTMLDivElement &&
            (item.src !== this.lastTextPayload || (item.hidden !== prevHidden && !item.hidden))
        ) {
            this.applyTextPayload(this.el, item.src)
        }

        if (item.type === 'template' && item.src !== this.lastTextPayload && this.el instanceof HTMLElement) {
            // re-render template content when payload changes
            // recreate inner HTML
            while (this.el.firstChild) this.el.removeChild(this.el.firstChild)
            try {
                const parsed = JSON.parse(item.src || '{}') as any
                const layout = parsed?.template_layout ?? parsed?.layout ?? null

                if (layout) {
                    this.renderTemplateLayout(this.el, layout)
                }
            } catch {
                // ignore
            }

            this.lastTextPayload = item.src
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

    private renderTemplateLayout(container: HTMLElement, layout: any): void {
        const renderSize = this.getRenderSurfaceSize()
        const referenceSize = {
            width: Number(layout?.baseResolution?.width ?? layout?.width ?? renderSize.width),
            height: Number(layout?.baseResolution?.height ?? layout?.height ?? renderSize.height),
        }

        if (typeof layout.background === 'string') {
            container.style.background = String(layout.background)
        }

        if (typeof layout.backgroundColor === 'string') {
            container.style.backgroundColor = String(layout.backgroundColor)
        }

        if (typeof layout.backgroundImageUrl === 'string' && layout.backgroundImageUrl.trim() !== '') {
            const fitStyle = getBackgroundImageFitStyle(layout.backgroundImageFit)

            container.style.backgroundImage = `url(${String(layout.backgroundImageUrl)})`
            container.style.backgroundSize = fitStyle.backgroundSize
            container.style.backgroundPosition = 'center'
            container.style.backgroundRepeat = 'no-repeat'
        } else {
            container.style.backgroundImage = 'none'
        }

        const elements = Array.isArray(layout.elements) ? layout.elements : []

        for (const el of elements) {
            const wrapper = document.createElement('div')
            const rect = resolveResponsiveRect(el, renderSize, referenceSize)

            wrapper.style.position = 'absolute'

            if (rect.x !== null) wrapper.style.left = `${rect.x}px`
            if (rect.y !== null) wrapper.style.top = `${rect.y}px`
            if (rect.width !== null) wrapper.style.width = `${rect.width}px`
            else wrapper.style.width = 'auto'
            if (rect.height !== null) wrapper.style.height = `${rect.height}px`
            else wrapper.style.height = 'auto'

            const type = String(el.type ?? '').toLowerCase()

            if (type === 'image' && typeof el.imageUrl === 'string') {
                const img = document.createElement('img')
                img.src = String(el.imageUrl)
                img.style.width = '100%'
                img.style.height = '100%'
                img.style.objectFit = String(el.objectFit ?? 'cover')
                img.onerror = () => this.reportError('template element image failed to load')
                wrapper.appendChild(img)
            } else {
                const textPayload = JSON.stringify({ text: String(el.text ?? ''), style: el.style ?? {} })
                this.applyTextPayload(wrapper, textPayload, referenceSize, renderSize)
            }

            container.appendChild(wrapper)
        }
    }

    private getRenderSurfaceSize(): { width: number; height: number } {
        const width = window.innerWidth || document.documentElement.clientWidth || window.screen.width || 0
        const height = window.innerHeight || document.documentElement.clientHeight || window.screen.height || 0

        return {
            width: width > 0 ? width : 1920,
            height: height > 0 ? height : 1080,
        }
    }

    private applyTextPayload(el: HTMLDivElement, src: string, referenceSize?: { width: number; height: number }, renderSize?: { width: number; height: number }): void {
        this.cleanupDynamicText()
        this.lastTextPayload = src

        type TextPayload = {
            text?: string
            style?: Record<string, unknown>
            baseResolution?: {
                width?: number
                height?: number
            }
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
        const rawText = String(payload.text ?? '')
        const widgetKind = String(style.widgetKind ?? '').toLowerCase()
        const effectiveRenderSize = renderSize ?? this.getRenderSurfaceSize()
        const effectiveReferenceSize = payload.baseResolution ?? referenceSize
        const fontSize = resolveResponsiveFontSize(style.fontSize ?? 32, effectiveReferenceSize, effectiveRenderSize) ?? '32px'
                const textAlign = typeof style.textAlign === 'string' ? style.textAlign : 'center'
                const fontWeight =
                        typeof style.fontWeight === 'number'
                                ? String(style.fontWeight)
                                : typeof style.fontWeight === 'string'
                                    ? style.fontWeight
                                    : '700'

        el.style.display = 'flex'
        el.style.alignItems = 'center'
                el.style.justifyContent = 'center'
                el.style.padding = '8px'
        el.style.boxSizing = 'border-box'
        el.style.whiteSpace = 'pre-wrap'
                el.style.wordBreak = 'break-word'
                el.style.textAlign = textAlign
                el.style.fontSize = fontSize
                el.style.fontWeight = fontWeight
        el.style.color = typeof style.color === 'string' ? style.color : '#FFFFFF'
        if (typeof style.background === 'string') {
            el.style.background = style.background
        }

        if (widgetKind === 'ticker') {
            this.applyTickerWidget(el, rawText, style)
            return
        }

        if (widgetKind === 'clock' || widgetKind === 'date') {
            this.applyDynamicDateTimeWidget(el, widgetKind, style)
            return
        }

        el.textContent = rawText
    }

    private applyTickerWidget(el: HTMLDivElement, text: string, style: Record<string, unknown>): void {
        const speed = this.readTickerSpeed(style)
        const gapPx = this.readTickerGap(style)
        const durationSeconds = this.resolveTickerDurationSeconds(speed)

        const viewport = document.createElement('div')
        const track = document.createElement('div')
        const itemA = document.createElement('span')
        const itemB = document.createElement('span')
        const itemC = document.createElement('span')

        itemA.textContent = text
        itemB.textContent = text
        itemC.textContent = text
        Object.assign(itemA.style, {
            display: 'inline-block',
            whiteSpace: 'nowrap',
            flexShrink: '0',
        })
        Object.assign(itemB.style, {
            display: 'inline-block',
            whiteSpace: 'nowrap',
            flexShrink: '0',
        })
        Object.assign(itemC.style, {
            display: 'inline-block',
            whiteSpace: 'nowrap',
            flexShrink: '0',
        })

        Object.assign(track.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: `${gapPx}px`,
            paddingLeft: '100%',
            willChange: 'transform',
            whiteSpace: 'nowrap',
        })
        track.appendChild(itemA)
        track.appendChild(itemB)
        track.appendChild(itemC)

        Object.assign(viewport.style, {
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
        })
        viewport.appendChild(track)

        el.textContent = ''
        el.style.display = 'flex'
        el.style.alignItems = 'center'
        el.style.justifyContent = 'flex-start'
        el.style.overflow = 'hidden'
        el.style.whiteSpace = 'nowrap'
        el.style.padding = '8px 0'
        el.style.position = 'relative'
        el.appendChild(viewport)

        this.tickerAnimation = track.animate(
            [
                { transform: 'translateX(0px)' },
                { transform: 'translateX(-66.666%)' },
            ],
            {
                duration: durationSeconds * 1000,
                iterations: Number.POSITIVE_INFINITY,
                easing: 'linear',
            },
        )
    }

    private applyDynamicDateTimeWidget(
        el: HTMLDivElement,
        widgetKind: 'clock' | 'date',
        style: Record<string, unknown>,
    ): void {
        const locale = typeof style.locale === 'string' ? style.locale : undefined
        const format = typeof style.format === 'string' ? style.format : undefined
        const explicitTimeZone = typeof style.timeZone === 'string' ? style.timeZone : undefined
        const timeZone = explicitTimeZone || runtimeClock.getServerTimeZone() || undefined

        const render = () => {
            const now = runtimeClock.getNow()

            el.textContent =
                widgetKind === 'clock'
                    ? this.formatClock(now, locale, format, timeZone)
                    : this.formatDate(now, locale, format, timeZone)
        }

        this.dynamicTextUnsubscribe = runtimeClock.subscribe(render)
        render()
    }

    private formatClock(date: Date, locale?: string, format?: string, timeZone?: string): string {
        if (format === '24h') {
            return new Intl.DateTimeFormat(locale, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone,
            }).format(date)
        }

        return new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone,
        }).format(date)
    }

    private formatDate(date: Date, locale?: string, format?: string, timeZone?: string): string {
        if (format === 'short') {
            return new Intl.DateTimeFormat(locale, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                timeZone,
            }).format(date)
        }

        return new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone,
        }).format(date)
    }

    private readTickerSpeed(style: Record<string, unknown>): number {
        const raw = style.tickerSpeed ?? style.ticker_speed ?? style.speed ?? style.marqueeSpeed

        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return Math.max(10, Math.min(200, raw))
        }
        if (typeof raw === 'string' && raw.trim().length > 0) {
            const parsed = Number(raw)

            if (Number.isFinite(parsed)) {
                return Math.max(10, Math.min(200, parsed))
            }
        }

        return 70
    }

    private resolveTickerDurationSeconds(speed: number): number {
        return Math.max(6, 240 / Math.max(10, Math.min(200, speed)))
    }

    private readTickerGap(style: Record<string, unknown>): number {
        const raw = style.tickerGap ?? style.ticker_gap ?? style.gap

        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return Math.max(8, raw)
        }
        if (typeof raw === 'string' && raw.trim().length > 0) {
            const parsed = Number(raw)

            if (Number.isFinite(parsed)) {
                return Math.max(8, parsed)
            }
        }

        return 48
    }

    private cleanupDynamicText(): void {
        this.tickerAnimation?.cancel()
        this.tickerAnimation = null
        this.dynamicTextUnsubscribe?.()
        this.dynamicTextUnsubscribe = null
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
        this.cleanupDynamicText()
        this.el.remove()
    }
}
