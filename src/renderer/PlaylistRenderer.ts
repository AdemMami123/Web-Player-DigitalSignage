import type { Playlist } from '../types'
import { SectionContainer } from './SectionContainer'
import { resolveBackgroundColorWithFallback, getBackgroundImageFitStyle } from '../utils/resolveRect'

export class PlaylistRenderer {
    el: HTMLDivElement
    private sections = new Map<string, SectionContainer>()
    private canvas: HTMLDivElement

    constructor() {
        this.el = document.createElement('div')
        this.canvas = document.createElement('div')
        Object.assign(this.canvas.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            overflow: 'hidden',
        })
        this.el.appendChild(this.canvas)
    }

    update(playlist: Playlist, elapsedSinceStart: number, viewportWidth: number, viewportHeight: number): void {
        // Resolve background color with fallback
        const bgColor = resolveBackgroundColorWithFallback(
            playlist.backgroundColor,
            playlist.background,
        )
        this.canvas.style.background = bgColor

        // Handle background image if present
        if (playlist.backgroundImageUrl) {
            const fitStyle = getBackgroundImageFitStyle(playlist.backgroundImageFit)
            this.canvas.style.backgroundImage = `url('${playlist.backgroundImageUrl}')`
            this.canvas.style.backgroundSize = fitStyle.backgroundSize
            this.canvas.style.backgroundPosition = 'center'
            this.canvas.style.backgroundRepeat = 'no-repeat'
        } else {
            this.canvas.style.backgroundImage = 'none'
        }

        const ids = new Set<string>()
        for (const section of playlist.sections) {
            ids.add(section.id)
            if (!this.sections.has(section.id)) {
                const container = new SectionContainer()
                container.mount(this.canvas)
                this.sections.set(section.id, container)
            }
            this.sections.get(section.id)!.update(section, playlist.width, playlist.height, viewportWidth, viewportHeight, elapsedSinceStart)
        }

        for (const [id, container] of this.sections) {
            if (!ids.has(id)) {
                container.unmount()
                this.sections.delete(id)
            }
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.el)
    }

    unmount(): void {
        for (const container of this.sections.values()) {
            container.unmount()
        }
        this.sections.clear()
        this.el.remove()
    }
}
