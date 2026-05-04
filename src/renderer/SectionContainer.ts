import type { Section, MediaItem } from '../types'
import { calculateMediaSequenceState } from '../utils/calculateCurrentMediaState'
import { updateMediaItemsState } from '../utils/updateMediaItemsState'
import { MediaItemRenderer } from './MediaItemRenderer'
import { resolveRect } from '../utils/resolveRect'

export class SectionContainer {
    el: HTMLDivElement
    private renderers = new Map<string, MediaItemRenderer>()
    private mediaItems: MediaItem[] = []
    private totalDuration = 0
    private lastItemsSignature = ''
    private failedItemIds = new Set<string>()

    constructor() {
        this.el = document.createElement('div')
        this.el.style.position = 'fixed'
        this.el.style.overflow = 'hidden'
    }

    update(section: Section, layoutWidth: number, layoutHeight: number, viewportWidth: number, viewportHeight: number, elapsedSinceStart: number): void {
        // Use resolveRect to compute pixel coordinates from percentage or absolute values
        const rect = resolveRect(
            {
                x: section.position.x,
                y: section.position.y,
                width: section.position.width,
                height: section.position.height,
                xPct: section.position.xPct,
                yPct: section.position.yPct,
                widthPct: section.position.widthPct,
                heightPct: section.position.heightPct,
            },
            layoutWidth,
            layoutHeight,
            viewportWidth,
            viewportHeight,
        )

        this.el.style.left = `${rect.x}px`
        this.el.style.top = `${rect.y}px`
        this.el.style.width = `${rect.width}px`
        this.el.style.height = `${rect.height}px`
        this.el.style.zIndex = String(section.position.z_index)

        this.syncItems(section)

        const sequenceState = calculateMediaSequenceState(this.mediaItems, elapsedSinceStart, this.totalDuration)
        const timelineItems = updateMediaItemsState(this.mediaItems, sequenceState)

        this.mediaItems = this.applyFailureAwareState(timelineItems, sequenceState.currentIndex)

        const activeIds = new Set<string>()

        for (const item of this.mediaItems) {
            activeIds.add(item.id)

            if (!item.preload && item.hidden) {
                if (this.renderers.has(item.id)) {
                    this.renderers.get(item.id)!.unmount()
                    this.renderers.delete(item.id)
                }
                continue
            }

            if (this.renderers.has(item.id)) {
                this.renderers.get(item.id)!.update(item)
            } else {
                const renderer = new MediaItemRenderer(item, (itemId, error) => {
                    this.handleMediaFailure(itemId, error)
                })

                renderer.mount(this.el)
                this.renderers.set(item.id, renderer)
            }
        }

        for (const [id, renderer] of this.renderers) {
            if (!activeIds.has(id)) {
                renderer.unmount()
                this.renderers.delete(id)
            }
        }
    }

    private syncItems(section: Section): void {
        const nextSignature = section.items
            .map(item => `${item.id}|${item.content_type}|${item.content_path}|${item.duration}`)
            .join('||')

        if (nextSignature === this.lastItemsSignature) return
        this.lastItemsSignature = nextSignature
        this.failedItemIds.clear()

        let items: MediaItem[] = section.items.map(item => ({
            id: item.id,
            src: item.content_path,
            type: item.content_type,
            duration: item.duration * 1000,
            hidden: true,
            preload: false,
            objectFit: item.objectFit,
        }))

        if (items.length === 1) {
            items = [...items, { ...items[0], id: `${items[0].id}-copy` }]
        }

        this.totalDuration = items.reduce((sum, item) => sum + item.duration, 0)
        this.mediaItems = items

        for (const renderer of this.renderers.values()) {
            renderer.unmount()
        }
        this.renderers.clear()
    }

    private applyFailureAwareState(items: MediaItem[], currentIndex: number): MediaItem[] {
        if (items.length === 0 || this.failedItemIds.size === 0) {
            return items
        }

        const failedIndexes = new Set<number>()

        for (let i = 0; i < items.length; i++) {
            if (this.failedItemIds.has(items[i].id)) {
                failedIndexes.add(i)
            }
        }

        if (failedIndexes.size === 0) {
            return items
        }

        const currentPlayable = this.findNextPlayableIndex(items, currentIndex, failedIndexes)

        if (currentPlayable === null) {
            return items.map(item => ({
                ...item,
                hidden: true,
                preload: false,
            }))
        }

        const preloadPlayable = this.findNextPlayableIndex(items, currentPlayable + 1, failedIndexes)

        return items.map((item, index) => ({
            ...item,
            hidden: index !== currentPlayable,
            preload: preloadPlayable !== null && index === preloadPlayable,
        }))
    }

    private findNextPlayableIndex(
        items: MediaItem[],
        startIndex: number,
        failedIndexes: Set<number>,
    ): number | null {
        if (items.length === 0) {
            return null
        }

        const normalizedStart = ((startIndex % items.length) + items.length) % items.length

        for (let offset = 0; offset < items.length; offset++) {
            const idx = (normalizedStart + offset) % items.length

            if (!failedIndexes.has(idx)) {
                return idx
            }
        }

        return null
    }

    private handleMediaFailure(itemId: string, error: string): void {
        if (this.failedItemIds.has(itemId)) {
            return
        }

        this.failedItemIds.add(itemId)
        console.error('SectionContainer: media item failed, skipping item', { itemId, error })

        if (this.renderers.has(itemId)) {
            this.renderers.get(itemId)!.unmount()
            this.renderers.delete(itemId)
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.el)
    }

    unmount(): void {
        for (const renderer of this.renderers.values()) {
            renderer.unmount()
        }
        this.renderers.clear()
        this.el.remove()
    }
}
